# Cerebro

A central, permission-aware, **vectorized knowledge layer** over heterogeneous enterprise
sources (Confluence, GitLab, MS Teams, …). It ingests content, makes it semantically searchable,
and answers natural-language questions with a grounded, **cited** answer — every claim links back
to the original source. Consumable as a **REST API** and an **MCP server**.

See the design in [docs/Project_Plan_AI_Knowledge_Layer.md](docs/Project_Plan_AI_Knowledge_Layer.md)
and the review/backlog in [docs/Plan_Review.md](docs/Plan_Review.md).

---

## Status

This repo implements **one vertical slice that runs end-to-end with zero external keys**:

```
seed docs → normalize → chunk → embed → store (pgvector)
          → hybrid retrieve (vector + FTS, RRF) with ACL filter → grounded, cited answer
```

The architecture for the full system is in place as interfaces; what's wired vs. fast-follow:

| Area | Implemented now | Behind an interface (fast-follow) |
|---|---|---|
| Embeddings | deterministic local `fake` (1024-dim, no keys) | Azure OpenAI (EU), self-hosted `bge-m3` via OpenAI-compatible endpoint |
| Generation | deterministic extractive `fake` (grounded, abstains) | Azure OpenAI, self-hosted EU LLM |
| Connectors | `sample` (reads `seed/*.md`) + **Confluence Cloud** (REST/CQL, deny/inheritance read-set) + **GitHub** + **GitLab** (visibility-native ACLs) | Teams |
| Retrieval | hybrid vector+FTS, RRF, HNSW iterative-scan, ACL pre-filter | cross-encoder reranking, BM25 lexical arm |
| Permissions | per-chunk `acl_principals`, hard SQL filter, fail-closed; **Entra-shaped OIDC** (`AUTH_MODE`), **principal mapping** (query-time, fail-closed), deny/inheritance resolution, ACL refresh w/o re-embed, MCP identity hard-reject | Graph resolver for >200-group tokens, attachment-level ACLs, late-binding re-check |
| Interfaces | REST `/query` `/search` `/health`, MCP `cerebro_query`/`cerebro_search` | webhooks, BullMQ delta sync, reranker |
| Quality | eval harness gating Recall@k + ACL leaks + abstention | RAGAS faithfulness, per-stage tracing |

Provider swaps are config-only (`.env`); no code changes.

---

## Quickstart

Prerequisites: **Node ≥ 20**, **Docker**.

```bash
cp .env.example .env          # defaults run fully locally, no keys needed
npm install
docker compose up -d          # Postgres + pgvector on localhost:5433
npm run db:migrate            # create schema
npm run db:seed               # ingest the sample DE+EN corpus (seed/*.md)
npm run start:dev             # API on http://localhost:3000
```

Try it. In the default `AUTH_MODE=dev-header` the `x-cerebro-principals` header stands in for
the caller's validated Entra principals (switch to real token validation below — the header is
then ignored):

```bash
curl -s localhost:3000/health | jq

# English, public content → grounded answer + section-precise deep link
curl -s -X POST localhost:3000/query -H 'content-type: application/json' \
  -H 'x-cerebro-principals: public' \
  -d '{"question":"How do I set up the local Postgres database?"}' | jq

# German works too
curl -s -X POST localhost:3000/query -H 'content-type: application/json' \
  -H 'x-cerebro-principals: public' \
  -d '{"question":"Welche Frist gilt für das Recht auf Löschung?"}' | jq

# PERMISSION-AWARE: the restricted "Salary Bands" doc carries the SOURCE-native
# ACL confluence-group:hr-payroll; callers hold ENTRA principals. The
# principal_mappings table (seeded from seed/principal-mappings.json) maps
# entra-group:hr -> confluence-group:hr-payroll at query time.
#   ...as a public caller → "Not found", no leak:
curl -s -X POST localhost:3000/query -H 'content-type: application/json' \
  -H 'x-cerebro-principals: public' \
  -d '{"question":"What do the engineering salary bands cover?"}' | jq .answer
#   ...as a caller in the Entra hr group → grounded answer + citation:
curl -s -X POST localhost:3000/query -H 'content-type: application/json' \
  -H 'x-cerebro-principals: entra-group:hr' \
  -d '{"question":"What do the engineering salary bands cover?"}' | jq
#   ...an UNMAPPED source principal is invisible to everyone (fail-closed):
curl -s -X POST localhost:3000/query -H 'content-type: application/json' \
  -H 'x-cerebro-principals: entra-group:board-secret' \
  -d '{"question":"What budget did the board approve for Project Albatross?"}' | jq .answer

# Raw retrieval (no generation)
curl -s -X POST localhost:3000/search -H 'content-type: application/json' \
  -H 'x-cerebro-principals: public' \
  -d '{"query":"deployment rollback procedure","topK":3}' | jq
```

