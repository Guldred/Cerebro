import { SourceDocument } from '../../../documents/document.model';
import { Connector, SyncResult } from '../connector.interface';

export interface GitHubConfig {
  /** Personal Access Token (read-only). Optional: required for private repos and
   *  higher rate limits; public repos work unauthenticated. Use a secret manager. */
  token?: string;
  /** Repositories to index, as "owner/repo". */
  repos: string[];
  /** API base — default GitHub.com; set for GitHub Enterprise Server. */
  apiUrl?: string;
  /** Override the set of documentation file extensions to ingest. */
  docExtensions?: string[];
}

type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

const DEFAULT_DOC_EXTENSIONS = ['md', 'markdown', 'mdx', 'rst', 'txt', 'adoc'];
// Common extensionless documentation files.
const DOC_BASENAMES = ['README', 'CHANGELOG', 'CONTRIBUTING', 'AUTHORS', 'NOTICE'];
const RECENT_COMMITS = 10;

/**
 * GitHub connector (plan §6.1, sibling of the GitLab connector). Ingests two
 * kinds of documents per repository:
 *
 *  1. Documentation files (README + *.md / other doc formats on the default
 *     branch) — flow through the Markdown loader + heading-aware chunker, with
 *     GitHub deep links (file html_url + heading anchor).
 *  2. A synthesized "repository overview" document — description, language
 *     breakdown, topics, license, and recent commit activity — so the agent can
 *     answer "what is this project / what's it built with / is it still
 *     maintained?" without indexing the code line-by-line.
 *
 * Auth: optional PAT (Bearer) — needed for private repos and higher rate limits;
 * public repos work unauthenticated. ACL: public repo → `public`; private
 * repo → `github-repo:<owner/repo>` (resolve to real users/teams at query time
 * in Phase 2, like the Confluence space principal). Deletions are reconciled by
 * the full-crawl sweep in IngestionService.runInitialCrawl; deltaSync skips repos
 * untouched since the cursor (efficient webhook/compare-based delta is Phase 3).
 */
export class GitHubConnector implements Connector {
  readonly sourceSystem = 'github';
  private readonly apiUrl: string;
  private readonly docExtensions: Set<string>;

