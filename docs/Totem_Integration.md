# Totem → Cerebro Integration — Design (Phase 0)

> **Status: DESIGN — awaiting review. No implementation code has been written.**
> This document is the Phase-0 deliverable required by [`docs/totem_cerebro_integration_prompt.md`](totem_cerebro_integration_prompt.md).
> It ends with **§12 Decisions I need from you** — please read that section first if you are short on time.

Goal: fold Totem's *delegation / attenuation / verification* logic into Cerebro so the combined system is a product — **safe, verifiable, delegated agent access to enterprise data**. Cerebro stays the reference resource server; Totem becomes a standards-aligned delegation layer Cerebro consumes. The blockchain is **not** in the core and **not** in the hot path.

This design is grounded in a full read of both repos (file:line citations throughout) and in the *primary* standards texts (RFC 8693, RFC 9728, the OIDC-A proposal, the AuthZEN COAZ/AARP drafts). Where the brief's assumptions diverge from repo reality or from the actual specs, I flag it inline as **⚠ Reality check** and collect the open decisions in §12.

---

## 1. TL;DR for the reviewer

- **Cerebro is already shaped for this.** Identity is minted in exactly one place ([`IdentityService.resolve`](../src/auth/identity.service.ts) — REST guard, MCP, eval all funnel through it), entitlement is a hard SQL pre-filter (`acl_principals && $principals`), and the MCP per-call choke point (`resolveOrReject`) already returns an allow/deny shape. The delegation verifier slots into the single path; the per-call PDP slots into the single choke point. **No second, bypassable path is introduced.**
- **Totem's reusable gold is its *algorithm*, not its substrate.** The *narrowing / policy / time-window* logic (`commandPermits`, `evaluatePolicy`, the chain intersection in `verifyInvocation`) is **pure logic over plain JS objects** with **no** codec imports. The UCAN/`did:key`/DAG-CBOR substrate touches `verifyInvocation` at only **two seams** — proof-chain resolution and the revocation lookup, both via `delegationCid` (a CID). Those are exactly the seams the JWT lift re-points at a `jti`/digest proof reference (§5).
- **Central recommendation:** mint/verify delegations as **JWTs** (RFC 8693 actor-claim shape, verified with Cerebro's existing `jose` stack), and **lift Totem's verification algorithm onto that JWT substrate** rather than consume Totem's ESM-only UCAN core wholesale. This satisfies "reuse Cerebro's OIDC validation," keeps Cerebro CommonJS and synchronous, avoids a second crypto trust root, and keeps the SDK thin and dependency-light. The trade-off (we re-port the algorithm + tests instead of `import`-ing the 45-test core) is real and is **Decision A** in §12.
- **⚠ The brief conflates two standards.** It says "shape claims after **OIDC-A**, with `sub`=human / `act`=agent." But the *actual* OIDC-A proposal uses `sub`=**agent** + `delegator_sub`/`delegation_chain` and defines **no `act` claim** — using it literally would *violate* Cerebro's hard invariant #2 (resolution keys off the human `sub`). The `sub`=human / `act`=agent model is **RFC 8693 token-exchange** (a stable RFC). Recommendation: RFC 8693 `act` as the canonical resolution-bearing shape; borrow OIDC-A's *agent-identity vocabulary* (`agent_instance_id`, `agent_attestation`, …) as descriptive claims only. **Decision B** in §12.
- **The chain demotion is threat-*justified* in Cerebro's trust domain**, not merely tolerated — see §8.

---

## 2. What each repo actually is (grounding)

### 2.1 Cerebro (the resource server)
- **Stack:** NestJS / TypeScript, **CommonJS** (`tsconfig.json` `module=commonjs`; no `"type"` in `package.json`), Postgres + pgvector, **`jose@5`** (v6 is ESM-only and broke this CJS repo).
- **Single identity path (verified):** [`IdentityService.resolve`](../src/auth/identity.service.ts:45) is the **sole** `CallerIdentity` mint. The REST [`AuthGuard`](../src/auth/auth.guard.ts:55), the MCP [`McpIdentityProvider`](../src/mcp/mcp-identity.ts:28), and the [eval harness](../src/scripts/eval.ts) all call it. `CallerIdentity = { subject, principals[], mode }` ([identity.types.ts:15](../src/auth/identity.types.ts:15)).
- **Token validation:** [`OidcTokenVerifier`](../src/auth/token-verifier.ts:42) — `jose.jwtVerify`, **RS256-pinned**, validates `issuer`/`audience`/`exp`, JWKS remote (oidc) or local file (local-oidc). Extracts `oid` + `groups` and *flags* groups-overage (`hasOverage`); [`IdentityService.fromBearer`](../src/auth/identity.service.ts:64) converts that flag into a fail-closed `GROUPS_UNRESOLVED`.
- **Enforcement point:** [`RetrievalService.search`](../src/retrieval/retrieval.service.ts:45). Query-time principal expansion via [`PrincipalMappingService.expand`](../src/retrieval/principal-mapping.service.ts:35) (unmapped source principal = invisible, never public; revocation = row DELETE), then the **hard SQL pre-filter** `acl_principals && $principals::text[]` applied **inside both** the vector and FTS CTE legs ([retrieval.service.ts:79-84,105,112](../src/retrieval/retrieval.service.ts:79)). A non-dev-header identity with an empty principal set **throws** rather than degrading to public-only ([:54-56](../src/retrieval/retrieval.service.ts:54)).
- **MCP boundary:** two tools, `cerebro_query` and `cerebro_search` ([mcp-tools.ts:97,118](../src/mcp/mcp-tools.ts:97)). Per-call identity resolves at **`resolveOrReject`** ([mcp-tools.ts:73](../src/mcp/mcp-tools.ts:73)), the first line of both handlers, returning `{identity} | {error: CallToolResult}`. In oidc mode the user token is re-read + re-verified from `MCP_USER_TOKEN_FILE` (0600-enforced) on **every** call ([mcp-identity.ts:43-63](../src/mcp/mcp-identity.ts:43)). **Tokens never travel as tool arguments** — the schema has no token field, and a stray `principals` arg in oidc mode is loudly rejected.
- **Config + boot:** all env access in [`config.ts`](../src/config/config.ts); `assertBootInvariants` makes insecure combinations **unbootable** (e.g. production requires `AUTH_MODE=oidc`, `ACL_ENFORCED=true`, https issuer/JWKS, no local JWKS file). New flags must mirror this pattern.
- **Eval harness:** [`eval.ts`](../src/scripts/eval.ts) boots the real app, runs `eval/gold.json` cases through the real retrieval/RAG against live pgvector. A leak (`forbiddenDocIds ∩ retrieved`) is a **hard, non-absorbable** failure (exit 1). A **presence control** prevents vacuous passes; a **schema tripwire** guards the `principal_mappings` CHECK constraints. CI runs it twice — `dev-header` and `EVAL_AUTH=local-oidc` (mints real per-case RS256 JWTs offline via [token-factory](../src/auth/testing/token-factory.ts)).

### 2.2 Totem (the delegation layer)
- **Stack:** pnpm/turbo monorepo, **pure ESM** (`"type":"module"`), vitest. Status: `@dreamshare/totem-core` is built + adversarially-hardened (45 tests); TEE provider, Solidity contract, and demo were originally deferred but a `demo-agent`/`demo-resource-server` pair now exists.
- **`@dreamshare/totem-core`** — a thin UCAN v1.0 profile. `Delegation`/`Invocation`/`Revocation` payloads (`iss`/`aud`/`sub`/`cmd`/`pol`/`exp`, [types.ts:63-117](../../Totem/packages/totem-core/src/types.ts)), Ed25519 over canonical DAG-CBOR, `did:key`, CID-addressed proofs.
  - **`verifyInvocation`** ([chain.ts:72-209](../../Totem/packages/totem-core/src/chain.ts:72)) — the validator: invocation signature/freshness/replay/audience → proof resolution (reject unresolved CID) → per-delegation signatures → principal alignment + **holder-key chaining** (`aud(parent)==iss(child)`) → **command narrowing** → **time-window intersection** (`max(nbf)…min(exp)`) → **AND-composed policy** → revocation. Fail-closed: required checks denied unless explicitly `skipChecks`.
  - **`commandPermits`** ([command.ts:51](../../Totem/packages/totem-core/src/command.ts:51)) hierarchical path narrowing with path-escape rejection; **`evaluatePolicy`** ([policy.ts:158](../../Totem/packages/totem-core/src/policy.ts:158)) fail-closed predicates, ReDoS-safe glob, prototype-pollution-guarded selectors. **Both are pure — no codec imports.**
  - **`RevocationRegistry`** + `NonceStore` + `SpendLedger` are **injected interfaces** with in-memory mocks ([revocation.ts](../../Totem/packages/totem-core/src/revocation.ts), [accounting.ts](../../Totem/packages/totem-core/src/accounting.ts)). Accounting is **keyed by the root `sub`** (not the leaf) so a compromise can't fan out for N× the cap. **The chain is already behind an interface** — the demotion the brief wants is half-done.
  - **Runtime deps (all 4 ESM-only):** `@ipld/dag-cbor`, `@noble/ed25519`, `@noble/hashes`, `multiformats`.
- **`@dreamshare/totem-sdk`** — `verifyRequest` = `verifyInvocation` + an attestation/trust-tier gate ([verify.ts](../../Totem/packages/totem-sdk/src/verify.ts)); plus DAG-CBOR wire (de)serialization. No third-party runtime deps (workspace refs only).
- **`@dreamshare/totem-attestation`** — TEE trust-tier model (`tee-hardware > os-bound > self-asserted > tee-software-sim`) + `AttestationProvider` interface; only the honest `no-TEE` provider ships (self-asserted = proves instance-key possession only). **Framework-neutral.** *This is a different concern from the brief's `AttestationAnchor` (audit sink) — see §6.*
- **Threat model:** [`DESIGN.md` §13](../../Totem/docs/DESIGN.md), T1–T10, each with an honest residual. On-chain footprint = exactly two contracts (identity anchor + revocation/status registry); everything else off-chain.

---

## 3. The token / credential model

### 3.1 The claim shape (recommended)

A delegated access token is a **JWT (JWS)** carrying the **RFC 8693 actor-claim** model, enriched with **OIDC-A agent-identity claims** as descriptive metadata:

```jsonc
{
  // --- standard OIDC/Entra claims Cerebro ALREADY consumes (entitlement axis) ---
  "iss": "https://login.microsoftonline.com/<tenant>/v2.0",  // or the Totem mint issuer in dev/local
  "aud": "api://cerebro",                                     // RFC 9728 resource identifier (hard-checked today)
  "sub": "<human-oid>",                                       // the HUMAN subject; set equal to oid so the human is unambiguous
  "oid": "<human-oid>", "groups": ["<gid>", ...],            // human entitlements — resolution keys off OID (existing path, UNCHANGED)
  "exp": 1750000000, "nbf": 1749999000,

  // --- delegation axis (RFC 8693) ---
  "act": { "sub": "agent:acme-copilot/instance-7" },         // the AGENT acting for the human; nested for multi-hop
  "scope": "cerebro.search",                                  // OAuth scope (coarse action grant)

  // --- attenuation detail (Totem cmd/pol, OIDC-A-aligned) ---
  "delegation": {                                            // NET effective scope (mint computed the chain intersection)
    "cmd": "/cerebro/search",                                 // Totem command path — narrows the action
    "pol": [ ["in", ".sourceSystems", ["confluence"]] ],     // Totem policy — constrains the request args
    "principals_allow": ["entra-group:hr"]                    // OPTIONAL strict principal-subset narrowing
  },

  // --- OIDC-A descriptive agent identity (audit/attestation only; NOT resolution keys) ---
  "agent_instance_id": "acme-copilot/instance-7",
  "agent_model": "claude-opus-4-8", "agent_provider": "acme",
  "agent_attestation": { "format": "urn:ietf:params:oauth:token-type:eat", "token": "..." }  // optional, post-MVP
}
```

- **`sub` is the human.** ⚠ Precisely: Cerebro keys entitlement off the **`oid`** claim ([identity.service.ts:71](../src/auth/identity.service.ts:71), [token-verifier.ts:62](../src/auth/token-verifier.ts:62)) — *not* the JWT `sub` (in Entra v2 `sub` is a pairwise per-app identifier, distinct from the directory `oid`). The delegated token sets `sub`=`oid`=`<human-oid>` so the human is unambiguous either way; invariant #2 forbids resolving off the agent.
- **`act.sub` is the agent**, used only for (a) audit and (b) *narrowing*. Multi-hop chains use **nested `act`** (RFC 8693 §4.1) for the actor trail; the mint computes the attenuation intersection across hops and emits the **net effective** `cmd`/`pol`/`principals_allow` above. (Per-hop, RP-verified *signed* proofs — a `prf`-style chain — are **Decision H option (c)**, not the default. One chain representation, not two.)
- **Effective entitlement = `human_entitlements ∩ delegated_scope`**, a strict intersection (§4).

### 3.2 How it is verified
1. **Signature / issuer / audience / expiry** — by Cerebro's existing `jose` verifier, extended to accept the configured **delegation issuer** (the Totem mint in dev/local; the IdP's token-exchange STS in production). Algorithms stay pinned; `aud` stays hard-checked.
2. **Human identity** — extract `sub`/`oid`/`groups` exactly as today → human principals (unchanged path, unchanged invariants).
3. **Delegation** — if an `act` claim is present, enforce the **net effective scope** with the lifted Totem algorithm: command narrowing (`commandPermits`), AND-policy (`evaluatePolicy`), time-window, and revocation. In the recommended **bearer / mint-asserted** model (Decision H), the chain's hop-by-hop attenuation was verified and signed by the mint; Cerebro re-checks the net scope + the mint signature. (Per-hop holder-key chaining and per-call replay nonces apply only under Decision H (b)/(c).) Malformed / expired / wrong-audience / over-widening → **fail-closed deny**.
4. **Intersection** — §4.