Run the eval harness (gates on Recall@k, treats any ACL leak as a hard failure):

```bash
npm run eval
```

Run as an MCP server (stdio), e.g. for an agent client:

```bash
npm run mcp
```

---

## Configuration

All config is env-driven ([.env.example](.env.example)). Key knobs:

- `EMBEDDING_PROVIDER` = `fake` | `azure-openai` | `openai-compatible`
- `LLM_PROVIDER` = `fake` | `azure-openai` | `openai-compatible`
- `ACL_ENFORCED` (default `true`) — hard SQL filter on `acl_principals`
- `HNSW_ITERATIVE_SCAN` (default `true`) — keeps recall under selective ACL filters

### Choosing an embedding model (dimension contract)

`chunks.embedding` is **`vector(1024)`** in [db/migrations/001_init.sql](db/migrations/001_init.sql).
`EMBEDDING_DIM` **must** equal that number; changing the model's dimension requires a migration.

- **Default / recommended: `bge-m3` (1024-dim)** — multilingual (your DE+EN requirement),
  self-hostable in the EU, indexes cleanly under pgvector's **2000-dim HNSW ceiling**.
- `text-embedding-3-large` is **3072-dim** → exceeds that ceiling; use `halfvec` (≤4000) or the
  API `dimensions` parameter to fit. The Azure provider already requests `dimensions: EMBEDDING_DIM`.

To switch to self-hosted `bge-m3`:

```env
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=http://localhost:8080/v1   # TEI / vLLM / Ollama
EMBEDDING_MODEL=bge-m3
EMBEDDING_DIM=1024
```

Re-seeding then **re-embeds automatically**: ingestion skips a document only when its content hash
*and* its stored `embedding_model` both match, so a model switch forces a rebuild (no stale
mixed-model vectors). Production: blue/green re-index — see Plan_Review P2.

#### Quickest path: bge-m3 via Ollama

```bash
# Option A — Docker (no local Ollama):
docker compose --profile embeddings up -d ollama
docker exec cerebro-ollama ollama pull bge-m3
# Option B — native Ollama already running on :11434:
ollama pull bge-m3

# point Cerebro at it and re-embed
EMBEDDING_PROVIDER=openai-compatible EMBEDDING_BASE_URL=http://localhost:11434/v1 \
  EMBEDDING_MODEL=bge-m3 EMBEDDING_DIM=1024 npm run db:seed
```

With `bge-m3`, retrieval becomes genuinely semantic and **cross-lingual** (an English query retrieves
a German document) — which the deterministic `fake` provider cannot do.

### Ingesting from Confluence

```bash
SEED_CONNECTOR=confluence \
  CONFLUENCE_BASE_URL=https://your-domain.atlassian.net/wiki \
  CONFLUENCE_EMAIL=you@corp.com CONFLUENCE_API_TOKEN=*** \
  CONFLUENCE_SPACE_KEYS=ENG,LEGAL \
  npm run db:seed
```

Pages are fetched via REST/CQL, storage-format HTML is normalized, and page read-restrictions become
namespaced ACL principals (`confluence-group:*`, `confluence-user:*`, or `confluence-space:*` when a
page inherits space access). Mapping those to Entra groups + full deny/inheritance is Phase 2.

---

## Identity & permissions (Phase 2)

Identity is resolved by ONE service on every path (REST guard, MCP tool call, eval harness)
and selected by `AUTH_MODE`:

| Mode | Who is the caller | Use |
|---|---|---|
| `dev-header` (default) | `x-cerebro-principals` header, trusted verbatim | local DX, demo, CI leg 1 |
| `local-oidc` | **validated JWT** (issuer/audience/signature/exp, RS256-pinned) against a **local JWKS file** | tests + CI leg 2 — the production verifier code path, offline |
| `oidc` | validated JWT against the IdP's remote JWKS (Entra) | production |