  constructor(
    private readonly config: GitHubConfig,
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
  ) {
    if (!config.repos?.length) throw new Error('GitHubConnector requires at least one repo (owner/repo)');
    this.apiUrl = (config.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.docExtensions = new Set(config.docExtensions ?? DEFAULT_DOC_EXTENSIONS);
  }

  async initialCrawl(): Promise<SourceDocument[]> {
    const docs: SourceDocument[] = [];
    for (const slug of this.config.repos) {
      docs.push(...(await this.crawlRepo(slug)));
    }
    return docs;
  }

  async deltaSync(cursor: string | null): Promise<SyncResult> {
    const since = cursor ? Date.parse(cursor) : 0;
    const docs: SourceDocument[] = [];
    let newest = since;
    for (const slug of this.config.repos) {
      const repo = await this.getRepo(slug);
      const pushedMs = repo.pushed_at ? Date.parse(repo.pushed_at) : 0;
      newest = Math.max(newest, pushedMs);
      // Skip repos with no pushes since the last sync (cheap incremental win).
      if (pushedMs > since) docs.push(...(await this.crawlRepo(slug, repo)));
    }
    // Deletions are reconciled by initialCrawl's sweep; webhook/compare delta = Phase 3.
    return { documents: docs, deletedExternalIds: [], cursor: new Date(newest).toISOString() };
  }

  async resolvePermissions(externalId: string): Promise<string[]> {
    const slug = externalId.split(':')[0]; // "owner/repo:path" → "owner/repo"
    return this.principalsFor(await this.getRepo(slug));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async crawlRepo(slug: string, prefetched?: Repo): Promise<SourceDocument[]> {
    const repo = prefetched ?? (await this.getRepo(slug));
    const [owner, name] = slug.split('/');
    const acl = this.principalsFor(repo);

    const [languages, commits] = await Promise.all([
      this.get<Record<string, number>>(`/repos/${owner}/${name}/languages`),
      this.get<Commit[]>(`/repos/${owner}/${name}/commits?sha=${repo.default_branch}&per_page=${RECENT_COMMITS}`),
    ]);

    const docs: SourceDocument[] = [this.buildOverview(repo, languages, commits, acl)];

    const tree = await this.get<{ tree: TreeEntry[]; truncated?: boolean }>(
      `/repos/${owner}/${name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`,
    );
    if (tree.truncated) {
      // eslint-disable-next-line no-console
      console.warn(`[github] tree for ${slug} was truncated — some docs may be missing`);
    }

    for (const entry of tree.tree) {
      if (entry.type !== 'blob' || !entry.path || !this.isDocPath(entry.path)) continue;
      const file = await this.get<ContentFile>(
        `/repos/${owner}/${name}/contents/${encodePath(entry.path)}?ref=${encodeURIComponent(repo.default_branch)}`,
      );
      const body = file.content ? Buffer.from(file.content, 'base64').toString('utf8') : '';
      if (!body.trim()) continue;
      docs.push({
        sourceSystem: this.sourceSystem,
        externalId: `${repo.full_name}:${entry.path}`,
        sourceUrl: file.html_url ?? `${repo.html_url}/blob/${repo.default_branch}/${entry.path}`,
        title: entry.path,
        breadcrumb: repo.full_name,
        contentType: this.contentTypeFor(entry.path),
        aclPrincipals: acl,
        body,
        sourceUpdatedAt: repo.pushed_at, // per-file commit dates are a later refinement
      });
    }

    return docs;
  }

  private buildOverview(
    repo: Repo,
    languages: Record<string, number>,
    commits: Commit[],
    acl: string[],
  ): SourceDocument {
    const total = Object.values(languages).reduce((s, n) => s + n, 0) || 1;
    const langLine = Object.entries(languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([lang, bytes]) => `${lang} ${Math.round((bytes / total) * 100)}%`)
      .join(', ');

    const commitLines = commits.slice(0, RECENT_COMMITS).map((c) => {
      const date = (c.commit?.committer?.date ?? c.commit?.author?.date ?? '').slice(0, 10);
      const who = c.author?.login ?? c.commit?.author?.name ?? 'unknown';
      const msg = (c.commit?.message ?? '').split('\n')[0];
      return `- ${date} ${who}: ${msg}`;
    });

    const body = [
      `# ${repo.full_name}`,
      repo.description ?? '_No description._',
      '',
      '## Overview',
      `- Visibility: ${repo.private ? 'private' : 'public'}`,
      `- Primary language: ${repo.language ?? 'n/a'}`,
      langLine ? `- Languages: ${langLine}` : '- Languages: n/a',
      repo.topics?.length ? `- Topics: ${repo.topics.join(', ')}` : '- Topics: none',
      `- License: ${repo.license?.spdx_id ?? repo.license?.name ?? 'none'}`,
      `- Stars: ${repo.stargazers_count ?? 0}, Forks: ${repo.forks_count ?? 0}, Open issues: ${repo.open_issues_count ?? 0}`,
      '',
      '## Activity',
      `- Created: ${(repo.created_at ?? '').slice(0, 10)}`,
      `- Last push: ${(repo.pushed_at ?? '').slice(0, 10)}`,
      `- Default branch: ${repo.default_branch}`,
      '',
      '### Recent commits',
      ...(commitLines.length ? commitLines : ['- (no recent commits)']),
    ].join('\n');

    return {
      sourceSystem: this.sourceSystem,
      externalId: `${repo.full_name}:__overview__`,
      sourceUrl: repo.html_url,
      title: `${repo.full_name} (repository overview)`,
      breadcrumb: repo.full_name,
      contentType: 'text/markdown',
      aclPrincipals: acl,
      body,
      sourceUpdatedAt: repo.pushed_at,
    };
  }

  private principalsFor(repo: Repo): string[] {
    return repo.private ? [`github-repo:${repo.full_name}`] : ['public'];
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

  private getRepo(slug: string): Promise<Repo> {
    const [owner, name] = slug.split('/');
    if (!owner || !name) throw new Error(`Invalid repo slug "${slug}" — expected "owner/repo"`);
    return this.get<Repo>(`/repos/${owner}/${name}`);
  }

  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'cerebro-knowledge-layer',
    };
    // Authenticated when a token is set; unauthenticated (public repos) otherwise.
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;
    const res = await this.fetchFn(`${this.apiUrl}${path}`, { headers });
    if (!res.ok) {
      throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }
}

/** Encode a repo file path for the contents API (keep slashes, encode segments). */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

// ── GitHub REST response shapes (only the fields we use) ─────────────────────
interface Repo {
  full_name: string;
  default_branch: string;
  html_url: string;
  private?: boolean;
  description?: string | null;
  language?: string | null;
  topics?: string[];
  license?: { spdx_id?: string; name?: string } | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  created_at?: string;
  pushed_at?: string;
}
interface Commit {
  author?: { login?: string } | null;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
    committer?: { date?: string };
  };
}
interface TreeEntry {
  path?: string;
  type?: string;
  sha?: string;
}
interface ContentFile {
  content?: string;
  encoding?: string;
  html_url?: string;
}
