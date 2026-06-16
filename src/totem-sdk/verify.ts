/**
 * Delegation verification (docs/Totem_Integration.md §3.2), split into the two
 * stages Cerebro's architecture needs:
 *
 *   1. verifyDelegationToken(token, opts)  — JOSE signature/issuer/audience/expiry
 *      (the same validation Cerebro already trusts) + human identity (keyed off
 *      `oid`) + TTL cap + revocation + optional replay. Has NO action context, so
 *      it runs in IdentityService (the single mint point), which does not see the
 *      invoked tool/args. Surfaces the net `grant` for stage 2.
 *
 *   2. authorizeAction(grant, action)      — pure command-narrowing + AND-policy
 *      over the concrete invocation. Runs at the enforcement point
 *      (RetrievalService / the MCP PDP), which DOES know the action.
 *
 * verifyDelegation(token, opts+action) composes both for a single-shot,
 * framework-agnostic consumer (and the SDK's own tests). Everything fails closed.
 */
import { jwtVerify, type JWK, type JWTVerifyGetKey, type JWTVerifyOptions, type KeyLike } from 'jose';
import { commandPermits } from './command';
import { evaluatePolicy } from './policy';
import type {
  ActionDecision,
  Args,
  DelegationClaims,
  DelegationGrant,
  DelegationResult,
  InvokedAction,
  NonceStore,
  RevocationRegistry,
} from './types';

/** JOSE key input — a key, a `Uint8Array`, a `JWK`, or a JWKS key-getter (createRemoteJWKSet/createLocalJWKSet). */
export type KeyInput = KeyLike | Uint8Array | JWK | JWTVerifyGetKey;

/** Stage-1 options: token verification only — no action. */
export interface VerifyTokenOptions {
  keys: KeyInput;
  issuer: string | string[];
  audience: string | string[];
  /** Pinned signature algorithms. Default ['RS256','EdDSA'] — never `none`/HS*. */
  algorithms?: string[];
  clockToleranceS?: number;
  /** Cap on token lifetime (`exp - iat`) in seconds. */
  maxTtlS?: number;
  /** Revocation source (the AttestationAnchor or a RevocationRegistry). */
  registry?: RevocationRegistry;
  /** Replay store (only meaningful under Decision H b/c proof-of-possession). */
  nonceStore?: NonceStore;
  /** Injectable clock (Unix seconds) for tests. */
  nowS?: number;
}

/** Single-shot options: token verification AND action authorization. */
export interface VerifyDelegationOptions extends VerifyTokenOptions {
  /** The capability being invoked — required to enforce delegated scope. */
  action: InvokedAction;
}

const DEFAULT_ALGS = ['RS256', 'EdDSA'];

/**
 * Stage 1 — verify the delegated token (no action). Returns the resolved human +
 * agent + net grant, or a fail-closed deny. `delegated:false` means the token
 * carried no `act` claim (a plain bearer token), in which case there is no grant
 * to enforce downstream.
 */