Boot is **fail-closed**: `CEREBRO_ENV=production` refuses to start with anything but
`AUTH_MODE=oidc` + `ACL_ENFORCED=true`, and refuses a file-based trust root. Try the real
token path locally:

```bash
DEV_TOKEN_GROUPS=hr npm run auth:dev-jwks   # writes .dev/jwks.json + prints env lines & a token
AUTH_MODE=local-oidc AUTH_OIDC_ISSUER=... AUTH_OIDC_AUDIENCE=... \
  AUTH_OIDC_JWKS_FILE=$PWD/.dev/jwks.json npm run start:dev
curl -s -X POST localhost:3000/query -H "authorization: Bearer <token>" \
  -H 'content-type: application/json' -d '{"question":"..."}' | jq   # header callers now get 401
```

**Principal mapping (query-time, fail-closed).** Chunks keep SOURCE-native principals
(`confluence-group:*`, `confluence-user:*`, `confluence-space:*`, `github-repo:*`); the caller
holds ENTRA principals (`entra-user:<oid>`, `entra-group:<gid>` from the validated token, plus
the reserved `all-users`). At query time — inside the retrieval service, so no consumer can skip
it — the `principal_mappings` table expands the caller's Entra principals into the source
principals they hold. A source principal with **no mapping row is invisible to everyone**
(an unresolved ACL can never default to public), and revoking access is one `DELETE` — no
re-ingest. Schema `CHECK`s make public-granting or un-namespaced rows unrepresentable.
`npm run db:seed` upserts the versioned fixture [seed/principal-mappings.json](seed/principal-mappings.json).

**Confluence deny/inheritance.** The connector resolves each page's *effective read-set* at
ingest: space base (symbolic `confluence-space:<KEY>`, or `public` only for spaces listed in
`CONFLUENCE_PUBLIC_SPACES` — certified, never assumed), narrowed by the page's read restriction
AND every restricted ancestor (a restricted ancestor restricts its whole subtree), with
deny-over-allow in the IR for future SharePoint-style sources. A resolution failure
**quarantines** the document: content stored, `acl_principals` zeroed, `acl_status='failed'` —
invisible until re-resolution, never stale-allow.

**ACL refresh without re-embedding.** The content hash excludes the ACL, so a permission change
on an unchanged page rewrites `acl_principals` on documents + chunks and never touches vectors.
`npm run acl:refresh` (cron it for sensitive sources) re-resolves every stored document of the
configured connector and exits non-zero if quarantined documents remain — revocation gets its
own cadence, decoupled from content sync.

**MCP identity.** In oidc modes every MCP tool call re-reads and re-verifies the end-user's
token from `MCP_USER_TOKEN_FILE` (must be `0600`); calls without a resolvable identity are
hard-rejected — no service-credential fallback, no public-only degrade — and a client that
still sends the legacy `principals` argument gets a loud error, not a silent ignore. Tokens
never travel as tool arguments (prompt-injection exfiltration channel stays closed).

## Delegated agent access — Totem (default OFF)

When an **agent** calls Cerebro on a human's behalf, it should get the human's access
**narrowed to a delegated scope — never widened**. Cerebro folds in [Totem](../Totem)'s
delegation layer, realigned onto OAuth/OIDC standards (no blockchain in the hot path). Design:
[docs/Totem_Integration.md](docs/Totem_Integration.md).

