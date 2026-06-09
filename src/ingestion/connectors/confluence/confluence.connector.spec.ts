import { ConfluenceConnector, ConfluenceConfig } from './confluence.connector';

const config: ConfluenceConfig = {
  baseUrl: 'https://x.atlassian.net/wiki',
  email: 'a@b.c',
  apiToken: 'token',
};

function httpOk(json: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(json), json: async () => json };
}

function page(over: Record<string, unknown> = {}) {
  return {
    id: '123',
    title: 'Engineering Onboarding',
    body: { storage: { value: '<h1>Onboarding</h1><p>Hello</p>' } },
    version: { when: '2026-05-02T11:30:00.000Z', number: 3 },
    space: { key: 'ENG', name: 'Engineering' },
    ancestors: [{ title: 'Parent Page' }],
    history: { createdDate: '2026-01-10T09:00:00.000Z', createdBy: { displayName: 'Jane Doe' } },
    restrictions: {
      read: {
        restrictions: {
          group: { results: [{ name: 'engineering' }] },
          user: { results: [{ accountId: 'acc-1' }] },
        },
      },
    },
    _links: { webui: '/spaces/ENG/pages/123/Engineering+Onboarding' },
    ...over,
  };
}

describe('ConfluenceConnector', () => {
  it('requires credentials', () => {
    expect(() => new ConfluenceConnector({ baseUrl: '', email: '', apiToken: '' })).toThrow();
  });

  it('maps a page into the unified document model with Basic auth', async () => {
    const fetchFn = jest.fn(async (_url: string, _init?: unknown) => httpOk({ results: [page()] }));
    const c = new ConfluenceConnector(config, fetchFn as never);
    const [d] = await c.initialCrawl();

    expect(d.sourceSystem).toBe('confluence');
    expect(d.externalId).toBe('123');
    expect(d.sourceUrl).toBe(
      'https://x.atlassian.net/wiki/spaces/ENG/pages/123/Engineering+Onboarding',
    );
    expect(d.title).toBe('Engineering Onboarding');
    expect(d.breadcrumb).toBe('Engineering > Parent Page');
    expect(d.contentType).toBe('text/html');
    expect(d.body).toContain('<h1>Onboarding</h1>');
    expect(d.author).toBe('Jane Doe');
    expect(d.aclPrincipals).toEqual(['confluence-group:engineering', 'confluence-user:acc-1']);

    // Basic auth header derived from email:token
    const headers = (fetchFn.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe('Basic ' + Buffer.from('a@b.c:token').toString('base64'));
  });

  it('paginates until a short page is returned', async () => {
    const fetchFn = jest.fn(async (url: string) =>
      url.includes('start=0')
        ? httpOk({ results: [page({ id: '1' }), page({ id: '2' })] })
        : httpOk({ results: [page({ id: '3' })] }),
    );
    const c = new ConfluenceConnector({ ...config, pageSize: 2 }, fetchFn as never);
    const docs = await c.initialCrawl();
    expect(docs.map((d) => d.externalId)).toEqual(['1', '2', '3']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('falls back to a space principal when a page has no read restrictions', async () => {
    const open = page({ restrictions: { read: { restrictions: { group: { results: [] }, user: { results: [] } } } } });
    const fetchFn = jest.fn(async () => httpOk({ results: [open] }));
    const c = new ConfluenceConnector(config, fetchFn as never);
    const [d] = await c.initialCrawl();
    expect(d.aclPrincipals).toEqual(['confluence-space:ENG']);
  });

  it('deltaSync filters on lastModified and returns the newest cursor; no tombstones', async () => {
    const fetchFn = jest.fn(async (_url: string, _init?: unknown) => httpOk({ results: [page()] }));
    const c = new ConfluenceConnector(config, fetchFn as never);
    const r = await c.deltaSync('2026-04-01T00:00:00.000Z');

    const calledUrl = decodeURIComponent(fetchFn.mock.calls[0][0] as string);
    expect(calledUrl).toContain('lastModified >= "2026-04-01 00:00"');
    expect(r.cursor).toBe('2026-05-02T11:30:00.000Z');
    expect(r.deletedExternalIds).toEqual([]);
  });

  it('resolvePermissions extracts namespaced principals', async () => {
    const fetchFn = jest.fn(async () => httpOk(page()));
    const c = new ConfluenceConnector(config, fetchFn as never);
    expect(await c.resolvePermissions('123')).toEqual([
      'confluence-group:engineering',
      'confluence-user:acc-1',
    ]);
  });
});