### 3.3 Transport (closes the exfiltration channel)
- **REST:** `Authorization: Bearer <delegated-JWT>` — same header as today.
- **MCP:** the delegated JWT rides the **existing `MCP_USER_TOKEN_FILE` channel** (0600, re-read + re-verified per call). **It is never a tool argument** — hard constraint #4 is preserved by construction, because we reuse the exact channel that already enforces it.
- **One token, not two.** Because the OBO-issued token carries the human's `oid`/`groups` *and* the `act`/scope, the agent presents a single bearer credential that proves both "I act for human H (in groups G)" and "I'm agent A scoped to S." No separate human token is needed.

⚠ **Reality check (Entra OBO).** Microsoft Entra's on-behalf-of flow issues a new *user* access token but does **not** natively emit an RFC 8693 `act` agent claim today. So in production-with-Entra, the delegation block is minted by a Cerebro-trusted **token-exchange STS / Totem mint** the agent host calls, configured as an additional accepted issuer — exactly mirroring how `local-oidc` is a config-only swap of the trust root. This keeps the design standards-aligned and config-swappable as IdPs add native agent OBO. **Decision C** in §12.

---

## 4. Placement — where the verifier and the intersection sit

The delegation layer adds checks in the **single identity path** and the **single MCP choke point**; it never creates a parallel path.