The delegated credential is a short-TTL **bearer JWT** in the **RFC 8693 actor shape**:
`sub`=the human (entitlement is still resolved off the human's `oid`), `act`={`sub`: the agent},
`aud`=Cerebro, plus a net effective `delegation` grant (a Totem `cmd` path + scalar `pol` +
optional `sources_allow` / `principals_allow`). It is verified by the **same `jose` validation
the OIDC path uses**, against the `DELEGATION_*` trust root, then enforced as a **strict
intersection**: the human's ACL stays the visibility floor (the unchanged SQL pre-filter) and
the grant can only remove — restrict the action, the sources, or the principal subset. Over-scope
→ **403, no data**. The token rides the same channels as the user token (`Authorization` header
for REST, `MCP_USER_TOKEN_FILE` for MCP) — **never a tool argument**.

Everything defaults **OFF**: with `DELEGATION_ENABLED=false` Cerebro behaves exactly as above,
and the eval passes. New knobs (all default off/local, held to the same fail-closed boot bar as
`AUTH_MODE`): `DELEGATION_ENABLED`, `DELEGATION_REQUIRE`, `DELEGATION_ISSUER`,
`DELEGATION_AUDIENCE`, `DELEGATION_JWKS_URL` | `DELEGATION_JWKS_FILE`, `DELEGATION_MAX_TTL_S`,
`DELEGATION_AUDIT_BACKEND` (`local` append-only \| opt-in `onchain`), `DELEGATION_PDP_ENABLED`
(Phase 2), `DELEGATION_SENSITIVE_SOURCES`, `DELEGATION_MEMBERSHIP_CHECKER`
(`unverified` \| `github`) + `DELEGATION_GITHUB_MEMBERSHIP_ORG` / `_TOKEN` / `DELEGATION_GITHUB_API_URL`.

Try it locally — **zero external keys, chain off**:

```bash
# Mint a local delegation trust root + a delegated bearer token (prints env + token):
npm run auth:dev-delegation                      # human in 'hr', full-scope grant (/cerebro)
# copy the printed AUTH_* and DELEGATION_* lines into the server env, then:
AUTH_MODE=local-oidc AUTH_OIDC_ISSUER=... DELEGATION_ENABLED=true DELEGATION_ISSUER=... \
  DELEGATION_AUDIENCE=... DELEGATION_JWKS_FILE=$PWD/.dev/delegation-jwks.json \
  DELEGATION_MAX_TTL_S=3600 AUTH_OIDC_AUDIENCE=... AUTH_OIDC_JWKS_FILE=$PWD/.dev/delegation-jwks.json \
  npm run start:dev

# The agent presents the DELEGATED token — entitled human (hr) + in-scope → grounded answer:
curl -s -X POST localhost:3000/query -H "authorization: Bearer <delegated-token>" \
  -H 'content-type: application/json' \
  -d '{"question":"What do the engineering salary bands cover?"}' | jq

# Over-scope: mint a token whose grant does NOT permit search → 403, no data:
DEV_DLG_CMD=/cerebro/admin npm run auth:dev-delegation
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/query \
  -H "authorization: Bearer <over-scope-token>" -H 'content-type: application/json' \
  -d '{"question":"salary bands"}'                # → 403

# RFC 9728 discovery (which issuers/scopes this resource accepts):
curl -s localhost:3000/.well-known/oauth-protected-resource | jq
```

The five hard guarantees — **happy path, over-scope, under-entitled human, revoked, expired** —
are gated end-to-end (zero keys, chain off) by the eval delegation leg:

```bash
EVAL_AUTH=delegation npm run eval
```

### Phase 2 — continuous runtime re-authorization at the MCP tool boundary (`DELEGATION_PDP_ENABLED`)

Independently flaggable. When on, every MCP tool call runs a **Policy Decision Point** at the
single choke point — *before* retrieval, with the tool name + args in hand — that re-authorizes
the delegated call and returns **allow / deny / needs-approval**:

- **deny** (action out of scope, or delegation revoked) → `isError` `DELEGATION_DENIED`, no retrieval.
- **needs-approval** → a structured **AuthZEN AARP** step-up payload (not an error): the agent host
  must satisfy a prerequisite (e.g. re-verify membership) and retry. This is the differentiator —
  "policy can't authorize *yet*", modeled explicitly rather than as a flat deny.
- **allow** → proceeds (the `RetrievalService` SQL pre-filter remains the ultimate backstop).

The PDP calls the **same** policy core as `RetrievalService` (no second path); PDP-off changes
nothing. For sources in `DELEGATION_SENSITIVE_SOURCES` it runs a **late-binding membership
re-check** via a pluggable `MembershipChecker`.

> **Honest scope.** Cerebro's `principal_mappings` is already read live per query
> (`PRINCIPAL_MAPPING_CACHE_TTL_MS=0`), so caller membership is *already* call-time fresh — the
> only stale layer is a chunk's source ACL, which only a **connector-backed** (key-gated) checker
> can re-resolve at call time. The default `UnverifiedMembershipChecker` returns
> `unknown` → **needs-approval** for sensitive sources rather than pretending to confirm. So
> Phase 2's net-new value is the **boundary PDP + AARP step-up** plus, where a source oracle is
> wired, real call-time confirmation.

**Connector-backed membership (`DELEGATION_MEMBERSHIP_CHECKER=github`).** The connector oracle for a
sensitive `github` source: it re-reads **live** GitHub **org** membership at call time, closing the
*org-removal* window (a caller dropped from the org before the admin-managed mapping is updated).
This is **org-level**, not repo-level — it confirms org membership, not per-repo collaboration (the
connector emits `github-repo:<owner/repo>` ACLs), so the SQL pre-filter stays the backstop and
repo/team-level granularity is a follow-up. The caller's *stable* identity bind
(Entra `oid` → GitHub login) lives in the
`identity_links` table — deliberately **separate** from `principal_mappings` (which feeds the SQL
ACL pre-filter on every query), so an identity link can never leak in as a content grant. The
*volatile* membership is read from `GET /orgs/{org}/members/{login}`. It is **fail-closed to
step-up**: only an unambiguous `204` is `confirmed` and a clean `404` is `revoked`; a non-member
caller token (302 redirect to public members), rate-limit, 5xx, network error, or a missing link
all return `unknown` → **needs-approval**, never a silent allow. Needs a read token that is itself
a member of the org (mandatory in production); keyless dev simply steps up.

```bash
DELEGATION_MEMBERSHIP_CHECKER=github DELEGATION_GITHUB_MEMBERSHIP_ORG=acme \
  DELEGATION_GITHUB_MEMBERSHIP_TOKEN=ghp_xxx DELEGATION_SENSITIVE_SOURCES=github
# seed identity_links: INSERT INTO identity_links (entra_principal, source_system, source_login)
#                      VALUES ('entra-user:<oid>', 'github', '<github-login>');
```

## Connecting a real source

`npm run db:seed` ingests whatever `SEED_CONNECTOR` points at (a **full crawl**: every document the
source returns, with deletions reconciled). Re-running is idempotent (unchanged docs are skipped).

`npm run sync` is the **incremental** path (same `SEED_CONNECTOR`): it resumes from a durable
per-connector cursor (`sync_cursors`), ingests changes + tombstones, and persists the new cursor — so
freshness doesn't cost a full re-crawl. The cursor advances only after a successful sync; if the source
API throws, it's left unchanged and the window is retried next run. (How much work the delta actually
saves depends on the connector's `deltaSync` — real connectors return only changes since the cursor; the
bundled `sample` connector is a fixture and re-offers everything, idempotently skipped.)

