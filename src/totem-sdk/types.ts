/**
 * @dreamshare/totem-sdk — framework-agnostic delegation mint + verify.
 *
 * This module is the "algorithm lift" from docs/Totem_Integration.md (§1/§5,
 * Decisions A/B/H): Totem's pure attenuation logic (command narrowing +
 * AND-composed policy) ported verbatim onto a JWT/JOSE substrate, with the
 * RFC 8693 actor-claim token shape (`sub`=human, `act`={sub:agent}) enriched by
 * OIDC-A agent-identity vocabulary as descriptive claims.
 *
 * It is deliberately dependency-light — only `jose`, which Cerebro already ships
 * — and contains NO NestJS / Cerebro imports, so it can be lifted out into the
 * standalone `@dreamshare/totem-*` repo unchanged. The NestJS wiring and the
 * per-call policy hook live in Cerebro (src/auth/delegation/).
 *
 * Phase-1 model (Decision H = bearer + mint-asserted): a single delegated bearer
 * JWT carries the human (`sub`/`oid`/`groups`), the agent (`act.sub`), and the
 * NET effective scope (`delegation.cmd`/`pol`/`principals_allow`) — the mint has
 * already computed the multi-hop attenuation intersection. Verification is
 * signature + issuer + audience + expiry (the same JOSE validation Cerebro
 * already trusts) followed by the lifted attenuation checks. There is no
 * per-call holder-of-key proof in this model — that is Decision H (b)/(c).
 */
import type { JWTPayload } from 'jose';

// ---------------------------------------------------------------------------
// Policy model (thin UCAN `pol` profile, ported from totem-core; JSON args)
// ---------------------------------------------------------------------------

/** A dot-path into the invocation args, e.g. `.sourceSystems`, `.meta.x`, `.` = whole args. */
export type Selector = string;

/** Values expressible in a JSON invocation-args object. */
export type PolicyValue =
  | string
  | number
  | boolean
  | null
  | PolicyValue[]
  | { [key: string]: PolicyValue };

export type Args = Record<string, PolicyValue>;

/**
 * A policy predicate. Predicates compose by logical AND across the (already
 * mint-flattened) grant, which is what makes attenuation "by construction": the
 * verifier evaluates every predicate, so a request that violates any one is
 * denied. Selectors are own-property-only dot-paths (prototype-pollution safe).
 */
export type Predicate =
  | readonly ['==', Selector, PolicyValue]
  | readonly ['!=', Selector, PolicyValue]
  | readonly ['<=', Selector, number]
  | readonly ['<', Selector, number]
  | readonly ['>=', Selector, number]
  | readonly ['>', Selector, number]
  | readonly ['in', Selector, readonly PolicyValue[]]
  | readonly ['like', Selector, string]
  | readonly ['and', readonly Predicate[]]
  | readonly ['or', readonly Predicate[]]
  | readonly ['not', Predicate];

// ---------------------------------------------------------------------------
// Token claim shape (RFC 8693 actor model + OIDC-A vocabulary)
// ---------------------------------------------------------------------------

/** RFC 8693 §4.1 actor claim. Nested `act` represents a multi-hop delegation chain (audit trail). */
export interface ActorClaim {
  sub: string;
  act?: ActorClaim;
}

/** The NET effective grant the mint emits (multi-hop intersection already computed). */
export interface DelegationGrant {
  /** Totem command path the agent may invoke, e.g. `/cerebro/search`. */
  cmd: string;
  /** SCALAR policy predicates (AND-composed) constraining scalar invocation args (e.g. `topK <= 10`). */
  pol?: readonly Predicate[];
  /**
   * OPTIONAL strict subset of the human's principals the agent may use (never
   * widens). Enforced as a SET INTERSECTION in Cerebro's enforcement layer, not
   * as a `pol` predicate (the lifted policy is scalar).
   */
  principals_allow?: readonly string[];
  /**
   * OPTIONAL strict subset of source systems the agent may read (e.g.
   * `["confluence"]`). Enforced as a set intersection with the requested
   * `sourceSystems` in Cerebro's enforcement layer.
   */
  sources_allow?: readonly string[];
}

