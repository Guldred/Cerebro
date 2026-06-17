import { CerebroConfig } from '../config/config';
import { GraphGroupResolver, selectGroupResolver } from './group-resolver';

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string };
}

function resp(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A fetch double that routes the token POST and the getMemberGroups POST. */
function fakeGraph(opts: {
  tokenStatus?: number;
  tokenBody?: unknown;
  groupsStatus?: number;
  groupsBody?: unknown;
  groupsThrows?: boolean;
} = {}) {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init: FetchCall['init']) => {
    calls.push({ url, init });
    if (url.includes('/oauth2/v2.0/token')) {
      return resp(opts.tokenStatus ?? 200, opts.tokenBody ?? { access_token: 'app-tok', expires_in: 3600 });
    }
    if (opts.groupsThrows) throw new Error('ECONNRESET');
    return resp(opts.groupsStatus ?? 200, opts.groupsBody ?? { value: ['g-1', 'g-2'] });
  };
  const memberGroupCalls = () => calls.filter((c) => c.url.includes('getMemberGroups'));
  const tokenCalls = () => calls.filter((c) => c.url.includes('/token'));
  return { fn, calls, memberGroupCalls, tokenCalls };
}

const cfg = (over: Partial<CerebroConfig['auth']['graph']> = {}): CerebroConfig['auth']['graph'] => ({
  tenantId: 'tid',
  clientId: 'cid',
  clientSecret: 'secret',
  baseUrl: 'https://graph.microsoft.com',
  authority: 'https://login.microsoftonline.com',
  securityEnabledOnly: true,
  cacheTtlMs: 0,
  ...over,
});