**Resilience.** A per-document failure (embedder error, malformed content) is **dead-lettered** to
`ingestion_dlq` and the crawl **continues** — one poison document never aborts the whole batch.
`ingestDocument` is transactional and embeds *before* the transaction opens, so a failed re-ingest of an
existing doc leaves the last-good version live (a transient hiccup degrades to **staleness, not data
loss**). `npm run sync` exits **non-zero** while DLQ rows remain (so a scheduled run alerts, mirroring
`acl:refresh`). **Retry is by full crawl** — `npm run db:seed` re-fetches everything and clears DLQ rows
that now succeed; `deltaSync`'s cursor advances past failures, so the DLQ is the visibility + retry
counter, not a self-draining queue.

Embedding is **batch-capped** (`EMBEDDING_MAX_BATCH`, default 96): a large document's chunks are split
across multiple `embed()` calls instead of one, so a single big doc can't exceed the embedder's
per-request item/token limit. Each chunk is embedded independently, so the vectors are identical to an
uncapped call.

**GitHub** — documentation files (README + `*.md`/`*.rst`/`*.txt`/…) plus a synthesized
*repository-overview* document (description, language breakdown, topics, license, and recent commit
activity) so you can ask "what is this project / what's it built with / is it still maintained?".
Public repos work with **no token**; private repos and higher rate limits need a read-only PAT.

```bash
SEED_CONNECTOR=github GITHUB_REPOS=owner/repo1,owner/repo2 \
  GITHUB_TOKEN=ghp_xxx        npm run db:seed   # token optional for public repos
```

**GitLab** — documentation files plus a synthesized *project-overview* document, mirroring the
GitHub connector. Project visibility maps directly onto the Phase-2 ACL model: `public` →
`public`, `internal` → the reserved `all-users` principal (any authenticated caller), `private` →
`gitlab-project:<path>` (granted via `principal_mappings`), and any unrecognized visibility
**quarantines** the project's documents (fail-closed). Public projects need no token; private or
internal ones need a `read_api` PAT.

