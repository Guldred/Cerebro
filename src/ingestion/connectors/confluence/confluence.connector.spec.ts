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
    ancestors: [{ id: '456', title: 'Parent Page' }],
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
        ? httpOk({ results: [page({ id: '1', ancestors: [] }), page({ id: '2', ancestors: [] })] })
        : httpOk({ results: [page({ id: '3', ancestors: [] })] }),
    );
    const c = new ConfluenceConnector({ ...config, pageSize: 2 }, fetchFn as never);
    const docs = await c.initialCrawl();
    expect(docs.map((d) => d.externalId)).toEqual(['1', '2', '3']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('crawls ONLY pages — the CQL pins type=page so attachments/blogposts never enter (P1.1 tripwire)', async () => {
    const fetchFn = jest.fn(async (_url: string) => httpOk({ results: [] }));
    const c = new ConfluenceConnector(config, fetchFn as never);
    await c.initialCrawl();
    await c.deltaSync(null);
    for (const call of fetchFn.mock.calls) {
      expect(decodeURIComponent(call[0] as string)).toContain('type=page');
    }
  });

  it('FAIL-CLOSED: an ancestor entry without an id quarantines the document (never over-grants)', async () => {
    // A dropped ancestor layer would widen the read-set to the space base —
    // the resolver must refuse instead.
    const broken = page({ ancestors: [{ title: 'Restricted Parent' }] });
    const fetchFn = jest.fn(async () => httpOk({ results: [broken] }));
    const c = new ConfluenceConnector(config, fetchFn as never);
    const [d] = await c.initialCrawl();
    expect(d.aclStatus).toBe('failed');
    expect(d.aclPrincipals).toEqual([]);
  });

  it('FAIL-CLOSED: non-page content (attachment/blogpost) quarantines — no page-ACL inheritance', async () => {
    const attachment = page({ id: '789', type: 'attachment', ancestors: [] });
    const fetchFn = jest.fn(async () => httpOk({ results: [attachment] }));
    const c = new ConfluenceConnector(config, fetchFn as never);
    const [d] = await c.initialCrawl();
    expect(d.aclStatus).toBe('failed');
    expect(d.aclPrincipals).toEqual([]);
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
