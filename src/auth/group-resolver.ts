import { CerebroConfig } from '../config/config';

/**
 * Resolves the FULL transitive group set for a user when the Entra access token
 * signals groups overage (the `groups` claim was omitted because the user is in
 * too many groups). The contract is strict and fail-closed:
 *
 *   - returns EXACTLY the set a NON-overage token would have carried for that
 *     user (see the securityEnabledOnly parity note on the Graph impl), and
 *   - THROWS on any failure — a partial or failed resolution must never become a
 *     partial principal set, so IdentityService maps a throw to the same hard
 *     GROUPS_UNRESOLVED (403) as having no resolver at all.
 */
export interface GroupResolver {
  /** Full transitive group object-ids for the user `oid`. Throws on any failure. */
  resolveGroups(oid: string): Promise<string[]>;
}

export const GROUP_RESOLVER = Symbol('GROUP_RESOLVER');

type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export type GraphGroupResolverConfig = CerebroConfig['auth']['graph'];

const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Microsoft Graph–backed {@link GroupResolver} (the documented escape hatch for
 * Entra groups overage). On overage it calls
 * `POST /v1.0/users/{oid}/getMemberGroups` with an app (client-credentials)
 * token and returns the flat, transitive list of group object-ids — which match
 * the `groups`-claim format Cerebro already maps to `entra-group:<gid>`.
 *
 * PARITY INVARIANT (security-critical): the resolved set must equal what a
 * non-overage token would have carried. `securityEnabledOnly` therefore MUST
 * mirror the tenant's `groupMembershipClaims` manifest setting:
 *   - `true`  → security groups only (matches `groupMembershipClaims:"SecurityGroup"`, the common case).
 *   - `false` → ALL groups AND directory roles (matches `"All"`).
 * A mismatch is a two-way bug: a subset silently under-serves overage users; a
 * SUPERSET leaks principals (e.g. M365/distribution groups or directory roles)
 * to exactly the >200-group population that is hardest to eyeball. Default
 * `true`; document the manifest it must match.
 *
 * getMemberGroups returns the WHOLE set in one response (up to 11,000 ids; more
 * than that is a `400 Directory_ResultSizeLimitExceeded`) — there is no
 * pagination, so there is no partial-page fail-open: any non-200 simply throws.
 */
export class GraphGroupResolver implements GroupResolver {
  private readonly baseUrl: string;
  private readonly authority: string;
  private appToken: { value: string; expiresAt: number } | null = null;
  private readonly cache = new Map<string, { groups: string[]; at: number }>();

  constructor(
    private readonly config: GraphGroupResolverConfig,
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
  ) {
    this.baseUrl = (config.baseUrl?.trim() || 'https://graph.microsoft.com').replace(/\/$/, '');
    this.authority = (config.authority?.trim() || 'https://login.microsoftonline.com').replace(/\/$/, '');
  }

  async resolveGroups(oid: string): Promise<string[]> {
    const ttl = this.config.cacheTtlMs;
    if (ttl > 0) {
      const hit = this.cache.get(oid);
      if (hit && Date.now() - hit.at < ttl) return hit.groups;
    }
    const groups = await this.getMemberGroups(oid, await this.appAccessToken());
    if (ttl > 0) this.cache.set(oid, { groups, at: Date.now() });
    return groups;
  }

  /** App-only (client-credentials) token, cached until shortly before expiry —
   *  re-acquiring per request would throttle the token endpoint. */
  private async appAccessToken(): Promise<string> {
    if (this.appToken && Date.now() < this.appToken.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.appToken.value;
    }
    const url = `${this.authority}/${encodeURIComponent(this.config.tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: `${this.baseUrl}/.default`,
    }).toString();
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`Graph token endpoint ${res.status}: ${await safeText(res)}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('Graph token endpoint returned no access_token');
    this.appToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.appToken.value;
  }

  private async getMemberGroups(oid: string, token: string): Promise<string[]> {
    const url = `${this.baseUrl}/v1.0/users/${encodeURIComponent(oid)}/getMemberGroups`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ securityEnabledOnly: this.config.securityEnabledOnly }),
    });
    // Any non-200 — 400 ResultSizeLimitExceeded (>11k groups), 429 throttling,
    // 403 missing GroupMember.Read.All, 5xx — throws → IdentityService 403s.
    if (!res.ok) throw new Error(`Graph getMemberGroups ${res.status}: ${await safeText(res)}`);
    const json = (await res.json()) as { value?: unknown };
    if (!Array.isArray(json.value)) throw new Error('Graph getMemberGroups returned no value array');
    return json.value.filter((g): g is string => typeof g === 'string');
  }
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * Config-driven selection of the overage group resolver (extracted so the
 * env→resolver wiring is unit-testable without booting Nest). Default `none`
 * preserves the fail-closed hard-403-on-overage behavior exactly.
 */
export function selectGroupResolver(config: CerebroConfig): GroupResolver | null {
  return config.auth.groupResolver === 'graph' ? new GraphGroupResolver(config.auth.graph) : null;
}
