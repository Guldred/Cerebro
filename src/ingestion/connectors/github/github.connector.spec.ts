import { GitHubConnector, GitHubConfig } from './github.connector';

const config: GitHubConfig = { token: 'pat', repos: ['Guldred/Cerebro'] };

function httpOk(json: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(json), json: async () => json };
}

function repo(over: Record<string, unknown> = {}) {
  return {
    full_name: 'Guldred/Cerebro',
    default_branch: 'main',
    html_url: 'https://github.com/Guldred/Cerebro',
    private: false,
    description: 'A knowledge layer',
    language: 'TypeScript',
    topics: ['rag', 'nestjs'],
    license: { spdx_id: 'MIT' },
    stargazers_count: 3,
    forks_count: 1,
    open_issues_count: 2,
    created_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-06-01T00:00:00Z',
    ...over,
  };
}

const languages = { TypeScript: 8000, Shell: 2000 };
const commits = [
  {
    author: { login: 'guldred' },
    commit: { message: 'feat: add retrieval\n\ndetails', committer: { date: '2026-06-01T10:00:00Z' } },
  },
];
const tree = {
  tree: [
    { path: 'README.md', type: 'blob' },
    { path: 'docs/guide.md', type: 'blob' },
    { path: 'src/index.ts', type: 'blob' }, // code → ignored
    { path: 'docs', type: 'tree' },
  ],
};

/** Route a GitHub API call by URL to the right fixture. */
function makeFetch(repoOver: Record<string, unknown> = {}) {
  return jest.fn(async (url: string, _init?: unknown) => {
    if (url.includes('/languages')) return httpOk(languages);
    if (url.includes('/commits')) return httpOk(commits);
    if (url.includes('/git/trees/')) return httpOk(tree);
    if (url.includes('/contents/')) {
      const path = decodeURIComponent(url.match(/\/contents\/(.+?)\?/)![1]);
      return httpOk({
        content: Buffer.from(`# ${path}\n\nhello world`).toString('base64'),
        encoding: 'base64',
        html_url: `https://github.com/Guldred/Cerebro/blob/main/${path}`,
      });
    }
    return httpOk(repo(repoOver)); // GET /repos/{owner}/{repo}
  });
}

describe('GitHubConnector', () => {
  it('requires at least one repo; token is optional (public repos work unauthenticated)', async () => {
    expect(() => new GitHubConnector({ token: 't', repos: [] })).toThrow();
    expect(() => new GitHubConnector({ repos: ['a/b'] })).not.toThrow();

    // No token → no Authorization header is sent.
    const fetchFn = makeFetch();
    await new GitHubConnector({ repos: ['Guldred/Cerebro'] }, fetchFn as never).initialCrawl();
    const headers = (fetchFn.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBeUndefined();
  });

  it('emits a repository-overview document with languages and recent commits', async () => {
    const c = new GitHubConnector(config, makeFetch() as never);
    const docs = await c.initialCrawl();
    const overview = docs.find((d) => d.externalId.endsWith(':__overview__'))!;

    expect(overview.aclPrincipals).toEqual(['public']);
    expect(overview.sourceUrl).toBe('https://github.com/Guldred/Cerebro');
    expect(overview.contentType).toBe('text/markdown');
    expect(overview.body).toContain('Visibility: public');
    expect(overview.body).toContain('TypeScript 80%, Shell 20%');
    expect(overview.body).toContain('Topics: rag, nestjs');
    expect(overview.body).toContain('feat: add retrieval');
  });

  it('ingests documentation files only (skips code) with GitHub deep links', async () => {
    const c = new GitHubConnector(config, makeFetch() as never);
    const docs = await c.initialCrawl();
    const files = docs.filter((d) => !d.externalId.endsWith(':__overview__'));

    expect(files.map((d) => d.title).sort()).toEqual(['README.md', 'docs/guide.md']);
    const readme = files.find((d) => d.title === 'README.md')!;
    expect(readme.externalId).toBe('Guldred/Cerebro:README.md');
    expect(readme.sourceUrl).toBe('https://github.com/Guldred/Cerebro/blob/main/README.md');
    expect(readme.body).toContain('hello world');
  });

  it('LEAK GUARD CONTRACT: an emptied file is still emitted (with empty body), never dropped', async () => {
    // Dropping it would leave the previous version's chunks live under the
    // old ACL — the ingestion leak guard can only run on an EMITTED document.
    const fetchFn = jest.fn(async (url: string, _init?: unknown) => {
      if (url.includes('/languages')) return httpOk(languages);
      if (url.includes('/commits')) return httpOk(commits);
      if (url.includes('/git/trees/')) return httpOk(tree);
      if (url.includes('/contents/')) {
        const path = decodeURIComponent(url.match(/\/contents\/(.+?)\?/)![1]);
        return httpOk({
          content: path === 'README.md' ? '' : Buffer.from('# doc\n\ncontent').toString('base64'),
          encoding: 'base64',
        });
      }
      return httpOk(repo());
    });
    const c = new GitHubConnector(config, fetchFn as never);
    const docs = await c.initialCrawl();
    const readme = docs.find((d) => d.title === 'README.md')!;
    expect(readme).toBeDefined();
    expect(readme.body).toBe('');
  });

  it('marks private-repo content with a repo-scoped ACL principal', async () => {
    const c = new GitHubConnector(config, makeFetch({ private: true }) as never);
    const [overview] = await c.initialCrawl();
    expect(overview.aclPrincipals).toEqual(['github-repo:Guldred/Cerebro']);
  });

  it('deltaSync skips repos untouched since the cursor and advances the cursor', async () => {
    const c = new GitHubConnector(config, makeFetch() as never);

    const stale = await c.deltaSync('2026-07-01T00:00:00Z'); // after pushed_at
    expect(stale.documents).toHaveLength(0);
    // Cursor never regresses: it stays at max(since, pushed_at) = the since.
    expect(stale.cursor).toBe('2026-07-01T00:00:00.000Z');

    const fresh = await c.deltaSync('2026-05-01T00:00:00Z'); // before pushed_at
    expect(fresh.documents.length).toBeGreaterThan(0);
  });

  it('resolvePermissions returns the repo principals', async () => {
    const c = new GitHubConnector(config, makeFetch({ private: true }) as never);
    expect(await c.resolvePermissions('Guldred/Cerebro:README.md')).toEqual([
      'github-repo:Guldred/Cerebro',
    ]);
  });
});
