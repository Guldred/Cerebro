import { GitLabConnector, GitLabConfig } from './gitlab.connector';

const config: GitLabConfig = { token: 'glpat-x', projects: ['platform/runbooks'] };

function httpOk(json: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(json), json: async () => json };
}

function httpRaw(raw: string) {
  return {
    ok: true,
    status: 200,
    text: async (): Promise<string> => raw,
    json: async (): Promise<unknown> => JSON.parse(raw),
  };
}

function httpFail(status: number) {
  return { ok: false, status, text: async () => `error ${status}`, json: async () => ({}) };
}

function project(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    path_with_namespace: 'platform/runbooks',
    default_branch: 'main',
    web_url: 'https://gitlab.example.com/platform/runbooks',
    visibility: 'public',
    description: 'Operational runbooks',
    topics: ['ops', 'runbooks'],
    star_count: 5,
    forks_count: 2,
    open_issues_count: 3,
    created_at: '2026-01-01T00:00:00Z',
    last_activity_at: '2026-06-01T00:00:00Z',
    ...over,
  };
}

const languages = { Markdown: 80.0, Shell: 20.0 }; // GitLab returns percentages
const commits = [
  { title: 'docs: update rollback runbook', author_name: 'casey', committed_date: '2026-06-01T10:00:00Z' },
];
const tree = [
  { path: 'README.md', type: 'blob' },
  { path: 'runbooks/deployment.md', type: 'blob' },
  { path: 'scripts/deploy.sh', type: 'blob' }, // code → ignored
  { path: 'runbooks', type: 'tree' },
];

/**
 * Route a GitLab API call by URL to the right fixture. STRICT: an unmatched
 * URL throws, so a regression that hits a malformed endpoint fails the test
 * instead of silently receiving valid JSON (tripwire, like the Confluence
 * suite's CQL pin).
 */
function makeFetch(projectOver: Record<string, unknown> = {}) {
  return jest.fn(async (url: string, _init?: unknown) => {
    if (url.includes('/languages')) return httpOk(languages);
    if (url.includes('/repository/commits')) return httpOk(commits);
    if (url.includes('/repository/tree')) return httpOk(tree);
    if (url.includes('/repository/files/')) {
      const path = decodeURIComponent(url.match(/\/repository\/files\/(.+?)\/raw/)![1]);
      return httpRaw(`# ${path}\n\nhello from gitlab`);
    }
    if (/\/api\/v4\/projects\/[^/]+$/.test(url)) return httpOk(project(projectOver));
    throw new Error(`unmatched URL in test fetch: ${url}`);
  });
}

