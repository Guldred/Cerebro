import { SourceDocument } from '../../../documents/document.model';
import { Connector, SyncResult } from '../connector.interface';
import {
  AclResolutionError,
  ConfluenceAclResolver,
  ConfluenceRestrictions,
} from './confluence-acl.resolver';

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
  /**
   * Space keys an admin has CERTIFIED as world-readable (P1.1: "non-public
   * unless explicitly certified public"). Unrestricted pages in any other
   * space get the symbolic confluence-space:<KEY> principal, which reaches
   * callers only through principal_mappings.
   */
  certifiedPublicSpaces?: string[];
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
 * ACLs (Phase 2, Plan_Review P1.1): the effective read-set per page is resolved
 * at ingest by ConfluenceAclResolver — space base + page restriction + every
 * restricted ANCESTOR (inheritance), deny-over-allow via the shared IR. A
 * resolution failure quarantines the document (aclStatus='failed', no
 * principals) instead of defaulting to anything. Principals stay source-native
 * (confluence-group:*, confluence-user:*, confluence-space:*) and reach callers
 * only via the principal_mappings table at query time.
 *
 * The ancestor-restriction cache lives for this connector instance — construct
 * a fresh connector per crawl/refresh run (the seed/refresh scripts do).
 */
export class ConfluenceConnector implements Connector {
  readonly sourceSystem = 'confluence';
  private readonly auth: string;
  private readonly pageSize: number;
  private readonly aclResolver: ConfluenceAclResolver;

  constructor(
    private readonly config: ConfluenceConfig,
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
  ) {
    if (!config.baseUrl || !config.email || !config.apiToken) {
      throw new Error('ConfluenceConnector requires baseUrl, email and apiToken');
    }
    this.auth = 'Basic ' + Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
    this.pageSize = config.pageSize ?? 50;
    this.aclResolver = new ConfluenceAclResolver(
      (contentId) => this.fetchRestrictions(contentId),
      new Set(config.certifiedPublicSpaces ?? []),
    );
  }

  async initialCrawl(): Promise<SourceDocument[]> {
    const docs: SourceDocument[] = [];
    for (const cql of this.spaceFilters('type=page and status=current')) {
      for await (const page of this.searchPages(cql)) docs.push(await this.toDocument(page));
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
        docs.push(await this.toDocument(page));
        const when = page.version?.when;
        if (when && (!newest || when > newest)) newest = when;
      }
    }
    // CQL never reports deletions — full-crawl reconciliation handles tombstones.
    return { documents: docs, deletedExternalIds: [], cursor: newest };
  }

  /**
   * Effective read-set for one page (ACL refresh / late binding). THROWS
   * AclResolutionError on any failure — the caller quarantines, never defaults.
   */
  async resolvePermissions(externalId: string): Promise<string[]> {
    let page: ConfluencePage;
    try {
      page = (await this.get(
        `/rest/api/content/${encodeURIComponent(externalId)}` +
          `?expand=space,ancestors,restrictions.read.restrictions.user,restrictions.read.restrictions.group`,
      )) as ConfluencePage;
    } catch (err) {
      throw new AclResolutionError(`Failed to fetch page ${externalId}`, err);
    }
    return this.aclResolver.resolve({
      spaceKey: page.space?.key,
      restrictions: page.restrictions,
      ancestorIds: ancestorIdsOf(page),
    });
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

  /** One ancestor's read restrictions (for the resolver's inheritance walk). */
  private async fetchRestrictions(contentId: string): Promise<ConfluenceRestrictions> {
    const page = (await this.get(
      `/rest/api/content/${encodeURIComponent(contentId)}` +
        `?expand=restrictions.read.restrictions.user,restrictions.read.restrictions.group`,
    )) as ConfluencePage;
    return page.restrictions ?? {};
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

  private async toDocument(page: ConfluencePage): Promise<SourceDocument> {
    const webui = page._links?.webui ?? `/pages/${page.id}`;
    const breadcrumbParts = [
      page.space?.name,
      ...(page.ancestors ?? []).map((a) => a.title),
    ].filter((s): s is string => Boolean(s));

    // Fail-closed ACL resolution: an error quarantines THIS document (content
    // kept, zero principals) and never aborts the rest of the crawl.
    let aclPrincipals: string[];
    let aclStatus: SourceDocument['aclStatus'] = 'resolved';
    try {
      // Only pages have the restriction model this resolver implements; any
      // other content type (attachment, blogpost, …) that slips through the
      // CQL must quarantine, not inherit page semantics.
      if (page.type && page.type !== 'page') {
        throw new AclResolutionError(
          `content ${page.id} has type "${page.type}" — no object-level ACL resolver for it yet`,
        );
      }
      aclPrincipals = await this.aclResolver.resolve({
        spaceKey: page.space?.key,
        restrictions: page.restrictions,
        ancestorIds: ancestorIdsOf(page),
      });
    } catch (err) {
      if (!(err instanceof AclResolutionError)) throw err;
      aclPrincipals = [];
      aclStatus = 'failed';
    }

    return {
      sourceSystem: this.sourceSystem,
      externalId: String(page.id),
      sourceUrl: `${this.config.baseUrl.replace(/\/$/, '')}${webui}`,
      title: page.title ?? String(page.id),
      breadcrumb: breadcrumbParts.join(' > '),
      author: page.history?.createdBy?.displayName,
      contentType: 'text/html',
      aclPrincipals,
      aclStatus,
      body: page.body?.storage?.value ?? '',
      sourceCreatedAt: page.history?.createdDate,
      sourceUpdatedAt: page.version?.when,
    };
  }
}

/** Convert an ISO timestamp to the CQL datetime format: "yyyy-MM-dd HH:mm". */
function toCql(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Ancestor ids for the inheritance walk. An ancestor entry WITHOUT a usable id
 * is an unresolvable permission layer: silently dropping it would skip a
 * potentially restricted parent and over-grant (fail-open) — so it throws
 * AclResolutionError and the document quarantines instead (P1.1).
 */
function ancestorIdsOf(page: ConfluencePage): string[] {
  return (page.ancestors ?? []).map((a) => {
    const id = a.id === undefined || a.id === null ? '' : String(a.id);
    if (!id || id === 'undefined' || id === 'null') {
      throw new AclResolutionError(
        `page ${page.id}: ancestor entry without a usable id — inheritance cannot be resolved`,
      );
    }
    return id;
  });
}

// ── Confluence REST response shapes (only the fields we use) ─────────────────
interface ConfluenceSearchResult {
  results?: ConfluencePage[];
}
interface ConfluencePage {
  id: string | number;
  type?: string;
  title?: string;
  body?: { storage?: { value?: string } };
  version?: { when?: string; number?: number };
  space?: { key?: string; name?: string };
  ancestors?: { id?: string | number; title?: string }[];
  history?: { createdDate?: string; createdBy?: { displayName?: string } };
  restrictions?: ConfluenceRestrictions;
  _links?: { webui?: string };
}
