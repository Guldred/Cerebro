import { CerebroConfig } from '../../config/config';
import { DatabaseService } from '../../db/database.service';
import { CallerIdentity, ENTRA_USER_PREFIX } from '../identity.types';
import { MEMBERSHIP_CHECKER, MembershipChecker, MembershipStatus, UnverifiedMembershipChecker } from './membership';

export interface GitHubMembershipConfig {
  /** The org whose live membership gates the sensitive `github` source. */
  org: string;
  /** Read token that is ITSELF a member of `org` (see the redirect note below). */
  token: string;
  /** API base — default api.github.com; set for GitHub Enterprise Server. */
  apiUrl: string;
}

/** Minimal fetch surface — STATUS only (the body is never read); redirects are
 *  explicitly NOT followed (see the class doc). */
type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; redirect: 'manual' },
) => Promise<{ status: number }>;

const GITHUB_SOURCE = 'github';

/**
 * Connector-backed membership oracle for the `github` source
 * (docs/Totem_Integration.md §11). The drop-in that gives the Phase-2 PDP's
 * late-binding re-check real teeth.
 *
 * Closes the ONE window the static layers cannot: a caller removed from the
 * GitHub org AT THE SOURCE, before the admin-managed `principal_mappings` row is
 * updated. The STABLE identity bind (Entra `oid` → GitHub login) lives in
 * `identity_links`; the VOLATILE membership is re-read LIVE from GitHub here.
 *
 * FAIL-CLOSED to step-up. `GET /orgs/{org}/members/{login}` returns a clean
 * 204 (member) / 404 (not a member) ONLY when the CALLING token is itself an org
 * member; otherwise GitHub 302-REDIRECTS to the public-member list. `fetch`
 * follows redirects by default, which would silently swap "is a member" for "is
 * a PUBLIC member" — so we pin `redirect: 'manual'` and trust ONLY an
 * unambiguous 204 (`confirmed`) and a clean 404 (`revoked`). ANYTHING else — a
 * 3xx redirect (incl. the opaque status 0 a browser fetch yields), 403 (rate
 * limit / forbidden), 5xx, a network error, a non-github source, or no identity
 * link — is `unknown`, and the PDP steps up. The checker NEVER returns
 * `confirmed` on an ambiguous response.
 */
export class GitHubMembershipChecker implements MembershipChecker {
  private readonly apiUrl: string;

  constructor(
    private readonly config: GitHubMembershipConfig,
    private readonly db: DatabaseService,
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
  ) {
    // `||` not `??`: a blank DELEGATION_GITHUB_API_URL= line is an EMPTY STRING,
    // which must still mean "default to api.github.com".
    this.apiUrl = (config.apiUrl?.trim() || 'https://api.github.com').replace(/\/$/, '');
  }

  async check(identity: CallerIdentity, sourceSystem: string): Promise<MembershipStatus> {
    // This oracle speaks ONLY for github; any other sensitive source is `unknown`
    // so a mixed DELEGATION_SENSITIVE_SOURCES still steps the others up rather
    // than silently allowing them.
    if (sourceSystem !== GITHUB_SOURCE) return 'unknown';

    const login = await this.resolveLogin(identity);
    if (!login) return 'unknown'; // no stable identity link → cannot confirm

    return this.queryMembership(login);
  }

  /** The caller's GitHub login from identity_links — the durable bind, never an
   *  ACL grant (it is read here and NOWHERE in the retrieval path). */
  private async resolveLogin(identity: CallerIdentity): Promise<string | null> {
    const entraUsers = identity.principals.filter((p) => p.startsWith(ENTRA_USER_PREFIX));
    if (entraUsers.length === 0) return null;
    const res = await this.db.query<{ source_login: string }>(
      'SELECT source_login FROM identity_links WHERE entra_principal = ANY($1) AND source_system = $2 LIMIT 1',
      [entraUsers, GITHUB_SOURCE],
    );
    return res.rows[0]?.source_login ?? null;
  }

  private async queryMembership(login: string): Promise<MembershipStatus> {
    // Both segments are encoded: `org` is operator-set, `login` is admin-entered —
    // encoding keeps a hostile login from escaping the /orgs/{org}/members/ path.
    const url = `${this.apiUrl}/orgs/${encodeURIComponent(this.config.org)}/members/${encodeURIComponent(login)}`;
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'cerebro-knowledge-layer',
    };
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;

    let status: number;
    try {
      ({ status } = await this.fetchFn(url, { method: 'GET', headers, redirect: 'manual' }));
    } catch {
      return 'unknown'; // network / DNS / timeout — never assume membership
    }
    if (status === 204) return 'confirmed';
    if (status === 404) return 'revoked';
    // 3xx (non-member token → public-members redirect, or opaque status 0),
    // 403 (rate limit / forbidden), 5xx, anything else → cannot prove either way.
    return 'unknown';
  }
}

/**
 * Config-driven selection of the Phase-2 membership oracle, used by the
 * AuthModule DI factory (extracted so the env→checker wiring is unit-testable
 * without booting Nest). Defaults to the honest `unverified` checker; only an
 * explicit DELEGATION_MEMBERSHIP_CHECKER opts into a connector-backed oracle.
 */
export function selectMembershipChecker(config: CerebroConfig, db: DatabaseService): MembershipChecker {
  if (config.delegation.membership.checker === 'github') {
    return new GitHubMembershipChecker(config.delegation.membership.github, db);
  }
  return new UnverifiedMembershipChecker();
}

export { MEMBERSHIP_CHECKER };
