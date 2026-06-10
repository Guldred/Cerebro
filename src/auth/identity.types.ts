/**
 * Caller identity model (Plan_Review P1.1/P1.2). A CallerIdentity is minted by
 * IdentityService and NOWHERE else — retrieval and RAG take it instead of a raw
 * principals array, so a consumer that bypasses identity resolution cannot
 * compile. The principal strings are namespaced to prevent collisions between
 * Entra-derived, source-native and reserved principals:
 *
 *   entra-user:<oid>      the authenticated user (from the validated token)
 *   entra-group:<gid>     a transitive Entra security group (from the token)
 *   public                reserved: content visible to everyone (even anonymous)
 *   all-users             reserved: content visible to any AUTHENTICATED caller
 *   confluence-… github-… source-native, only ever stored on chunks; reach a
 *                         caller exclusively via the principal_mappings table
 */
export interface CallerIdentity {
  /** Stable subject — Entra `oid` in oidc modes, a synthetic id in dev-header. */
  readonly subject: string;
  /** The principals this caller holds, namespaced as above. Never empty in
   *  oidc modes (always contains at least entra-user:<oid>). */
  readonly principals: readonly string[];
  /** Which AUTH_MODE minted this identity. */
  readonly mode: 'dev-header' | 'local-oidc' | 'oidc';
}

export type IdentityErrorCode =
  /** No bearer token where one is required. */
  | 'TOKEN_MISSING'
  /** Signature/issuer/audience/exp validation failed. */
  | 'TOKEN_INVALID'
  /** Entra groups overage: token does not carry the full group list and no
   *  Graph resolver is configured — a partial group set is indistinguishable
   *  from a lookup failure, so we hard-fail (fail-closed). */
  | 'GROUPS_UNRESOLVED'
  /** A path that requires an end-user identity (MCP in oidc mode) has none. */
  | 'IDENTITY_REQUIRED';

export class IdentityError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

export const ENTRA_USER_PREFIX = 'entra-user:';
export const ENTRA_GROUP_PREFIX = 'entra-group:';
/** Reserved pseudo-principal: any authenticated caller (P1.1 "ALL_USERS"). */
export const ALL_USERS_PRINCIPAL = 'all-users';

/** MVP identity stub header — only read in dev-header mode. */
export const PRINCIPALS_HEADER = 'x-cerebro-principals';