```
                 ┌─────────────────────────── Phase 1 ───────────────────────────┐
 REST request ──▶ AuthGuard ─┐
 MCP tool call ─▶ resolveOrReject ─┐
 eval case ─────▶ identityFor ─────┤
                                   ▼
                       IdentityService.resolve()        ◀── SOLE mint point (unchanged role)
                         │  1. jose verify (sig/iss/aud/exp)      [reuses OidcTokenVerifier]
                         │  2. sub → human principals             [UNCHANGED]
                         │  3. if act present: verifyDelegation()  ← NEW (lifted Totem algorithm)
                         │       cmd narrow · time ∩ · AND-policy · revocation (mint-asserted; +holder-key/replay → Decision H)
                         ▼
                  CallerIdentity { subject, principals[], mode, delegation? }   ← delegation? is additive
                                   │
                                   ▼
                       RetrievalService.search()         ◀── enforcement point
                         │  expand(principals)            [UNCHANGED — visibility FLOOR]
                         │  ∩ delegation.principals_allow  ← NEW (strict narrowing, never widens)
                         │  gate action/args vs cmd/pol    ← NEW (over-scope → deny)
                         ▼
                  hard SQL pre-filter  acl_principals && $effective_principals   [UNCHANGED]

                 ┌─────────────────────────── Phase 2 (separately flagged) ──────┐
 MCP tool call ─▶ resolveOrReject  ─── becomes a PDP: re-checks freshness/revocation/scope
                  WITH tool name + args  (today it is scope-blind — sees only principals)
                  → allow | deny | needs-approval (AARP)   ← only ADDS checks
```

