import { SourceDocument } from '../../../documents/document.model';
import { Connector, SyncResult } from '../connector.interface';

export interface GitLabConfig {
  /** Personal Access Token (read_api scope). Optional: required for private or
   *  internal projects; public projects work unauthenticated. Secret manager. */
  token?: string;
  /** Projects to index, as full paths ("group/subgroup/project"). */
  projects: string[];
  /** Base URL — default gitlab.com; set for self-managed GitLab. */
  baseUrl?: string;
  /** Override the set of documentation file extensions to ingest. */
  docExtensions?: string[];
}

type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

const DEFAULT_DOC_EXTENSIONS = ['md', 'markdown', 'mdx', 'rst', 'txt', 'adoc'];
const DOC_BASENAMES = ['README', 'CHANGELOG', 'CONTRIBUTING', 'AUTHORS', 'NOTICE'];
const RECENT_COMMITS = 10;
const TREE_PAGE_SIZE = 100;

/**
 * GitLab connector (plan §6.1 — the source the plan originally named). Ingests
 * the same two document kinds as the GitHub sibling: documentation files from
 * the default branch (Markdown loader + heading-aware chunker, deep links via
 * `/-/blob/<branch>/<path>`) and a synthesized project-overview document
 * (description, language breakdown, topics, recent commit activity).
 *
 * ACL (Phase 2 NATIVE — the first connector written against the hardened
 * model). GitLab visibility maps directly onto the principal model:
 *   public   → `public`            (anyone, even anonymous)
 *   internal → `all-users`         (any AUTHENTICATED caller — the reserved
 *                                    pseudo-principal exists for exactly this)
 *   private  → `gitlab-project:<path>` (source-native; reaches callers only
 *                                    through the principal_mappings table)
 *   anything else → aclStatus 'failed' → QUARANTINE. An unknown visibility
 *   value (new GitLab feature, API drift) must never default toward open.
 *
 * Deletions are reconciled by the full-crawl sweep in IngestionService;
 * deltaSync skips projects untouched since the cursor (last_activity_at).
 */
export class GitLabConnector implements Connector {
  readonly sourceSystem = 'gitlab';
  private readonly baseUrl: string;
  private readonly docExtensions: Set<string>;

  constructor(
    private readonly config: GitLabConfig,
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
  ) {
    if (!config.projects?.length) {
      throw new Error('GitLabConnector requires at least one project path (group/project)');
    }
    // `||` not `??`: dotenv turns a blank `GITLAB_BASE_URL=` line into an
    // EMPTY STRING, which must still mean "default to gitlab.com".
    this.baseUrl = (config.baseUrl?.trim() || 'https://gitlab.com').replace(/\/$/, '');
    this.docExtensions = new Set(config.docExtensions ?? DEFAULT_DOC_EXTENSIONS);
  }

  async initialCrawl(): Promise<SourceDocument[]> {
    const docs: SourceDocument[] = [];
    for (const path of this.config.projects) {
      docs.push(...(await this.crawlProject(path)));
    }
    return docs;
  }

  async deltaSync(cursor: string | null): Promise<SyncResult> {
    const since = cursor ? Date.parse(cursor) : 0;
    const docs: SourceDocument[] = [];
    let newest = since;
    for (const path of this.config.projects) {
      const project = await this.getProject(path);
      const activityMs = project.last_activity_at ? Date.parse(project.last_activity_at) : 0;
      newest = Math.max(newest, activityMs);
      // INCLUSIVE bound (>=): last_activity_at has coarse granularity and
      // GitLab throttles its updates, so activity landing in the same instant
      // the cursor recorded would be skipped forever under a strict '>'.
      // Re-crawling an unchanged project is cheap — the content-hash skip in
      // ingestion absorbs it (same trade as the Confluence connector).
      if (activityMs >= since) docs.push(...(await this.crawlProject(path, project)));
    }
    // Deletions are reconciled by initialCrawl's sweep (same as GitHub).
    return { documents: docs, deletedExternalIds: [], cursor: new Date(newest).toISOString() };
  }