```bash
SEED_CONNECTOR=gitlab GITLAB_PROJECTS=group/project1,group/sub/project2 \
  GITLAB_TOKEN=glpat-xxx GITLAB_BASE_URL=https://gitlab.your-corp.com \
  npm run db:seed   # token + base URL optional (default gitlab.com, public projects)
```

**Confluence Cloud** — pages via REST/CQL, storage-format HTML normalized to Markdown, page
read-restrictions captured as ACL principals.

```bash
SEED_CONNECTOR=confluence \
  CONFLUENCE_BASE_URL=https://you.atlassian.net/wiki \
  CONFLUENCE_EMAIL=you@co.com CONFLUENCE_API_TOKEN=xxx \
  CONFLUENCE_SPACE_KEYS=ENG,LEGAL   npm run db:seed
```

## Real multilingual embeddings (bge-m3 via Ollama)

The `fake` default proves the plumbing but does only lexical-overlap matching. For real semantic and
cross-lingual retrieval, point the embedding provider at a local `bge-m3` (1024-dim, matches the
schema). Either use the bundled compose profile, or a native Ollama you already run:

```bash
# Option A — compose profile (skip if you already run Ollama on :11434):
docker compose --profile embeddings up -d ollama
docker exec cerebro-ollama ollama pull bge-m3
# Option B — native: ollama pull bge-m3

# then seed + serve with it (re-embeds automatically; embedding_model is tracked):
export EMBEDDING_PROVIDER=openai-compatible EMBEDDING_BASE_URL=http://localhost:11434/v1 \
       EMBEDDING_MODEL=bge-m3 EMBEDDING_DIM=1024
npm run db:seed && npm run start:dev
```

Switching models re-embeds on the next seed (the `embedding_model` column makes the idempotency
check model-aware). For generated answers, set `LLM_PROVIDER=openai-compatible`,
`LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL=<a chat model your Ollama serves>` —
verified live with `mistral:latest` (grounded prose + citations, permission-filtered).

## Observability

Every query emits one **structured JSON log event** per stage — a `retrieval` event (chunk ids +
RRF scores, ACL flag, latency) and, for a full answer, a `rag` event (per-stage latency
`retrievalMs`/`generationMs`/`totalMs`, **token usage** `promptTokens`/`completionTokens`/`totalTokens`,
cited count, `notFound`). Token usage comes from the provider's API `usage` block (Azure / OpenAI-compatible)
or a heuristic estimate (fake provider / endpoints that omit it), so the cost/capacity signal is present in
every environment — the foundation for a cost model. The **raw query is never logged by default** (it can be
Art. 9 data): events carry a short `queryHash` + `queryChars`; set `OBSERVABILITY_LOG_QUERY_TEXT=true` to
include the text in a safe debugging environment.

**Citation faithfulness.** Every answer is citation-verified (machine-checkable, no model needed): a `[n]`
marker that points outside the evidence actually provided is a **fabricated** source — it is stripped from
the answer, excluded from the citations, and reported on `RagAnswer.faithfulness` (`allGrounded`,
`hallucinatedCitations`). An answer left with no grounded citation abstains (`notFound`). This closes the
deterministic half of groundedness; verifying that each *claim* is entailed by its cited evidence (an NLI
step) needs a model and is a follow-up.

## Project structure

```
db/migrations/        SQL schema (documents, chunks: vector + tsvector + acl_principals + HNSW/GIN)
seed/                 sample corpus (Markdown + front-matter), incl. one ACL-restricted doc
src/
  config/             typed, validated env config
  db/                 pg pool + transaction helper
  embedding/          EmbeddingProvider interface + fake / azure / openai-compatible
  llm/                LlmProvider interface + grounded prompt + fake / azure / openai-compatible
  documents/          unified document model + structure-aware chunker
  ingestion/          pipeline (normalize→chunk→embed→store) + connector interface + sample/confluence
  retrieval/          hybrid search (vector + FTS + RRF) with ACL pre-filter
  rag/                retrieve → grounded answer → citations
  api/                REST controllers + identity resolution
  mcp/                MCP server (reuses the same services)
  scripts/            migrate / seed / eval
eval/gold.json        labelled gold set (relevance + ACL + cross-lingual cases)
```

---

## Permissions & safety (read before exposing sensitive sources)