/** The delegated-token JWT payload. Extends jose's JWTPayload (iss/sub/aud/exp/nbf/iat/jti). */
export interface DelegationClaims extends JWTPayload {
  /** Human directory object id — Cerebro keys entitlement off THIS (not the JWT `sub`). */
  oid?: string;
  /** Human's transitive security groups (entitlement axis). */
  groups?: string[];
  /** The agent acting on the human's behalf. Presence ⇒ this is a delegated call. */
  act?: ActorClaim;
  /** OAuth coarse scope grant. */
  scope?: string;
  /** Net effective Totem grant (narrowing axis). */
  delegation?: DelegationGrant;
  // OIDC-A descriptive agent identity (audit/attestation only — never resolution keys):
  agent_instance_id?: string;
  agent_model?: string;
  agent_provider?: string;
}

// ---------------------------------------------------------------------------
// Pluggable backends (interfaces only — Cerebro supplies durable impls)
// ---------------------------------------------------------------------------

export interface RevocationStatus {
  revoked: boolean;
  /** Coarse freshness handle (ISO string or opaque epoch). */
  asOf?: string;
}

/** Negative-list revocation lookup. Generalized by AttestationAnchor below. */
export interface RevocationRegistry {
  isRevoked(namespace: string, id: string): Promise<RevocationStatus>;
}

/** Single-use id store for replay protection (only meaningful under Decision H b/c PoP). */
export interface NonceStore {
  /** Returns `true` if `nonce` was unseen (and is now recorded), `false` on replay. */
  checkAndSet(nonce: string): Promise<boolean> | boolean;
}

/** An authorization decision, recorded append-only for audit. No raw secrets. */
export interface AuthorizationDecisionRecord {
  ts: string;
  subject?: string;
  actor?: string;
  action: string;
  argsDigest?: string;
  decision: 'allow' | 'deny' | 'needs-approval';
  reasons: string[];
  delegationId?: string;
}

/**
 * The audit/anchor sink (docs/Totem_Integration.md §6). Default impl is a local
 * append-only log; the optional on-chain backend plugs in behind the same shape.
 * It also answers revocation reads, so it subsumes RevocationRegistry.
 */
export interface AttestationAnchor extends RevocationRegistry {
  /** Append-only record of a decision. MUST fail-closed (never throw the request open). */
  record(rec: AuthorizationDecisionRecord): Promise<{ handle: string }>;
}

// ---------------------------------------------------------------------------
// verify/mint shapes
// ---------------------------------------------------------------------------

/** The capability being invoked — required to enforce delegated scope. */
export interface InvokedAction {
  /** Totem command path, e.g. `/cerebro/search`. */
  cmd: string;
  /** Concrete invocation args evaluated against the grant's policy. */
  args?: Args;
}

export interface DelegationResult {
  ok: boolean;
  /** Machine-readable failure codes (empty when ok). */
  reasons: string[];
  /** The human principal — downstream entitlement resolves off `oid`. */
  human?: { oid: string; sub?: string; groups: string[] };
  /** The agent acting on the human's behalf (audit + narrowing only). */
  agent?: string;
  scope?: string;
  /** Net effective principal allow-list (strict subset), when the grant narrows it. */
  principalsAllow?: string[];
  /** Net effective source-system allow-list (strict subset), when the grant narrows it. */
  sourcesAllow?: string[];
  /** The net effective grant, surfaced so the enforcement stage can authorize the action. */
  grant?: DelegationGrant;
  /** Stable delegation id (`jti`) for audit + revocation. */
  delegationId?: string;
  /** Whether an `act` claim was present (i.e. this was a delegated call). */
  delegated: boolean;
}

/** The outcome of authorizing a concrete action against a grant (the enforcement stage). */
export interface ActionDecision {
  ok: boolean;
  reasons: string[];
}