**The intersection, concretely.** Two orthogonal axes, both fail-closed:
- **Visibility floor = the human's ACL (unchanged).** The SQL pre-filter still runs against the human's expanded principals. An agent can never see a chunk its human can't — this gives the *under-entitled-human* guarantee for free (the colleague-sees-the-sick-leave-ticket case): if the human has no mapping to the protected doc, it's invisible regardless of what the delegation says.
- **Narrowing = the delegated scope.** `delegation.cmd`/`pol` gate the *action* and *request args* (e.g. restrict `sourceSystems` to `["confluence"]`); `delegation.principals_allow` optionally intersects the principal set down to a subset. Both can only *remove*. `effective_principals = expand(human_principals) ∩ (principals_allow ?? all)`, and the requested action must satisfy `cmd`/`pol` or the call is denied with no data.

⚠ **Reality check (`sourceSystems` is a hint, not a boundary).** Today `options.sourceSystems` is a retrieval *filter* passed straight through ([mcp-tools.ts:109-113](../src/mcp/mcp-tools.ts:109)). For delegation to enforce a source restriction it must become an *authorization constraint* derived from `pol`, not a caller-supplied hint. Small change, but it's a semantics shift worth calling out. **Decision D.**

⚠ **Reality check (public floor under narrowing).** The pre-filter always appends the `public` principal so public content stays visible. Should a narrowly-scoped agent (e.g. "confluence only") still see *all* public content (incl. GitHub-public)? Two defensible answers; I lean "narrowing applies to the whole effective set, public included, when `principals_allow`/`pol` is present." **Decision E.**

---

## 5. Package boundary — `@dreamshare/totem-sdk` vs. Cerebro-specific