describe('GitLabConnector', () => {
  it('requires at least one project; token is optional (public projects work unauthenticated)', async () => {
    expect(() => new GitLabConnector({ token: 't', projects: [] })).toThrow();
    expect(() => new GitLabConnector({ projects: ['a/b'] })).not.toThrow();

    const fetchFn = makeFetch();
    await new GitLabConnector({ projects: ['platform/runbooks'] }, fetchFn as never).initialCrawl();
    const headers = (fetchFn.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['PRIVATE-TOKEN']).toBeUndefined();

    // With a token, the canonical PAT header is sent.
    const authed = makeFetch();
    await new GitLabConnector(config, authed as never).initialCrawl();
    const authedHeaders = (authed.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(authedHeaders['PRIVATE-TOKEN']).toBe('glpat-x');
  });

  it('an EMPTY baseUrl falls back to gitlab.com (dotenv turns a blank env line into "")', async () => {
    const fetchFn = makeFetch();
    await new GitLabConnector({ projects: ['a/b'], baseUrl: '' }, fetchFn as never).initialCrawl();
    expect(fetchFn.mock.calls[0][0]).toBe('https://gitlab.com/api/v4/projects/a%2Fb');
  });

  it('emits a project-overview document with languages and recent commits', async () => {
    const c = new GitLabConnector(config, makeFetch() as never);
    const docs = await c.initialCrawl();
    const overview = docs.find((d) => d.externalId.endsWith(':__overview__'))!;

    expect(overview.aclPrincipals).toEqual(['public']);
    expect(overview.aclStatus).toBe('resolved');
    expect(overview.sourceUrl).toBe('https://gitlab.example.com/platform/runbooks');
    expect(overview.body).toContain('Visibility: public');
    expect(overview.body).toContain('Markdown 80%, Shell 20%');
    expect(overview.body).toContain('Topics: ops, runbooks');
    expect(overview.body).toContain('docs: update rollback runbook');
  });

  it('ingests documentation files only (skips code) with GitLab deep links', async () => {
    const c = new GitLabConnector(config, makeFetch() as never);
    const docs = await c.initialCrawl();
    const files = docs.filter((d) => !d.externalId.endsWith(':__overview__'));

    expect(files.map((d) => d.title).sort()).toEqual(['README.md', 'runbooks/deployment.md']);
    const runbook = files.find((d) => d.title === 'runbooks/deployment.md')!;
    expect(runbook.externalId).toBe('platform/runbooks:runbooks/deployment.md');
    expect(runbook.sourceUrl).toBe(
      'https://gitlab.example.com/platform/runbooks/-/blob/main/runbooks/deployment.md',
    );
    expect(runbook.body).toContain('hello from gitlab');
  });

  it('LEAK GUARD CONTRACT: an emptied file is still emitted (with empty body), never dropped', async () => {
    // Dropping it would leave the previous version's chunks live under the
    // old ACL — the ingestion leak guard can only run on an EMITTED document.
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('/languages')) return httpOk(languages);
      if (url.includes('/repository/commits')) return httpOk(commits);
      if (url.includes('/repository/tree')) return httpOk(tree);
      if (url.includes('/repository/files/')) {
        return url.includes('README') ? httpRaw('') : httpRaw('# doc\n\ncontent');
      }
      return httpOk(project({ visibility: 'private' }));
    });
    const c = new GitLabConnector(config, fetchFn as never);
    const docs = await c.initialCrawl();
    const readme = docs.find((d) => d.title === 'README.md')!;
    expect(readme).toBeDefined();
    expect(readme.body).toBe('');
    expect(readme.aclPrincipals).toEqual(['gitlab-project:platform/runbooks']);
  });

  it('VISIBILITY → PRINCIPALS: internal maps EVERY document to the reserved all-users principal', async () => {
    const c = new GitLabConnector(config, makeFetch({ visibility: 'internal' }) as never);
    const docs = await c.initialCrawl();
    expect(docs.length).toBeGreaterThan(1);
    for (const d of docs) {
      expect(d.aclPrincipals).toEqual(['all-users']);
      expect(d.aclStatus).toBe('resolved');
    }
  });

  it('VISIBILITY → PRINCIPALS: private maps EVERY document to the source-native project principal', async () => {
    const c = new GitLabConnector(config, makeFetch({ visibility: 'private' }) as never);
    const docs = await c.initialCrawl();
    expect(docs.length).toBeGreaterThan(1);
    for (const d of docs) {
      expect(d.aclPrincipals).toEqual(['gitlab-project:platform/runbooks']);
    }
  });

  it('FAIL-CLOSED: an unknown visibility quarantines every document of the project', async () => {
    const c = new GitLabConnector(config, makeFetch({ visibility: 'confidential-beta' }) as never);
    const docs = await c.initialCrawl();
    expect(docs.length).toBeGreaterThan(1);
    for (const d of docs) {
      expect(d.aclStatus).toBe('failed');
      expect(d.aclPrincipals).toEqual([]);
    }
  });

  it('FAIL-CLOSED: a MISSING visibility field also quarantines (API drift)', async () => {
    const c = new GitLabConnector(config, makeFetch({ visibility: undefined }) as never);
    const [overview] = await c.initialCrawl();
    expect(overview.aclStatus).toBe('failed');
    expect(overview.aclPrincipals).toEqual([]);
  });

  it('FAIL-CLOSED survives the delta path: unknown visibility quarantines deltaSync documents too', async () => {
    const c = new GitLabConnector(config, makeFetch({ visibility: 'mystery' }) as never);
    const r = await c.deltaSync('2026-05-01T00:00:00Z');
    expect(r.documents.length).toBeGreaterThan(0);
    for (const d of r.documents) {
      expect(d.aclStatus).toBe('failed');
      expect(d.aclPrincipals).toEqual([]);
    }
  });

  it('EMPTY REPOSITORY (null default_branch): emits the overview only — never guesses a ref', async () => {
    const fetchFn = makeFetch({ default_branch: null, empty_repo: true });
    const c = new GitLabConnector(config, fetchFn as never);
    const docs = await c.initialCrawl();

    expect(docs).toHaveLength(1);
    expect(docs[0].externalId).toBe('platform/runbooks:__overview__');
    // No tree/commits/languages calls were attempted against a fabricated ref.
    const urls = fetchFn.mock.calls.map((call) => call[0] as string);
    expect(urls.some((u) => u.includes('/repository/'))).toBe(false);
  });

  it('paginates the repository tree until a short page', async () => {
    const bigTree = Array.from({ length: 100 }, (_, i) => ({
      path: `docs/page-${i}.md`,
      type: 'blob',
    }));
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('/languages')) return httpOk(languages);
      if (url.includes('/repository/commits')) return httpOk(commits);
      if (url.includes('/repository/tree')) {
        const page = Number(url.match(/[?&]page=(\d+)/)![1]);
        return page === 1 ? httpOk(bigTree) : httpOk(tree);
      }
      if (url.includes('/repository/files/')) return httpRaw('# doc\n\ncontent');
      return httpOk(project());
    });
    const c = new GitLabConnector(config, fetchFn as never);
    const docs = await c.initialCrawl();
    // 100 page-N docs + README + runbook + overview
    expect(docs).toHaveLength(103);
    const treeCalls = fetchFn.mock.calls.filter((call) => (call[0] as string).includes('/repository/tree'));
    expect(treeCalls).toHaveLength(2);
  });

  it('retries a 429 honoring Retry-After instead of aborting the crawl', async () => {
    let rawAttempts = 0;
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('/languages')) return httpOk(languages);
      if (url.includes('/repository/commits')) return httpOk(commits);
      if (url.includes('/repository/tree')) return httpOk([{ path: 'README.md', type: 'blob' }]);
      if (url.includes('/repository/files/')) {
        rawAttempts++;
        if (rawAttempts === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: (n: string) => (n === 'retry-after' ? '0' : null) },
            text: async (): Promise<string> => 'rate limited',
            json: async (): Promise<unknown> => ({}),
          };
        }
        return httpRaw('# README\n\ncontent');
      }
      return httpOk(project());
    });
    const c = new GitLabConnector(config, fetchFn as never);
    const docs = await c.initialCrawl();
    expect(rawAttempts).toBe(2);
    expect(docs.find((d) => d.title === 'README.md')!.body).toContain('content');
  });

  it('deltaSync skips projects untouched since the cursor and advances the cursor', async () => {
    const c = new GitLabConnector(config, makeFetch() as never);

    const stale = await c.deltaSync('2026-07-01T00:00:00Z'); // after last_activity_at
    expect(stale.documents).toHaveLength(0);
    expect(stale.cursor).toBe('2026-07-01T00:00:00.000Z'); // never regresses

    const fresh = await c.deltaSync('2026-05-01T00:00:00Z');
    expect(fresh.documents.length).toBeGreaterThan(0);
  });

  it('CURSOR BOUNDARY: cursor exactly equal to last_activity_at still re-crawls (inclusive bound)', async () => {
    // GitLab throttles last_activity_at updates, so same-instant activity
    // would be skipped FOREVER under a strict '>'. Idempotent re-crawl is
    // absorbed by the ingestion content-hash skip.
    const c = new GitLabConnector(config, makeFetch() as never);
    const r = await c.deltaSync('2026-06-01T00:00:00Z'); // == last_activity_at
    expect(r.documents.length).toBeGreaterThan(0);
  });

  it('resolvePermissions covers the whole visibility table (acl:refresh path)', async () => {
    const cases: [Record<string, unknown>, string[]][] = [
      [{ visibility: 'public' }, ['public']],
      [{ visibility: 'internal' }, ['all-users']],
      [{ visibility: 'private' }, ['gitlab-project:platform/runbooks']],
    ];
    for (const [over, expected] of cases) {
      const c = new GitLabConnector(config, makeFetch(over) as never);
      await expect(c.resolvePermissions('platform/runbooks:README.md')).resolves.toEqual(expected);
      await expect(c.resolvePermissions('platform/runbooks:__overview__')).resolves.toEqual(expected);
    }
  });

  it('resolvePermissions splits on the FIRST colon — file paths may contain colons, project paths cannot', async () => {
    const fetchFn = makeFetch({ visibility: 'private' });
    const c = new GitLabConnector(config, fetchFn as never);
    await expect(
      c.resolvePermissions('platform/runbooks:docs/release:2026-06.md'),
    ).resolves.toEqual(['gitlab-project:platform/runbooks']);
    expect(fetchFn.mock.calls[0][0]).toContain('/api/v4/projects/platform%2Frunbooks');
  });

  it('resolvePermissions THROWS on a failed project fetch (404 = token lost access) — quarantine, never widen', async () => {
    const fetchFn = jest.fn(async () => httpFail(404));
    const c = new GitLabConnector(config, fetchFn as never);
    await expect(c.resolvePermissions('platform/runbooks:README.md')).rejects.toThrow(/404/);
  });

  it('resolvePermissions THROWS on unknown visibility — refreshAcls quarantines, never guesses', async () => {
    const c = new GitLabConnector(config, makeFetch({ visibility: 'mystery' }) as never);
    await expect(c.resolvePermissions('platform/runbooks:README.md')).rejects.toThrow(
      /unknown visibility/,
    );
  });
});
