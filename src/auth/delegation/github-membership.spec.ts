import { CerebroConfig } from '../../config/config';
import { DatabaseService } from '../../db/database.service';
import { CallerIdentity } from '../identity.types';
import {
  GitHubMembershipChecker,
  GitHubMembershipConfig,
  selectMembershipChecker,
} from './github-membership';
import { UnverifiedMembershipChecker } from './membership';

type FetchCall = { url: string; init: { method: string; headers: Record<string, string>; redirect: string } };

/** A fetch double returning a fixed status (or throwing), capturing every call. */
function fakeFetch(behavior: { status?: number; throws?: boolean }) {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init: FetchCall['init']) => {
    calls.push({ url, init });
    if (behavior.throws) throw new Error('ECONNRESET');
    return { status: behavior.status ?? 0 };
  };
  return { fn, calls };
}

/** A DB double whose identity_links lookup returns `login` (or nothing). */
function fakeDb(login: string | null) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: login ? [{ source_login: login }] : [] };
    },
  } as unknown as DatabaseService;
  return { db, queries };
}

const cfg = (over: Partial<GitHubMembershipConfig> = {}): GitHubMembershipConfig => ({
  org: 'acme',
  token: 'ghp_member',
  apiUrl: '',
  ...over,
});

const human = (principals: string[] = ['entra-user:oid-1', 'entra-group:hr']): CallerIdentity => ({
  subject: 'oid-1',
  principals,
  mode: 'oidc',
});

