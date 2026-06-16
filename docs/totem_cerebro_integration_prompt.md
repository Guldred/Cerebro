# Claude Code Prompt — Fold Totem's delegation layer into Cerebro

> Paste this as your opening prompt in Claude Code, inside the Cerebro repo.

---

## Your role and the repositories

You are working in the **Cerebro** repository at `/Users/christian.malak/MyProjects/Cerebro`.

Cerebro is a NestJS / TypeScript, **permission-aware vectorized knowledge layer**: pgvector hybrid retrieval (vector + FTS + RRF), **per-chunk ACLs** with a hard SQL pre-filter, **fail-closed OIDC identity** resolved by a single service on every path, **query-time principal mapping** (caller's Entra principals → source-native principals via the `principal_mappings` table), Confluence / GitHub / GitLab connectors, a **REST API and an MCP server**, and an **eval harness that treats any ACL leak as a hard failure**.

A second local repository, **Totem** (`@dreamshare/totem-*`), is a prototype for **agent identity and delegation verification**, located at `/Users/christian.malak/MyProjects/Totem`.

**Goal:** fold the genuinely useful parts of Totem into Cerebro so the combined result is a *product*: safe, verifiable, delegated agent access to enterprise data. Cerebro becomes the **reference resource server**; Totem becomes a **standards-aligned delegation/verification layer** that Cerebro consumes.

---

## Strategic reframe — read this before designing (it changes what to keep)

Totem was originally conceived as a **blockchain-based** identity system. The industry has converged elsewhere: agent identity and delegation are being standardized as **extensions to OAuth 2.1 / OpenID Connect**, not as a new blockchain trust root. We are deliberately realigning Totem onto those standards:

- Adopt the delegated-token model the field has settled on: `sub` = the **human** principal, `act` = the **agent** acting on their behalf, `aud` = the **resource** (Cerebro), `scope` = the granted permission. Treat every agent action as **delegated human access**, never the agent's own blanket access.
- Shape the agent/delegation claims after the **OpenID Connect for Agents (OIDC-A)** proposal (agent identity, attestation, delegation chain).
- Express the per-tool-call authorization decision so it is compatible with the **OpenID AuthZEN "MCP Tool Authorization" profile (COAZ)**, and model "cannot authorize yet — needs consent/approval" on the **AuthZEN AARP** prerequisite pattern.
- Reuse Cerebro's existing OIDC validation; build on the **RFC 9728 protected-resource-metadata** discovery that MCP already expects.
- **The blockchain is NOT in the core and NOT in the hot path.** Keep Totem's reusable assets — the **delegation/attestation logic** and the **threat model** — and discard "the chain is the trust root." Any on-chain piece becomes an **optional, pluggable audit/anchor backend behind an interface**, and the system must be fully functional with it disabled.

> If you find yourself making the chain load-bearing, stop — that is exactly the part we are removing.

---

## Hard constraints — security invariants you must NOT regress

Cerebro's entire value is that it cannot leak. Preserve every one of these:

1. **One identity-resolution service on every path** (REST guard, MCP tool call, eval harness). The new delegation verification slots *into* that single service — it must not create a second, bypassable path.
2. **Principal resolution keys off the human (`sub`), never the agent.** The agent identity (`act`) is used only for (a) audit and (b) *narrowing* scope. It must never widen what is visible. Effective entitlement = `human_entitlements ∩ delegated_scope` — a **strict intersection**. An agent can be granted *less* than its human, never more.
3. **The ACL pre-filter stays the hard SQL filter, fail-closed.** Unresolved principals stay invisible, never public. No new public-granting path.
4. **Tokens and delegation proofs never travel as MCP tool arguments.** Keep the prompt-injection exfiltration channel closed; the same rule applies to delegation tokens.
5. **Everything is flag/config-gated and backward compatible.** Cerebro must still boot and pass the eval harness with delegation **OFF** and the chain **OFF**. Provider/standard swaps stay config-only, matching the existing `.env` philosophy.
6. **Fail-closed boot is preserved.** Production still refuses anything but real token validation + ACL enforcement.

---

## Phase 0 — Design doc first (then STOP for my review)

Before writing implementation code, read the relevant parts of both repos and produce a design doc at `docs/Totem_Integration.md` covering:

- **Placement:** where the delegation verifier sits relative to the existing identity-resolution service, the principal-mapping step, and the ACL pre-filter (a short step list or small diagram is enough).
- **Token/credential model:** exact claim shapes (`sub`, `act`, `aud`, `scope`, plus the OIDC-A agent/delegation claims), how a delegation chain is represented, and how verification works (signature, issuer, audience, expiry — reusing Cerebro's OIDC validation).
- **Package boundary:** what goes in `@dreamshare/totem-sdk` (framework-agnostic mint + verify) vs. what stays Cerebro-specific (the NestJS wiring and the per-call policy hook).
- **`AttestationAnchor` / audit-sink interface:** its default **local append-only** implementation, and how the *optional* on-chain backend plugs in behind it.
- **Standards mapping:** one line each on how we conform to OAuth 2.1 OBO, OIDC-A, AuthZEN COAZ/AARP, RFC 9728.
- **Threat-model delta vs. today:** the new attacks delegation introduces (token replay, over-broad delegation, confused-deputy, stale revocation) and how each is mitigated. Cross-reference the OWASP MCP Top 10 / SAFE-MCP where relevant.
- **Config flags and defaults** (all new behavior defaults OFF).
- **Test + eval plan.**
- **Phased implementation breakdown**, with the Phase-2 runtime re-authorization clearly separable.

**Then pause and wait for my confirmation.** Where repo reality differs from the assumptions above, ask me — do not invent.

---

## Phase 1 — Standards-aligned delegation layer (the core)

After I approve the design:

- **`@dreamshare/totem-sdk`** — a thin, dependency-light library exposing `mintDelegation(...)` (for agent clients) and `verifyDelegation(token, expected)` (for resource servers), with the OIDC-A-shaped claim types. **No blockchain dependency.**
- **Delegation verifier inside Cerebro's single identity-resolution service:** when a delegated token is presented, verify it, extract the human `sub` (which feeds the existing principal mapping **unchanged**), and capture `act` + `scope` for audit and intersection. Reject malformed / expired / wrong-audience tokens fail-closed.
- **Scope intersection enforced before retrieval:** the requested action must lie within `delegated_scope`, and visible data is still bounded by the human's ACL — the agent's effective rights are the intersection of the two.
- **`AttestationAnchor` interface + default local append-only audit log** (no external dependency). Route delegation/authorization decisions through it. Provide the optional on-chain backend as a separate, clearly-marked adapter that is **off by default**.
- **Config additions** (new `.env` knobs, all defaulting to OFF/local), **docs**, and **tests**.

---

## Phase 2 — Continuous runtime re-authorization at the MCP tool boundary (separately flaggable)

This is the differentiating capability and must be **independently switchable** (and shippable later). Today Cerebro re-verifies the end-user token on every MCP tool call; extend that single choke point into a small **policy decision point (PDP)** that runs per tool call and re-checks:

- token freshness / revocation,
- delegation still valid (not expired or revoked),
- requested action still within scope,
- optionally, for sources flagged **sensitive**, a **late-binding membership re-check** at call time — this closes the revocation window between ingest-time ACL capture and `acl:refresh`.

Model "policy cannot authorize yet" on the **AuthZEN AARP** prerequisite pattern: return a structured `needs-approval` / `needs-consent` result rather than a bare allow/deny where a step-up is the right answer. This must **only add checks**, never weaken the existing fail-closed guarantees. Put the whole PDP behind a feature flag.

---

## Acceptance criteria

- Cerebro boots and the eval harness **passes with delegation OFF and chain OFF** (backward compatibility proven).
- With delegation ON, extend the eval harness so all of these are hard pass/fail cases:
  - **happy path:** valid delegated token, human is entitled, in-scope action → grounded, cited answer;
  - **over-scope:** valid token but action outside `scope` → denied, no data;
  - **under-entitled human:** the agent's human can't see the doc → "not found", no leak (the colleague-sees-the-sick-leave-ticket case);
  - **revoked / expired delegation** → denied;
  - **(Phase 2 on) revoked membership** for a sensitive source → denied at call time.
- README / docs updated with curl + MCP examples mirroring the existing README style, **all runnable with the chain disabled and, where possible, zero external keys**.
- **No token or delegation proof ever appears in an MCP tool argument.**

---

## How to work

- Follow the repo's existing conventions, its interface-first architecture, and its config-driven provider-swap philosophy. Keep changes **minimal and incremental**.
- Prefer small, reviewable commits per logical step.
- If anything in the repos contradicts this brief, **surface it and ask** — do not paper over it.
- Start with Phase 0.