describe('GraphGroupResolver', () => {
  it('acquires an app token then returns the transitive group object-ids', async () => {
    const { fn, calls } = fakeGraph({ groupsBody: { value: ['g-a', 'g-b', 'g-c'] } });
    const groups = await new GraphGroupResolver(cfg(), fn).resolveGroups('oid-1');

    expect(groups).toEqual(['g-a', 'g-b', 'g-c']);
    expect(calls[0].url).toBe('https://login.microsoftonline.com/tid/oauth2/v2.0/token');
    expect(calls[0].init.body).toContain('grant_type=client_credentials');
    expect(calls[0].init.body).toContain('scope=https%3A%2F%2Fgraph.microsoft.com%2F.default');
    expect(calls[1].url).toBe('https://graph.microsoft.com/v1.0/users/oid-1/getMemberGroups');
    expect(calls[1].init.headers.authorization).toBe('Bearer app-tok');
  });

  // The security-critical parity: securityEnabledOnly must mirror the tenant's
  // groupMembershipClaims manifest. A future default flip is now a visible test
  // change, not a silent ACL shift.
  it('sends securityEnabledOnly exactly as configured', async () => {
    const t = fakeGraph();
    await new GraphGroupResolver(cfg({ securityEnabledOnly: true }), t.fn).resolveGroups('o');
    expect(JSON.parse(t.memberGroupCalls()[0].init.body!)).toEqual({ securityEnabledOnly: true });

    const f = fakeGraph();
    await new GraphGroupResolver(cfg({ securityEnabledOnly: false }), f.fn).resolveGroups('o');
    expect(JSON.parse(f.memberGroupCalls()[0].init.body!)).toEqual({ securityEnabledOnly: false });
  });

  it('caches the app token across calls (token endpoint hit once)', async () => {
    const t = fakeGraph();
    const r = new GraphGroupResolver(cfg(), t.fn);
    await r.resolveGroups('oid-1');
    await r.resolveGroups('oid-2');
    expect(t.tokenCalls()).toHaveLength(1);
    expect(t.memberGroupCalls()).toHaveLength(2);
  });

  it('per-oid cache (TTL>0) serves a repeat oid without a second Graph call', async () => {
    const t = fakeGraph();
    const r = new GraphGroupResolver(cfg({ cacheTtlMs: 60_000 }), t.fn);
    await r.resolveGroups('oid-1');
    await r.resolveGroups('oid-1');
    expect(t.memberGroupCalls()).toHaveLength(1);
  });

  it('TTL=0 (default) re-calls Graph every request (no cache — the documented cliff)', async () => {
    const t = fakeGraph();
    const r = new GraphGroupResolver(cfg(), t.fn);
    await r.resolveGroups('oid-1');
    await r.resolveGroups('oid-1');
    expect(t.memberGroupCalls()).toHaveLength(2);
  });

  // Fail-closed: every error path throws so IdentityService 403s — never a partial set.
  it('throws when the token endpoint fails', async () => {
    const { fn } = fakeGraph({ tokenStatus: 401, tokenBody: { error: 'invalid_client' } });
    await expect(new GraphGroupResolver(cfg(), fn).resolveGroups('o')).rejects.toThrow(/token endpoint 401/);
  });

  it('throws on a getMemberGroups 429 (throttling)', async () => {
    const { fn } = fakeGraph({ groupsStatus: 429, groupsBody: { error: 'throttled' } });
    await expect(new GraphGroupResolver(cfg(), fn).resolveGroups('o')).rejects.toThrow(/getMemberGroups 429/);
  });

  it('throws on the 400 Directory_ResultSizeLimitExceeded (>11k groups)', async () => {
    const { fn } = fakeGraph({ groupsStatus: 400, groupsBody: { error: { code: 'Directory_ResultSizeLimitExceeded' } } });
    await expect(new GraphGroupResolver(cfg(), fn).resolveGroups('o')).rejects.toThrow(/getMemberGroups 400/);
  });

  it('throws when the response carries no value array', async () => {
    const { fn } = fakeGraph({ groupsBody: { notValue: [] } });
    await expect(new GraphGroupResolver(cfg(), fn).resolveGroups('o')).rejects.toThrow(/no value array/);
  });

  it('throws on a network error', async () => {
    const { fn } = fakeGraph({ groupsThrows: true });
    await expect(new GraphGroupResolver(cfg(), fn).resolveGroups('o')).rejects.toThrow();
  });

  it('URL-encodes the oid in the path', async () => {
    const t = fakeGraph();
    await new GraphGroupResolver(cfg(), t.fn).resolveGroups('a/b oid');
    expect(t.memberGroupCalls()[0].url).toBe('https://graph.microsoft.com/v1.0/users/a%2Fb%20oid/getMemberGroups');
  });

  it('honors a sovereign-cloud baseUrl/authority (trailing slash trimmed)', async () => {
    const t = fakeGraph();
    await new GraphGroupResolver(
      cfg({ baseUrl: 'https://graph.microsoft.us/', authority: 'https://login.microsoftonline.us/' }),
      t.fn,
    ).resolveGroups('oid-1');
    expect(t.tokenCalls()[0].url).toBe('https://login.microsoftonline.us/tid/oauth2/v2.0/token');
    expect(t.tokenCalls()[0].init.body).toContain('scope=https%3A%2F%2Fgraph.microsoft.us%2F.default');
    expect(t.memberGroupCalls()[0].url).toBe('https://graph.microsoft.us/v1.0/users/oid-1/getMemberGroups');
  });

  it('filters non-string entries out of the value array', async () => {
    const { fn } = fakeGraph({ groupsBody: { value: ['g-1', 42, null, 'g-2'] } });
    expect(await new GraphGroupResolver(cfg(), fn).resolveGroups('o')).toEqual(['g-1', 'g-2']);
  });
});

describe('selectGroupResolver (config → resolver wiring)', () => {
  it('returns null by default — preserves the hard-403 on overage', () => {
    expect(selectGroupResolver({ auth: { groupResolver: 'none' } } as CerebroConfig)).toBeNull();
  });

  it('returns a GraphGroupResolver when AUTH_GROUP_RESOLVER=graph', () => {
    expect(
      selectGroupResolver({ auth: { groupResolver: 'graph', graph: cfg() } } as CerebroConfig),
    ).toBeInstanceOf(GraphGroupResolver);
  });
});