  /** THROWS on any failure (including unknown visibility) — callers quarantine. */
  async resolvePermissions(externalId: string): Promise<string[]> {
    const path = externalId.split(':')[0]; // "group/project:file/path" → "group/project"
    const project = await this.getProject(path);
    const acl = this.principalsFor(project);
    if (acl === null) {
      throw new Error(
        `GitLab project ${path} has unknown visibility "${project.visibility}" — refusing to resolve`,
      );
    }
    return acl;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async crawlProject(path: string, prefetched?: Project): Promise<SourceDocument[]> {
    const project = prefetched ?? (await this.getProject(path));
    const apiId = encodeURIComponent(project.path_with_namespace);
    // null default_branch = EMPTY repository (no commits). Never guess a ref —
    // a fabricated 'main' just 404s on the tree call and aborts the whole
    // crawl. Emit the overview only.
    const branch = project.default_branch;

    // Fail-closed: an unrecognized visibility quarantines every document of
    // this project (content stored, zero principals) instead of guessing.
    const resolved = this.principalsFor(project);
    const acl = resolved ?? [];
    const aclStatus: SourceDocument['aclStatus'] = resolved === null ? 'failed' : 'resolved';

    const [languages, commits] = branch
      ? await Promise.all([
          this.getJson<Record<string, number>>(`/api/v4/projects/${apiId}/languages`),
          this.getJson<GitLabCommit[]>(
            `/api/v4/projects/${apiId}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=${RECENT_COMMITS}`,
          ),
        ])
      : [{} as Record<string, number>, [] as GitLabCommit[]];

    const docs: SourceDocument[] = [
      this.buildOverview(project, languages, commits, acl, aclStatus),
    ];
    if (!branch) return docs;

    for await (const entry of this.treeEntries(apiId, branch)) {
      if (entry.type !== 'blob' || !entry.path || !this.isDocPath(entry.path)) continue;
      const body = await this.getRaw(
        `/api/v4/projects/${apiId}/repository/files/${encodeURIComponent(entry.path)}/raw?ref=${encodeURIComponent(branch)}`,
      );
      // An EMPTIED file is still emitted: the ingestion pipeline's leak guard
      // needs to see it to delete the previous version's chunks and rewrite
      // the ACL — silently dropping it would leave the old content live under
      // the old, possibly broader ACL (stale-allow).
      docs.push({
        sourceSystem: this.sourceSystem,
        externalId: `${project.path_with_namespace}:${entry.path}`,
        sourceUrl: `${project.web_url}/-/blob/${branch}/${entry.path}`,
        title: entry.path,
        breadcrumb: project.path_with_namespace,
        contentType: this.contentTypeFor(entry.path),
        aclPrincipals: acl,
        aclStatus,
        body,
        sourceUpdatedAt: project.last_activity_at, // per-file commit dates: later refinement
      });
    }

    return docs;
  }

  /** Paginate the repository tree (GitLab caps per_page at 100). */
  private async *treeEntries(apiId: string, branch: string): AsyncGenerator<TreeEntry> {
    let page = 1;
    for (;;) {
      const entries = await this.getJson<TreeEntry[]>(
        `/api/v4/projects/${apiId}/repository/tree?recursive=true&ref=${encodeURIComponent(branch)}` +
          `&per_page=${TREE_PAGE_SIZE}&page=${page}`,
      );
      for (const e of entries) yield e;
      if (entries.length < TREE_PAGE_SIZE) break;
      page++;
    }
  }

  private buildOverview(
    project: Project,
    languages: Record<string, number>,
    commits: GitLabCommit[],
    acl: string[],
    aclStatus: SourceDocument['aclStatus'],
  ): SourceDocument {
    // GitLab /languages already returns percentages.
    const langLine = Object.entries(languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([lang, pct]) => `${lang} ${Math.round(pct)}%`)
      .join(', ');

    const commitLines = commits.slice(0, RECENT_COMMITS).map((c) => {
      const date = (c.committed_date ?? '').slice(0, 10);
      const who = c.author_name ?? 'unknown';
      const msg = (c.title ?? c.message ?? '').split('\n')[0];
      return `- ${date} ${who}: ${msg}`;
    });

    const body = [
      `# ${project.path_with_namespace}`,
      project.description?.trim() ? project.description : '_No description._',
      '',
      '## Overview',
      `- Visibility: ${project.visibility ?? 'unknown'}`,
      langLine ? `- Languages: ${langLine}` : '- Languages: n/a',
      project.topics?.length ? `- Topics: ${project.topics.join(', ')}` : '- Topics: none',
      `- Stars: ${project.star_count ?? 0}, Forks: ${project.forks_count ?? 0}, Open issues: ${project.open_issues_count ?? 0}`,
      '',
      '## Activity',
      `- Created: ${(project.created_at ?? '').slice(0, 10)}`,
      `- Last activity: ${(project.last_activity_at ?? '').slice(0, 10)}`,
      `- Default branch: ${project.default_branch ?? 'n/a'}`,
      '',
      '### Recent commits',
      ...(commitLines.length ? commitLines : ['- (no recent commits)']),
    ].join('\n');

    return {
      sourceSystem: this.sourceSystem,
      externalId: `${project.path_with_namespace}:__overview__`,
      sourceUrl: project.web_url,
      title: `${project.path_with_namespace} (project overview)`,
      breadcrumb: project.path_with_namespace,
      contentType: 'text/markdown',
      aclPrincipals: acl,
      aclStatus,
      body,
      sourceUpdatedAt: project.last_activity_at,
    };
  }

  /**
   * Visibility → principals. Returns null for an UNKNOWN visibility — the
   * caller must quarantine (crawl) or throw (resolvePermissions); it must
   * never guess toward open.
   */
  private principalsFor(project: Project): string[] | null {
    switch (project.visibility) {
      case 'public':
        return ['public'];
      case 'internal':
        return ['all-users'];
      case 'private':
        return [`gitlab-project:${project.path_with_namespace}`];
      default:
        return null;
    }
  }

  private isDocPath(path: string): boolean {
    const base = path.split('/').pop() ?? path;
    const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
    return this.docExtensions.has(ext) || DOC_BASENAMES.includes(base);
  }

  private contentTypeFor(path: string): string {
    const ext = (path.split('.').pop() ?? '').toLowerCase();
    return ['md', 'markdown', 'mdx'].includes(ext) ? 'text/markdown' : 'text/plain';
  }

  private getProject(path: string): Promise<Project> {
    if (!path.includes('/')) {
      throw new Error(`Invalid GitLab project path "${path}" — expected "group/project"`);
    }
    return this.getJson<Project>(`/api/v4/projects/${encodeURIComponent(path)}`);
  }

  private async getJson<T>(path: string): Promise<T> {
    return (await (await this.request(path)).json()) as T;
  }

  private async getRaw(path: string): Promise<string> {
    return (await this.request(path)).text();
  }

  private async request(path: string): Promise<Awaited<ReturnType<FetchFn>>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    // PRIVATE-TOKEN is GitLab's canonical PAT header; omitted → unauthenticated
    // (public projects only).
    if (this.config.token) headers['PRIVATE-TOKEN'] = this.config.token;

    // The per-file raw crawl is one request per doc, so GitLab.com's per-IP
    // rate limits (tightest on the unauthenticated path) can 429 mid-crawl.
    // Honor Retry-After with a bounded retry instead of aborting the ingest.
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, { headers });
      if (res.ok) return res;
      if (res.status === 429 && attempt < 3) {
        const retryAfterS = Number(res.headers?.get?.('retry-after') ?? 1) || 1;
        await sleep(Math.min(retryAfterS, 30) * 1000);
        continue;
      }
      throw new Error(`GitLab GET ${path} failed: ${res.status} ${await res.text()}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── GitLab REST v4 response shapes (only the fields we use) ──────────────────
interface Project {
  id: number;
  path_with_namespace: string;
  default_branch?: string;
  web_url: string;
  visibility?: string; // 'public' | 'internal' | 'private' (validated, not assumed)
  description?: string | null;
  topics?: string[];
  star_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  created_at?: string;
  last_activity_at?: string;
}
interface GitLabCommit {
  title?: string;
  message?: string;
  author_name?: string;
  committed_date?: string;
}
interface TreeEntry {
  path?: string;
  type?: string;
}