| Concern | Where it lives | Notes |
|---|---|---|
| `mintDelegation(...)` / `verifyDelegation(token, expected)` | **`@dreamshare/totem-sdk`** (framework-agnostic) | JWT-substrate; the lifted algorithm (`commandPermits`, `evaluatePolicy`, chain intersection) re-pointed at JWS sign-bytes + a JWT-id proof seam. Ed25519 small-order/ZIP-215 hardening preserved. |
| Claim types (RFC 8693 + OIDC-A vocab) | **`@dreamshare/totem-sdk`** | Shared, dependency-light type definitions. |
| `RevocationRegistry` / `NonceStore` / `SpendLedger` / `AttestationAnchor` **interfaces** | **`@dreamshare/totem-sdk`** | Interfaces only (already the Totem pattern). |
| Postgres-backed implementations of those interfaces | **Cerebro** (`src/auth/delegation/`) | Durable, pooled, pgvector DB. The in-memory mocks ship for tests. |
| NestJS wiring + the per-call policy hook (PDP) | **Cerebro** | `resolveOrReject` → PDP; DI module; config flags. |
| Optional on-chain anchor (ERC-8004/EAS) | **separate, off-by-default adapter package** | Never a core dependency; see §6. |

⚠ **Reality check — the module-system collision (hard constraint).** Cerebro is **CommonJS + `jose@5`**; Totem is **pure ESM** and `totem-core`'s 4 runtime deps are **all ESM-only**. A CJS Cerebro cannot `require()` pure ESM. Options for *how Cerebro consumes the SDK* (these are separate git repos):