describe('GitHubMembershipChecker', () => {
  it('204 (calling token IS an org member, user IS a member) → confirmed', async () => {
    const { fn, calls } = fakeFetch({ status: 204 });
    const { db } = fakeDb('octocat');
    const checker = new GitHubMembershipChecker(cfg(), db, fn);
    expect(await checker.check(human(), 'github')).toBe('confirmed');
    expect(calls[0].url).toBe('https://api.github.com/orgs/acme/members/octocat');
    expect(calls[0].init.redirect).toBe('manual'); // redirects are NEVER followed
    expect(calls[0].init.headers.authorization).toBe('Bearer ghp_member');
  });

  it('404 (calling token is a member, user is NOT) → revoked', async () => {
    const { fn } = fakeFetch({ status: 404 });
    const { db } = fakeDb('ex-employee');
    expect(await new GitHubMembershipChecker(cfg(), db, fn).check(human(), 'github')).toBe('revoked');
  });

  // The headline fail-closed case: a calling token that is NOT an org member gets
  // a 302 redirect to the PUBLIC member list. Following it would silently downgrade
  // the check; with redirect:manual we see the 302 and refuse to trust it.
  it('302 (non-member calling token → public-members redirect) → unknown, NEVER confirmed', async () => {
    const { fn } = fakeFetch({ status: 302 });
    const { db } = fakeDb('octocat');
    expect(await new GitHubMembershipChecker(cfg(), db, fn).check(human(), 'github')).toBe('unknown');
  });

  it('opaque redirect (status 0, as a browser fetch yields) → unknown', async () => {
    const { fn } = fakeFetch({ status: 0 });
    const { db } = fakeDb('octocat');
    expect(await new GitHubMembershipChecker(cfg(), db, fn).check(human(), 'github')).toBe('unknown');
  });

  it('403 (rate limit / forbidden) → unknown (step up, never deny or allow)', async () => {
    const { fn } = fakeFetch({ status: 403 });
    const { db } = fakeDb('octocat');
    expect(await new GitHubMembershipChecker(cfg(), db, fn).check(human(), 'github')).toBe('unknown');
  });

  it('5xx → unknown', async () => {
    const { fn } = fakeFetch({ status: 503 });
    const { db } = fakeDb('octocat');
    expect(await new GitHubMembershipChecker(cfg(), db, fn).check(human(), 'github')).toBe('unknown');
  });

  it('network error (fetch throws) → unknown', async () => {
    const { fn } = fakeFetch({ throws: true });
    const { db } = fakeDb('octocat');
    expect(await new GitHubMembershipChecker(cfg(), db, fn).check(human(), 'github')).toBe('unknown');
  });

  it('no identity link → unknown, and the source API is never called', async () => {
    const { fn, calls } = fakeFetch({ status: 204 });
    const { db } = fakeDb(null);
    expect(await new GitHubMembershipChecker(cfg(), db, fn).check(human(), 'github')).toBe('unknown');
    expect(calls).toHaveLength(0);
  });

  it('caller with no entra-user principal → unknown, DB is never queried', async () => {
    const { fn } = fakeFetch({ status: 204 });
    const { db, queries } = fakeDb('octocat');
    const groupOnly = human(['entra-group:hr', 'all-users']);
    expect(await new GitHubMembershipChecker(cfg(), db, fn).check(groupOnly, 'github')).toBe('unknown');
    expect(queries).toHaveLength(0);
  });

  // A github checker must not pretend to speak for other sensitive sources, so a
  // mixed DELEGATION_SENSITIVE_SOURCES steps the others up rather than allowing.
  it('non-github source → unknown without touching DB or the API', async () => {
    const { fn, calls } = fakeFetch({ status: 204 });
    const { db, queries } = fakeDb('octocat');
    expect(await new GitHubMembershipChecker(cfg(), db, fn).check(human(), 'confluence')).toBe('unknown');
    expect(queries).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('a hostile login cannot escape the /orgs/{org}/members/ path (URL-encoded)', async () => {
    const { fn, calls } = fakeFetch({ status: 404 });
    const { db } = fakeDb('../../../user/octocat/orgs');
    await new GitHubMembershipChecker(cfg(), db, fn).check(human(), 'github');
    expect(calls[0].url).toBe(
      'https://api.github.com/orgs/acme/members/..%2F..%2F..%2Fuser%2Foctocat%2Forgs',
    );
  });

  it('only the entra-user principals (never the human oid/groups) bridge to a login', async () => {
    const { fn } = fakeFetch({ status: 204 });
    const { db, queries } = fakeDb('octocat');
    await new GitHubMembershipChecker(cfg(), db, fn).check(human(), 'github');
    expect(queries[0].params[0]).toEqual(['entra-user:oid-1']); // group filtered out
    expect(queries[0].params[1]).toBe('github');
  });

  it('honors a custom apiUrl (GitHub Enterprise Server), trailing slash trimmed', async () => {
    const { fn, calls } = fakeFetch({ status: 204 });
    const { db } = fakeDb('octocat');
    const checker = new GitHubMembershipChecker(cfg({ apiUrl: 'https://ghe.acme.dev/api/v3/' }), db, fn);
    await checker.check(human(), 'github');
    expect(calls[0].url).toBe('https://ghe.acme.dev/api/v3/orgs/acme/members/octocat');
  });

  it('omits the Authorization header when no token is configured', async () => {
    const { fn, calls } = fakeFetch({ status: 302 });
    const { db } = fakeDb('octocat');
    await new GitHubMembershipChecker(cfg({ token: '' }), db, fn).check(human(), 'github');
    expect(calls[0].init.headers.authorization).toBeUndefined();
  });
});

describe('selectMembershipChecker (config → checker wiring)', () => {
  const configWith = (checker: 'unverified' | 'github'): CerebroConfig =>
    ({
      delegation: { membership: { checker, github: { org: 'acme', token: '', apiUrl: '' } } },
    }) as unknown as CerebroConfig;

  it('defaults to the honest UnverifiedMembershipChecker', () => {
    const { db } = fakeDb(null);
    expect(selectMembershipChecker(configWith('unverified'), db)).toBeInstanceOf(UnverifiedMembershipChecker);
  });

  it('selects the connector-backed GitHubMembershipChecker when configured', () => {
    const { db } = fakeDb(null);
    expect(selectMembershipChecker(configWith('github'), db)).toBeInstanceOf(GitHubMembershipChecker);
  });
});