export async function verifyDelegationToken(
  token: string,
  opts: VerifyTokenOptions,
): Promise<DelegationResult> {
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);

  const verifyOptions: JWTVerifyOptions = {
    issuer: opts.issuer,
    audience: opts.audience,
    algorithms: opts.algorithms ?? DEFAULT_ALGS,
    clockTolerance: opts.clockToleranceS ?? 0,
    // jose only validates exp WHEN present — require it so a signed token missing
    // exp is not accepted forever (matches OidcTokenVerifier).
    requiredClaims: ['exp'],
    currentDate: new Date(now * 1000),
  };

  let payload: DelegationClaims;
  try {
    // jwtVerify is overloaded: a key/JWK form and a key-getter form. Branch so
    // both a direct key (tests) and a JWKS getter (Cerebro) typecheck.
    const res =
      typeof opts.keys === 'function'
        ? await jwtVerify(token, opts.keys, verifyOptions)
        : await jwtVerify(token, opts.keys, verifyOptions);
    payload = res.payload as DelegationClaims;
  } catch (err) {
    return { ok: false, reasons: [`token/invalid: ${String(err)}`], delegated: false };
  }

  const reasons: string[] = [];

  // Human identity — keyed off `oid` (matches Cerebro's existing path), never `act`.
  const oid = typeof payload.oid === 'string' && payload.oid.length > 0 ? payload.oid : undefined;
  if (!oid) reasons.push('token/no-oid');
  const groups = Array.isArray(payload.groups)
    ? payload.groups.filter((g): g is string => typeof g === 'string')
    : [];
  const human = oid
    ? { oid, sub: typeof payload.sub === 'string' ? payload.sub : undefined, groups }
    : undefined;

  const delegated = payload.act !== undefined;
  if (!delegated) {
    // A plain (non-delegated) bearer token: valid identity, no scope to enforce.
    return { ok: reasons.length === 0, reasons, human, delegated: false };
  }

  // --- delegated token: verify the credential (NOT the action — that is stage 2) ---
  const agent = payload.act?.sub;
  if (typeof agent !== 'string' || agent.length === 0) reasons.push('act/no-sub');

  // TTL cap (short by design — the bearer replay window).
  if (opts.maxTtlS !== undefined && typeof payload.exp === 'number') {
    const start =
      typeof payload.iat === 'number'
        ? payload.iat
        : typeof payload.nbf === 'number'
          ? payload.nbf
          : now;
    if (payload.exp - start > opts.maxTtlS) reasons.push('token/ttl-too-long');
  }

  const grant = payload.delegation;
  if (!grant || typeof grant.cmd !== 'string') reasons.push('delegation/missing-grant');

  // Revocation — namespaced by the root subject. Fail-closed: a registry with no
  // id to check denies rather than silently allowing.
  const jti = typeof payload.jti === 'string' ? payload.jti : undefined;
  if (opts.registry) {
    if (!jti) {
      reasons.push('delegation/no-jti-for-revocation');
    } else {
      const ns = (typeof payload.sub === 'string' && payload.sub) || oid || '';
      const status = await opts.registry.isRevoked(ns, jti);
      if (status.revoked) reasons.push('delegation/revoked');
    }
  }

  // Replay (Decision H b/c only — present when a nonce store is wired).
  if (opts.nonceStore && jti) {
    const fresh = await opts.nonceStore.checkAndSet(jti);
    if (!fresh) reasons.push('delegation/replayed');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    human,
    agent: typeof agent === 'string' ? agent : undefined,
    scope: typeof payload.scope === 'string' ? payload.scope : undefined,
    principalsAllow: grant?.principals_allow ? [...grant.principals_allow] : undefined,
    sourcesAllow: grant?.sources_allow ? [...grant.sources_allow] : undefined,
    grant: grant && typeof grant.cmd === 'string' ? grant : undefined,
    delegationId: jti,
    delegated: true,
  };
}

/**
 * Stage 2 — pure authorization of a concrete action against a verified grant:
 * command narrowing (`commandPermits`) + AND-composed scalar policy. Total and
 * fail-closed (a missing/invalid grant denies). Array-valued narrowing
 * (sources/principals) is a SET INTERSECTION done by the caller, not here.
 */
export function authorizeAction(grant: DelegationGrant | undefined, action: InvokedAction): ActionDecision {
  const reasons: string[] = [];
  if (!grant || typeof grant.cmd !== 'string') {
    return { ok: false, reasons: ['delegation/missing-grant'] };
  }
  if (!commandPermits(grant.cmd, action.cmd)) reasons.push('delegation/command-not-permitted');
  if (evaluatePolicy(grant.pol ?? [], action.args ?? ({} as Args)).length > 0) {
    reasons.push('delegation/policy-unsatisfied');
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Single-shot verify: token verification (stage 1) AND, for a delegated token,
 * action authorization (stage 2) merged into one result. For framework-agnostic
 * consumers and the SDK's own tests; Cerebro uses the two stages separately.
 */
export async function verifyDelegation(
  token: string,
  opts: VerifyDelegationOptions,
): Promise<DelegationResult> {
  const result = await verifyDelegationToken(token, opts);
  if (!result.delegated) return result;
  const action = authorizeAction(result.grant, opts.action);
  if (action.ok) return result;
  return { ...result, ok: false, reasons: [...result.reasons, ...action.reasons] };
}