1. **Lift the algorithm onto JWT + ship the SDK dual-build (recommended).** The new `totem-sdk` depends only on `jose` (dual-published, already in Cerebro) — *not* on the ESM-only CBOR/multiformats stack. Cerebro `require()`s the CJS condition synchronously, no async boundary, no ESM-only deps in the hot path. Consumed as a published package or a `file:` dep. **This is why §1's algorithm-lift recommendation and the packaging recommendation are the same decision.**
2. **Consume `totem-core` (UCAN, unchanged) via dynamic `import()`.** Maximum code reuse (incl. the 45 tests), but forces an `async` boundary into the identity path, keeps the ESM-only dep wall, and pairs with a `did:key` trust root (Decision A's alternative).
3. **Vendor a down-leveled CJS build of `totem-core`.** Risky — the ESM-only CBOR/`@noble`/`multiformats` deps may not down-level cleanly.

Recommendation: **option 1**, contingent on Decision A.

---

## 6. `AttestationAnchor` / audit-sink interface

The brief's `AttestationAnchor` is an **audit sink** (record every delegation verification + authorization decision, tamper-evidently), distinct from Totem's `AttestationProvider` (TEE instance-authenticity tiers, which I propose is **out of scope** for the initial fold-in — Cerebro's OIDC identity is already the de-facto instance binding; tiers can return later).

```ts
export interface AuthorizationDecisionRecord {
  ts: string; subject: string; actor?: string;       // human / agent
  action: string; args_digest: string;               // what was attempted (no raw secrets)
  decision: 'allow' | 'deny' | 'needs-approval';
  reasons: string[]; delegation_id?: string; chain?: string[];
}

export interface AttestationAnchor {
  /** Append-only; returns an opaque receipt/handle. MUST NOT throw the request open on failure (fail-closed). */
  record(rec: AuthorizationDecisionRecord): Promise<{ handle: string }>;
  /** Revocation status read (negative list). Generalizes Totem's RevocationRegistry. */
  isRevoked(namespace: string, id: string): Promise<{ revoked: boolean; asOf?: string }>;
}
```

- **Default: `LocalAppendOnlyAnchor`** — a Postgres append-only table (or a 0600 JSONL file for the keyless local path). **No external dependency.** Revocation reads hit `principal_mappings`-style rows or a `revocations` table; revocation = insert/DELETE, instant on next call (mirrors today's mapping-revocation semantics).
- **Optional: `OnChainAnchor`** — a separate, clearly-marked adapter (ERC-8004 identity anchor + EAS/registry) behind the same interface, **off by default**. The system is fully functional with it disabled, and the *eval harness runs with the chain off*. If you find the chain becoming load-bearing, that's the signal to stop — it's the part we're removing.

---

## 7. Standards mapping (one line each, honestly graded)

| Standard | Status | How we conform |
|---|---|---|
| **RFC 8693 Token Exchange** + OAuth 2.1 + Entra OBO | **8693 = Stable RFC**; OAuth 2.1 = Internet-Draft; OBO = vendor flow | Canonical token shape: `sub`=human, `act`={sub:agent} (nested for chains), `aud`=Cerebro, `scope`=grant; `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` for the mint. **This is the model the brief calls "OIDC-A `sub`/`act`."** ⚠ Only RFC 8693 is ratified; OAuth 2.1 is still `draft-ietf-oauth-v2-1`, and "OBO" is Microsoft's vendor term for the same delegation pattern (§3.3). |
| **OIDC-A (OpenID Connect for Agents)** | **Proposal (arXiv 2509.25974)** | We adopt its *agent-identity vocabulary* (`agent_instance_id`, `agent_model`, `agent_provider`, `agent_attestation` via EAT/RATS, `delegation_chain`) as **descriptive** claims. The EAT token-type URN itself is **RFC 9711** (used via OIDC-A/RATS), not RFC 8693. ⚠ We deliberately **do not** adopt its `sub`=agent semantics (would break invariant #2) — see Decision B. |
| **AuthZEN COAZ (MCP Tool Authorization profile)** | **WG draft** | The Phase-2 PDP at `resolveOrReject` is a natural AuthZEN PEP; the per-tool-call decision is expressible as the AuthZEN Subject-Action-Resource-Context shape, with `coazMapping` from the MCP tool `inputSchema`. We *align* the decision shape; we don't yet require an external PDP. |
| **AuthZEN AARP (Access Request & Approval Profile)** | **WG draft** | Phase-2 "policy cannot authorize yet" returns a structured **`needs-approval` / `needs-consent`** result (prerequisite pattern) rather than a bare deny where a step-up is the right answer. |
| **RFC 9728 (OAuth 2.0 Protected Resource Metadata)** | **Stable RFC** | ⚠ *Not built today.* Cerebro **will publish** (Phase-1 deliverable, §11) `/.well-known/oauth-protected-resource` (`resource`, `authorization_servers`, `scopes_supported`, `bearer_methods_supported`) so MCP clients can discover the accepted issuer(s)/scopes via the metadata MCP expects. |

---

## 8. Threat-model delta vs. today

Delegation adds attack surface; here is each new attack and its mitigation, cross-referenced to Totem `DESIGN.md` §13 (T*) and the OWASP/SAFE-MCP framing.

| New attack | Mitigation in this design | Residual |
|---|---|---|
| **Token replay / theft** (T5) | **Default (bearer):** short TTL (`DELEGATION_MAX_TTL_S`) + the 0600 out-of-band channel + per-call revocation re-check. A bearer token is *legitimately* reused within its TTL, so there is **no** single-use nonce on the token itself. **Stronger (Decision H b/c):** DPoP/`cnf` holder-key binding, or per-call signed invocations with a durable `NonceStore` (Postgres CAS) for true at-most-once. | Bearer: a stolen token is usable until `exp` (hence short TTL). PoP closes this at the cost of an agent key. |
| **Over-broad / widening delegation** (T2) | Attenuation enforced as `commandPermits` narrowing + AND-policy + time ∩ over the net scope. **Default:** the mint verifies hop-by-hop attenuation and signs the net result (*mint-asserted*); Cerebro trusts the mint signature within its single trust domain (the §8 demotion logic applies verbatim). **Decision H (c)** restores RP-verified hop-by-hop holder-key chaining for cross-domain use. | Mint-asserted ⇒ trust shifts to the mint/STS (acceptable in one trust domain); cross-domain needs option (c) + a conformance test suite. |
| **Confused deputy** | `aud` hard-checked (the agent's token is bound to Cerebro); the agent cannot replay a token minted for another resource. | Standard OAuth audience-binding caveats. |
| **Stale revocation / TOCTOU** (T4) | Short delegation TTLs (suppression-proof, backend-independent); revocation read on every call via `AttestationAnchor.isRevoked`; Phase-2 late-binding re-check for sensitive sources. | TTL-floor propagation window; see the demotion note below. |
| **Token / proof exfiltration via prompt injection** (OWASP MCP / SAFE-MCP) | Proof rides the existing out-of-band `MCP_USER_TOKEN_FILE` channel; **never a tool argument** (constraint #4, preserved by reusing the enforced channel). | — |
| **Delegation widening past the human's ACL** | Strict intersection: the SQL pre-filter is the unchanged visibility floor; scope can only narrow (invariant #2). | — |

**Why demoting the chain is *justified*, not just tolerated.** Totem's on-chain case (`DESIGN.md` §6) rests on the *no-single-owner / censorship-resistant* properties needed when **mutually-distrusting federated relying parties** can't trust a status host. **Cerebro is a single identity-resolution service with a hard SQL pre-filter — one trusted authority, one trust domain.** In that domain the equivocation/coercion attacks the chain was built to close (T4 equivocation, T9 read-path trust, T10 hide-by-omission) are largely **moot**, because the relying party *is* the status host. T6 (the on-chain address as a global de-anonymizing join key) **improves** under demotion — there is no public anchor to inner-join. The genuinely backend-independent defenses — **short TTLs** and **`sub`-keyed cumulative counters** — are off-chain already and carry over unchanged. The on-chain anchor remains available as an *optional* tamper-evident audit backend for deployments that span trust boundaries.

⚠ Carry-over residuals (unchanged by the fold-in): intent is never verified, only blast radius bounded (T3 — a hijacked-but-valid agent passes every check); MVP blast-radius caps are **per-RP, not aggregate** across consumers (T3/T4/T8); self-asserted instance keys are ordinary software secrets (T8) unless TEE tiers are later enabled.

---

## 9. Config flags and defaults (all new behavior defaults OFF)

Following the `config.ts` + `assertBootInvariants` pattern (default OFF; production guards refuse insecure combinations):

| Env var | Default | Meaning |
|---|---|---|
| `DELEGATION_ENABLED` | `false` | Master switch for Phase 1. OFF ⇒ an `act`-bearing token is treated as a plain bearer token (the `act`/delegation block is ignored); system behaves exactly as today. |
| `DELEGATION_REQUIRE` | `false` | When ON, a request presenting no valid delegation is denied (delegation becomes mandatory for that deployment). Default OFF preserves plain-bearer behavior. Only meaningful with `DELEGATION_ENABLED=true`. |
| `DELEGATION_ISSUER` / `DELEGATION_JWKS_URL` / `DELEGATION_JWKS_FILE` | `''` | Trust root for the delegation mint (mirrors the `oidc` / `local-oidc` split). |
| `DELEGATION_MAX_TTL_S` | `300` | Cap on delegated-token lifetime (short by design). |
| `DELEGATION_AUDIT_BACKEND` | `local` | `local` (append-only) \| `onchain` (optional adapter). |
| `DELEGATION_PDP_ENABLED` | `false` | **Phase 2** per-MCP-call PDP. Independently flaggable + shippable later. |
| `DELEGATION_SENSITIVE_SOURCES` | `''` | Comma-list of `source_system`s that trigger Phase-2 late-binding re-check (see §10). |

Boot guards (added to `assertBootInvariants`): production + `DELEGATION_ENABLED=true` ⇒ https issuer/JWKS, no local JWKS file, `DELEGATION_MAX_TTL_S` ≤ a sane ceiling, `onchain` backend forbidden unless explicitly acknowledged. **The eval harness must pass with `DELEGATION_ENABLED=false` AND with the chain off** (acceptance criterion).

---

## 10. Test + eval plan

The existing harness is the right gate — a leak is already a hard, non-absorbable failure proven against the *real* SQL pre-filter, and identity is minted at one point. Plan:

- **Backward-compat (must pass first):** the full existing suite + eval pass unchanged with `DELEGATION_ENABLED=false`. This is the "Cerebro still boots and the eval passes with delegation OFF and chain OFF" acceptance gate.
- **New eval identity leg:** add `EVAL_AUTH=delegation`, mirroring `setupLocalOidc`/`mintCaseToken` — mint signed delegated JWTs (human `sub` + `act` + `delegation` block) via a test mint. Extend `GoldCase` with an optional `delegation` field (scope, expiry, revoked).
- **Hard pass/fail delegation cases** (map onto existing patterns):
  - **happy path** — valid token, human entitled, in-scope → grounded cited answer (`required:true`, like `salary-allowed-acl`).
  - **over-scope** — valid token, action outside `cmd`/`pol` → denied, `forbiddenDocIds` + `expectNotFound`.
  - **under-entitled human** — delegation from a human who lacks the mapping → "not found", no leak (the sick-leave-ticket case).
  - **revoked / expired delegation** — minted expired, or revoked in the `AttestationAnchor` → denied.
  - **replay / stolen token** — a captured token reused after `exp` (bearer default) is denied (mirrors the existing token-rotation freshness test); under Decision H (b/c), a reused single-use invocation/nonce is denied.
  - **(Phase 2 on) revoked membership** for a `DELEGATION_SENSITIVE_SOURCES` source → denied at call time.
- **Ported algorithm tests:** re-home the substrate-agnostic Totem tests (attenuation/widening/sibling-replay/withheld-proof/broken-link, time-window clamp, fail-closed policy, path-escape, ReDoS-safe glob, subject-keyed spend) onto the JWT substrate. Preserve the Ed25519 small-order/ZIP-215 rejection explicitly (⚠ `jose` does not do ZIP-215 the way `@noble {zip215:false}` does — must be re-asserted or it reopens a forgery hole).
- **CI:** add the `EVAL_AUTH=delegation` run alongside the existing `dev-header` and `local-oidc` runs, chain off.

⚠ **Reality check — no "sensitive source" column exists.** The brief's Phase-2 late-binding re-check assumes a sensitivity flag; the schema has none. The only zero-migration keying signal is **`source_system`** (denormalized + indexed on `chunks`). Finer-grained sensitivity needs a new `documents` column denormalized to `chunks` (mirroring `acl_principals`) + an ACL-only rewrite path. **Decision F.**

---

## 11. Phased implementation breakdown

- **Phase 1 — standards-aligned delegation layer (core).**
  1. `@dreamshare/totem-sdk` refactor: JWT mint/verify + lifted algorithm + claim types + interfaces (dual-build for CJS).
  2. Delegation verifier inside `IdentityService.resolve` (additive `CallerIdentity.delegation`); fail-closed on malformed/expired/wrong-aud.
  3. Scope intersection at the enforcement point (`RetrievalService` + promote `sourceSystems` from hint to constraint).
  4. `AttestationAnchor` interface + `LocalAppendOnlyAnchor`; route decisions through it; optional on-chain adapter (separate package, off).
  5. Publish `/.well-known/oauth-protected-resource` (RFC 9728) listing the accepted issuer(s) + scopes for MCP discovery (a new `@Public` route alongside the health controller).
  6. Config flags + boot guards + docs (curl + MCP examples, runnable chain-off, zero external keys) + tests + eval leg.
- **Phase 2 — continuous runtime re-authorization at the MCP boundary (separately flaggable).** Turn `resolveOrReject` into a PDP: extend its signature to receive **tool name + args** (today it's scope-blind), re-check freshness/revocation/scope per call, and add the **late-binding membership re-check** for `DELEGATION_SENSITIVE_SOURCES`. Model "cannot authorize yet" as an **AARP `needs-approval`/`needs-consent`** structured result. Behind `DELEGATION_PDP_ENABLED`. **Only adds checks; never weakens the fail-closed guarantees.**

Each phase = small, reviewable commits per logical step.

---

## 12. Decisions I need from you (before Phase 1)

These are the points where repo reality or the actual specs diverge from the brief. My recommendation is in **bold**; I'll proceed on the bold options if you don't object, except where noted.

- **A — Reuse strategy for Totem's core.** **(Recommended) Lift the verification algorithm onto a JWT/`jose` substrate** in a refactored `totem-sdk` (thin, CJS-consumable, reuses Cerebro's OIDC validation, no second trust root) — at the cost of re-porting the algorithm + tests rather than consuming the 45-test UCAN core verbatim. *Alternative:* consume `totem-core` (UCAN/`did:key`) via dynamic `import()` (max reuse, but ESM-only dep wall + async boundary + a second `did:key` trust root needing a human↔DID binding). **This is the spine — please confirm.**
- **B — Standards framing.** **(Recommended) RFC 8693 `act` as the canonical `sub`=human/`act`=agent shape; OIDC-A vocabulary as descriptive claims only.** Adopting OIDC-A literally (`sub`=agent) would violate invariant #2. Confirm you're OK with me treating the brief's "OIDC-A `sub`/`act`" as "RFC 8693 actor model + OIDC-A agent vocabulary."
- **C — Production mint.** Entra OBO doesn't emit an `act` agent claim today. OK to introduce a Cerebro-trusted **token-exchange STS / Totem mint** as an additional accepted issuer (config-only swap, like `local-oidc`), pending native IdP support?
- **D — `sourceSystems` semantics.** OK to promote it from a caller-supplied retrieval *hint* to an *authorization constraint* when a delegation is present?
- **E — Public floor under narrowing.** When a delegation narrows principals/sources, should the always-on `public` floor also be narrowed? (I lean **yes** when `principals_allow`/`pol` is present.)
- **F — Sensitivity signal.** For Phase-2 late-binding re-check: key off the existing **`source_system`** (zero migration) for the MVP, or add a dedicated sensitivity column (`documents`→`chunks`)? (I lean **`source_system` first**, dedicated column later.)
- **G — TEE attestation tiers.** I propose Totem's `AttestationProvider`/trust-tier machinery is **out of scope** for the initial fold-in (Cerebro's OIDC is the de-facto instance binding); re-introduce later as an optional gate. OK?
- **H — Proof-of-possession for the delegated credential** (resolves a §3/§8 consistency point). Totem's replay/widening defenses assume a per-call *signed* invocation (holder-of-key); my §3 credential is a **bearer** JWT. Pick the model: **(a, recommended) bearer + mint-asserted attenuation** — simplest; relies on short TTL + the 0600 channel + the single trust domain (same demotion logic as §8); **(b) DPoP / `cnf`** (RFC 9449) — restores holder-key binding cheaply, stays jose-friendly; **(c) per-call signed JWT invocation** — keeps Totem's model fully but re-introduces an agent key + registration (undercuts the thin jose-only SDK). **Discriminator:** will Cerebro ever be consumed *outside its own trust domain*? No → (a); maybe → (b). **§3/§8/§10 are currently written to (a) pending your call.**

---

*Prepared as Phase 0. On your confirmation of §12 (at minimum A, B, and H), I'll begin Phase 1 with small, reviewable commits, starting with the `totem-sdk` boundary and the verifier in `IdentityService`.*