Implemented: per-chunk ACL with a hard SQL filter; validated OIDC identity on REST **and** MCP
(fail-closed boot, hard-reject without identity); query-time principal mapping where an
unresolved source principal is invisible, never public; Confluence deny/inheritance resolved to
an effective read-set with quarantine on failure; ACL refresh decoupled from content sync.

Late-binding membership re-check at the MCP boundary is implemented for the `github` source
(`DELEGATION_MEMBERSHIP_CHECKER=github`, above); other sources still step up rather than confirm.

**Groups overage (`AUTH_GROUP_RESOLVER=graph`).** When a user is in too many Entra groups, the access
token omits the `groups` claim ("overage"). By default such a caller gets a deterministic **403**
(`GROUPS_UNRESOLVED`) — fail-closed, because a partial group set would silently mis-scope the ACL.
Set `AUTH_GROUP_RESOLVER=graph` (+ `GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET`) and Cerebro resolves the
**full** transitive set from Microsoft Graph `getMemberGroups` with an app token — **only on overage**
(non-overage tokens already carry the full set). It stays fail-closed: any Graph failure (throttling,
>11k groups, network) maps to the same 403, never a partial set. **`GRAPH_SECURITY_ENABLED_ONLY` must
mirror the tenant's `groupMembershipClaims` manifest** (`true` = security groups only; `false` = all
groups + directory roles) — a mismatch under-serves or *leaks* principals to overage users. This
applies to the plain-bearer path; a delegated token carries its human's groups from the delegation
mint (RFC 8693), not the Entra access token, so it does not route through the overage resolver.

Still open before sensitive go-live (see [docs/Plan_Review.md](docs/Plan_Review.md)):
attachment object-level ACLs (attachments are not ingested yet), connector-backed membership
oracles for the remaining sources (and repo/team-level granularity for github), and the P2 list
(least-privilege ingestion tokens, observability, prompt-injection hardening beyond the evidence
envelope).

## GDPR right-to-be-forgotten — erasure (`npm run erase`)

Erasure is **two-phase**: a *logical* erase removes/pseudonymizes the rows immediately and records a
receipt; a scheduled *physical* phase (`VACUUM FULL`) overwrites the heap bytes and rebuilds the HNSW
index without the erased vectors. Full operational guidance — the backup/WAL retention residual and
the completion SLA — is in [docs/Erasure_Runbook.md](docs/Erasure_Runbook.md).

```bash
ERASE_MODE=documents ERASE_TARGET=confluence:42,github:owner/repo:doc.md ERASE_SCOPE=DSAR-7  npm run erase
ERASE_MODE=author    ERASE_TARGET="jane.doe"                            ERASE_SCOPE=DSAR-7  npm run erase
ERASE_MODE=subject   ERASE_TARGET=<entra-oid>                           ERASE_SCOPE=DSAR-7  npm run erase  # footprint only
ERASE_MODE=vacuum                                                                          npm run erase  # physical-zeroing phase
```

- **`documents`** — an explicit document-id list (`<source_system>:<external_id>`). Each id is deleted
  (chunks cascade) **and suppressed**, so a still-present source document is not silently re-ingested by
  the next crawl. This is the target of the operator-driven content-*mention* path: search, confirm,
  then erase the confirmed ids — Cerebro never auto-deletes on a fuzzy name match.
- **`author`** — every document by a source-native author string (chunks cascade + suppressed).
- **`subject`** — a person's **access/audit footprint** keyed off their Entra `oid`: their
  `principal_mappings` and `identity_links` user rows are deleted, and their `delegation_audit` rows are
  **pseudonymized** (`subject → erased:<digest>`, preserving the decision record). It does **not** touch
  authored content (an oid doesn't reach `documents.author`) — pair it with an `author` erase for a
  complete DSAR. `delegation_revocations` is deliberately **retained** (deleting a revocation would
  re-enable a denied-but-still-live token); it ages out via its short TTL.

Each run writes an append-only `erasure_log` receipt that stores a **digest** of the target
(`sha256(ERASURE_PEPPER ‖ target)`), not the identifier — accountability is verify-on-demand, so the log
is not itself a store of the personal data it records erasing. Set `ERASURE_PEPPER` to a deployment-wide
secret in production.

> **Assumptions (reversible):** Confluence **Cloud**, **Entra ID** identity, default **`bge-m3`**
> embeddings, single trust domain (no multi-tenancy). Change in `.env` / connector config.
