/**
 * mintDelegation — the agent-client / STS entry point (docs/Totem_Integration.md
 * §3.3). Produces a single delegated bearer JWT (RFC 8693 actor shape) carrying
 * the human, the agent, and the NET effective grant. In production a capable IdP
 * / token-exchange STS mints this; in dev/local/tests the Totem mint does
 * (config-only trust-root swap, mirroring AUTH_MODE=local-oidc).
 *
 * The caller is responsible for having ALREADY computed the net grant as a
 * subset of the human's authority — this function asserts the command is
 * well-formed but does not itself re-derive the human's entitlements (that is
 * the resource server's job, via the unchanged ACL pre-filter).
 */
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { isValidCommand } from './command';
import type { DelegationClaims, DelegationGrant } from './types';

/** Signing key — a private `KeyLike` (CryptoKey) or an HMAC `Uint8Array` (tests/dev only). */
export type SignKey = Parameters<InstanceType<typeof SignJWT>['sign']>[0];

export interface MintDelegationOptions {
  signKey: SignKey;
  /** Signature algorithm. Default 'RS256' (matches the existing local IdP). */
  alg?: string;
  kid?: string;
  issuer: string;
  audience: string;
  /** Human directory object id (entitlement key). */
  humanOid: string;
  /** JWT `sub`. Defaults to `humanOid` so the human is unambiguous. */
  humanSub?: string;
  groups?: string[];
  /** The agent acting on the human's behalf (`act.sub`). */
  agent: string;
  /** Net effective grant (the mint has already intersected the chain). */
  grant: DelegationGrant;
  scope?: string;
  agentInstanceId?: string;
  agentModel?: string;
  agentProvider?: string;
  /** Token lifetime in seconds. Default 300 (short by design). */
  expiresInS?: number;
  /** Delegation id — required for revocation. Defaults to a fresh UUID. */
  jti?: string;
  /** Injectable clock (Unix seconds) for tests. */
  nowS?: number;
}

export async function mintDelegation(opts: MintDelegationOptions): Promise<string> {
  if (!isValidCommand(opts.grant.cmd)) {
    throw new Error(`mintDelegation: invalid grant cmd ${JSON.stringify(opts.grant.cmd)}`);
  }
  const alg = opts.alg ?? 'RS256';
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  const ttl = opts.expiresInS ?? 300;
  const jti = opts.jti ?? randomUUID();

  const payload: DelegationClaims = {
    oid: opts.humanOid,
    act: { sub: opts.agent },
    delegation: opts.grant,
  };
  if (opts.groups !== undefined) payload.groups = opts.groups;
  if (opts.scope !== undefined) payload.scope = opts.scope;
  if (opts.agentInstanceId !== undefined) payload.agent_instance_id = opts.agentInstanceId;
  if (opts.agentModel !== undefined) payload.agent_model = opts.agentModel;
  if (opts.agentProvider !== undefined) payload.agent_provider = opts.agentProvider;

  const header: { alg: string; kid?: string } = { alg };
  if (opts.kid !== undefined) header.kid = opts.kid;

  return new SignJWT(payload)
    .setProtectedHeader(header)
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setSubject(opts.humanSub ?? opts.humanOid)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setJti(jti)
    .sign(opts.signKey);
}
