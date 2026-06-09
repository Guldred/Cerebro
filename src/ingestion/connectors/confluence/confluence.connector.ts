import { SourceDocument } from '../../../documents/document.model';
import { Connector, SyncResult } from '../connector.interface';

export interface ConfluenceConfig {
  /** e.g. https://your-domain.atlassian.net/wiki  (Confluence Cloud) */
  baseUrl: string;
  /** Atlassian account email for Basic auth (Cloud). */
  email: string;
  /** API token — store in a secret manager, never in code (§7). */
  apiToken: string;
  /** Optional: limit the crawl to specific space keys. */
  spaceKeys?: string[];
  /** Page size for REST pagination. */
  pageSize?: number;
}

/** Minimal fetch surface so tests can inject a mock. */
type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

/**
 * Confluence **Cloud** connector (plan §6.1). Targets REST `/wiki/rest/api`,
 * CQL for deltas, and Basic auth (email + API token). Data Center uses a
 * different base path + PAT auth — keep that behind a sibling connector.
 *
 * Storage-format HTML is normalized by the HtmlLoader downstream. Deletions are
 * NOT reported by CQL `lastModified`, so they're reconciled by the full-crawl
 * sweep in IngestionService.runInitialCrawl (deltaSync returns no tombstones).
 *
 * SCOPE NOTE (critique P1): `resolvePermissions` extracts page-level read
 * restrictions into namespaced principals. Full deny/inheritance resolution and
 * mapping into the Entra namespace is Phase 2 — until then, principals are
 * source-native and a query-time principal-mapping layer must translate them.
 */
export class ConfluenceConnector implements Connector {
  readonly sourceSystem = 'confluence';
  private readonly auth: string;
  private readonly pageSize: number;

  constructor(
    private readonly config: ConfluenceConfig,
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
  ) {
    if (!config.baseUrl || !config.email || !config.apiToken) {
      throw new Error('ConfluenceConnector requires baseUrl, email and apiToken');
    }
    this.auth = 'Basic ' + Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
    this.pageSize = config.pageSize ?? 50;
  }

  async initialCrawl(): Promise<SourceDocument[]> {
    const docs: SourceDocument[] = [];
    for (const cql of this.spaceFilters('type=page and status=current')) {
      for await (const page of this.searchPages(cql)) docs.push(this.toDocument(page));
    }
    return docs;
  }

  async deltaSync(cursor: string | null): Promise<SyncResult> {
    const docs: SourceDocument[] = [];
    let newest = cursor;
    const base = cursor
      ? `type=page and status=current and lastModified >= "${toCql(cursor)}"`
      : 'type=page and status=current';
    for (const cql of this.spaceFilters(base)) {
      for await (const page of this.searchPages(`${cql} order by lastModified asc`)) {
        docs.push(this.toDocument(page));
        const when = page.version?.when;
        if (when && (!newest || when > newest)) newest = when;
      }
    }
    // CQL never reports deletions — full-crawl reconciliation handles tombstones.
    return { documents: docs, deletedExternalIds: [], cursor: newest };
  }

  async resolvePermissions(externalId: string): Promise<string[]> {
    const page = (await this.get(
      `/rest/api/content/${encodeURIComponent(externalId)}` +
        `?expand=space,restrictions.read.restrictions.user,restrictions.read.restrictions.group`,
    )) as ConfluencePage;
    return this.principalsFor(page);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private spaceFilters(baseCql: string): string[] {
    if (!this.config.spaceKeys?.length) return [baseCql];
    return this.config.spaceKeys.map((k) => `${baseCql} and space="${k}"`);
  }

  /** Paginate a CQL search, yielding fully-expanded pages. */
  private async *searchPages(cql: string): AsyncGenerator<ConfluencePage> {
    const expand =
      'body.storage,version,space,ancestors,history,' +
      'restrictions.read.restrictions.user,restrictions.read.restrictions.group';
    let start = 0;
    for (;;) {
      const path =
        `/rest/api/content/search?cql=${encodeURIComponent(cql)}` +
        `&expand=${encodeURIComponent(expand)}&limit=${this.pageSize}&start=${start}`;
      const res = (await this.get(path)) as ConfluenceSearchResult;
      const results = res.results ?? [];
      for (const p of results) yield p;
      if (results.length < this.pageSize) break;
      start += this.pageSize;
    }
  }

  private async get(path: string): Promise<unknown> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}${path}`;
    const res = await this.fetchFn(url, {
      headers: { authorization: this.auth, accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Confluence GET ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  private toDocument(page: ConfluencePage): SourceDocument {
    const webui = page._links?.webui ?? `/pages/${page.id}`;
    const breadcrumbParts = [
      page.space?.name,
      ...(page.ancestors ?? []).map((a) => a.title),
    ].filter((s): s is string => Boolean(s));
    return {
      sourceSystem: this.sourceSystem,
      externalId: String(page.id),
      sourceUrl: `${this.config.baseUrl.replace(/\/$/, '')}${webui}`,
      title: page.title ?? String(page.id),
      breadcrumb: breadcrumbParts.join(' > '),
      author: page.history?.createdBy?.displayName,
      contentType: 'text/html',
      aclPrincipals: this.principalsFor(page),
      body: page.body?.storage?.value ?? '',
      sourceCreatedAt: page.history?.createdDate,
      sourceUpdatedAt: page.version?.when,
    };
  }

  /**
   * Page-level read restrictions → namespaced principals. A page with NO explicit
   * restriction inherits space access, represented as `confluence-space:<KEY>`
   * (resolve to concrete Entra groups in Phase 2).
   */
  private principalsFor(page: ConfluencePage): string[] {
    const read = page.restrictions?.read?.restrictions;
    const groups = (read?.group?.results ?? []).map((g) => `confluence-group:${g.name}`);
    const users = (read?.user?.results ?? []).map((u) => `confluence-user:${u.accountId}`);
    const principals = [...groups, ...users];
    if (principals.length > 0) return principals;
    const spaceKey = page.space?.key;
    return spaceKey ? [`confluence-space:${spaceKey}`] : [];
  }
}

/** Convert an ISO timestamp to the CQL datetime format: "yyyy-MM-dd HH:mm". */
function toCql(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ');
}

// ── Confluence REST response shapes (only the fields we use) ─────────────────
interface ConfluenceSearchResult {
  results?: ConfluencePage[];
}
interface ConfluencePage {
  id: string | number;
  title?: string;
  body?: { storage?: { value?: string } };
  version?: { when?: string; number?: number };
  space?: { key?: string; name?: string };
  ancestors?: { title?: string }[];
  history?: { createdDate?: string; createdBy?: { displayName?: string } };
  restrictions?: {
    read?: {
      restrictions?: {
        user?: { results?: { accountId: string }[] };
        group?: { results?: { name: string }[] };
      };
    };
  };
  _links?: { webui?: string };
}
