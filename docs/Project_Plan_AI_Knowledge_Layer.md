# Project Plan: AI Knowledge Layer

> **v2 — reviewed & in implementation.** This plan has been through a multi-perspective review;
> the prioritized findings and the full improvement backlog are in
> [Plan_Review.md](Plan_Review.md). Corrections to provable contradictions and critical safety
> items are folded in below. A runnable MVP vertical slice exists — see the repo
> [README](../README.md). Codename: **Cerebro**.

**Goal:** A central, vectorized knowledge layer that consolidates data from heterogeneous enterprise sources (Confluence, GitLab, MS Teams, and others), makes it semantically searchable, and serves as a knowledge base for an AI agent. Users receive answers **including a link to the source** for the respective original resource.

---

## 1. Vision

The knowledge layer is the central, queryable layer of truth over the company's distributed knowledge. Instead of searching in five systems, an employee asks a question in natural language and receives a well-founded answer based exclusively on the actual content of the connected systems — with a direct deep link to the original source, so the answer stays verifiable and the user can dig deeper when needed.

Technically, the system consists of three layers: **Ingestion** (connect sources, collect content, process it, embed it), **Retrieval** (semantic + lexical search with permission filtering), and **Generation** (the AI agent that synthesizes a cited answer from the retrieved evidence).

---

## 2. Functional Requirements

- Connect multiple source systems via interchangeable connectors (start: Confluence, GitLab, MS Teams; extensible).
- Initial full indexing plus incremental updates (changes, new items, deletions).
- Vectorized storage of content for semantic search, combined with lexical search (hybrid search).
- Retention of source metadata per content chunk: **deep link to the source**, title/breadcrumb, author, modification date, source system, access permissions.
- AI agent that answers questions based solely on retrieved evidence and substantiates every answer with source links.
- **Permission-aware delivery:** results only from documents the requesting user is allowed to see in the source.
- Provision as an API/tool so the agent (and, going forward, additional agents) can consume the layer.

## 3. Non-Functional Requirements

- **GDPR compliance:** EU data residency, deletion concept (right to be forgotten down to the vector level), data processing agreements with the cloud services in use, audit logging.
- **Answer latency:** target p95 < 3–5 s for a complete RAG answer.
- **Data freshness:** delay between a source change and index update ideally < 1 h (webhooks) or < 24 h (polling fallback).
- **Operability:** as few standalone systems as possible; reproducible deployment.
- **Scalability:** designed for growth in sources and user count without architectural breakage.

---

## 4. Assumptions & Open Decisions

Settle these definitively in Phase 0 — they have the greatest leverage on architecture and effort:

| Decision | Recommendation / Assumption | Why it's critical |
|---|---|---|
| LLM & embedding hosting | Azure OpenAI (EU region) **or** self-hosted open-source models | GDPR; determines cost and data egress |
| Multilingualism | Content is DE **and** EN → multilingual embedding model mandatory | wrong model = poor German retrieval |
| Identity provider | Azure AD / Entra ID (M365 environment present) | basis for permission-aware search |
| Confluence variant | **Commit to Cloud OR Data Center for the MVP now** (default: Cloud) — scope the other as a separately budgeted connector | it determines auth (OAuth/Forge vs. PAT), delta, webhook registration, permission APIs and rate limits — not a config flag |
| Data sensitivity level | Assumption: mixed, partly access-restricted | decides whether permissions are needed from the MVP |
| Agent/MCP consumer residency | EU-resident models only, unless DPO-approved carve-out | retrieved chunks are enterprise content; egress to a non-EU LLM defeats the residency NFR |
| Trust domain | Single trust domain / single tenant — no hard data-isolation boundary | a tenant partition key + per-tenant index would be needed if this changes; do **not** build multi-tenancy now |

---

## 5. Architecture Overview

```
 SOURCES                  INGESTION PIPELINE                  STORAGE
┌────────────┐      ┌──────────────────────────────┐      ┌──────────────────┐
│ Confluence │─┐    │ 1. Connector (pull/webhook)  │      │  PostgreSQL      │
│ GitLab     │─┼──▶ │ 2. Loader/parser (HTML, MD,  │ ───▶ │  ├─ pgvector     │
│ MS Teams   │─┘    │    code, PDF/Office)         │      │  │  (embeddings) │
│ (…)        │      │ 3. Normalization → DocModel  │      │  ├─ tsvector     │
└────────────┘      │ 4. Chunking + metadata/ACL   │      │  │  (full-text)  │
                    │ 5. Embedding                 │      │  └─ metadata/ACL │
                    └──────────────────────────────┘      └──────────────────┘
                                                                    │
 USER / AGENT             RETRIEVAL & GENERATION                    │
┌────────────┐      ┌──────────────────────────────┐               │
│ Chat UI    │      │ Query → ACL filter (user     │ ◀─────────────┘
│ Teams bot  │ ◀──▶ │   groups from Entra ID)      │
│ MCP client │      │ → Hybrid search (vector+FTS) │
└────────────┘      │ → Re-ranking (cross-encoder) │
                    │ → LLM answer with citations  │
                    └──────────────────────────────┘
```

**Data flow:** Connectors pull content (initial full crawl, then deltas via webhook/polling) → parsers convert source-specific formats into a unified document model → chunking splits content into searchable blocks with attached metadata **including access permissions** → embeddings + full text land in Postgres → on a query, the system first filters by the user's group memberships, then searches hybrid, re-ranks, and hands the best evidence to the LLM, which produces a cited answer.

---

## 6. Core Components

### 6.1 Source Connectors

Each connector implements a common interface (`initialCrawl`, `deltaSync`, `resolvePermissions`) and can be deployed and extended independently.

- **Confluence:** REST API (CQL queries), fetches pages + attachments, retains space/page hierarchy and the page URL. Incremental via `lastModified`. Permissions from space and page restrictions.
- **GitLab:** REST/GraphQL API with a project access token. Relevant: READMEs, `docs/`, wikis, issue and merge request descriptions, optionally source code (function/class-aware chunking). Permission = project membership.
- **MS Teams:** Microsoft Graph API for channel messages, wikis, and files (SharePoint/OneDrive-backed). Incremental via Graph delta queries / change notifications. Permission via Entra ID / M365 groups.

**Sync strategy:** Initial full crawl, then event-driven via webhooks (Confluence, GitLab) or Graph change notifications (Teams), with scheduled polling as a fallback. Deleted source documents are detected via tombstones and their vectors removed (also GDPR-relevant).

### 6.2 Ingestion & Processing Pipeline

One loader per content type: HTML (Confluence storage format), Markdown, code, plus text extraction from PDF/Office attachments (e.g., Apache Tika or `unstructured`). Everything is normalized into a unified document model:

```
{ id, source_system, source_url, title, breadcrumb, body,
  author, created_at, updated_at, acl_principals[], content_type }
```

**Chunking:** structure-aware (split on headings) and size-bounded (~512–1024 tokens) with ~10–15 % overlap. The heading path is retained as metadata — this improves answer quality and enables **section-precise deep links** (e.g., an anchor to the right Confluence heading rather than just the page).

### 6.3 Embedding & Vector Store

- **Embedding model:** multilingual, since content is DE + EN. **Default recommendation: `bge-m3` (1024-dim dense + native sparse, 8192-token context, EU-self-hostable)** — its sparse output also strengthens the hybrid lexical arm. Alternatives: `multilingual-e5` (note: requires `query:`/`passage:` prefixes — silent quality halving if omitted) or Azure OpenAI `text-embedding-3-large` (EU region). **Dimensionality constraint:** pgvector's `vector` type caps the **HNSW index at 2000 dimensions**; `text-embedding-3-large` is 3072-dim, so it requires `halfvec` (HNSW supports ≤4000 half-precision dims) or Matryoshka truncation to ≤2000, at ~2× storage/index cost. The chunker's tokenizer must match the chosen model. Self-hosted saves running costs but means operating GPU serving (vLLM/TGI); Azure saves operational effort — decide with a cost model in Phase 0.
- **Vector store: pgvector in PostgreSQL.** Rationale: **SQL-native ACL/metadata filtering** (the `&&` permission predicate and `tsvector` live in the same transactional store, avoiding drift), an HNSW index for fast ANN search, and a clean migration path to a dedicated store later. It leverages existing Postgres/NestJS know-how. Note the overall footprint is **not** a single system — it also includes Redis (BullMQ), a self-hosted embedding server, a reranker server, the Entra ID dependency and Tika/unstructured workers; pgvector removes the *separate vector DB*, not the rest of the stack. Trade-off: for very large corpora (tens of millions of chunks) a dedicated store (Qdrant, Weaviate) may be superior later — but pgvector is the pragmatic and migratable start.

### 6.4 Retrieval Layer

- **Hybrid search:** dense vector search (pgvector) + lexical search, fused via **weighted** Reciprocal Rank Fusion (fixed `k≈60`, per-retriever weights tuned on the gold set; unweighted RRF can score below dense-only when the dense model dominates). For the lexical arm, prefer `bge-m3` native sparse vectors or a BM25 extension (ParadeDB / VectorChord-bm25) over Postgres `ts_rank`, which lacks IDF and does not decompound German compounds (e.g. *Datenschutzgrundverordnung*). Index **title + heading path + content** ("contextual chunk headers") so heading-only terms stay retrievable, and use OR-semantics for the lexical query. `k`, weights and top-k are tunable parameters the eval harness sweeps. *(MVP: implemented as pgvector cosine + Postgres FTS with the OR-rewrite and contextual headers; sparse/BM25 is the upgrade path.)*
- **Metadata pre-filtering:** by source system and — crucially — by permission (see Chapter 7). Over HNSW the ACL predicate is **post-filtered**, so enable pgvector 0.8+ `hnsw.iterative_scan` with a measured `ef_search` budget to keep recall for narrow-permission users.
- **Re-ranking:** a multilingual cross-encoder (`bge-reranker-v2-m3` self-hosted, or Cohere Rerank in a private VPC for residency) reorders the funnel (hybrid top-50 → rerank → top-5 to the LLM). Often the biggest quality lever for manageable effort; budget its latency against the p95 SLO.
- **Output:** the best N chunks together with `source_url` and metadata to the generation layer.

### 6.5 RAG / Agent Layer

The agent receives the retrieved evidence and a prompt instructing it to answer **exclusively from the provided context**, to substantiate every statement, and to say "not found" when the evidence is insufficient — this is the most effective measure against hallucinations. Every answer references its sources; the UI renders them as clickable links (`Source: [page title](url)`).

**Untrusted content & faithfulness.** Indexed content is user-writable, so retrieved text is treated as **data, not instructions** (role-isolated/delimited context — implemented as an untrusted-data envelope in the grounded prompt). Rendered output is encoded; **citation links are allow-listed to known source hosts**; remote images are never auto-loaded; agent tool calls are gated behind policy. Write access to an indexed space is a privilege-escalation surface. Faithfulness and citation accuracy are **computed, gated** metrics (the model emits citations the system verifies are in-context; a post-generation NLI/LLM-judge gate can force abstention) — not prompt aspirations.

A recommendation that fits your agentic approach: **expose the knowledge layer as an MCP server / tool.** Then any compatible agent can invoke the retrieval function as a tool, instead of hardwiring RAG. **Constraint:** because retrieved chunks are actual enterprise content, MCP/agent consumers must be **EU-resident models** to honour the residency NFR; using a non-EU-resident agent (e.g. a hosted US API) requires explicit DPO sign-off recorded in the Ch.4 table. Orchestration kept lean via a custom NestJS implementation. *(MVP: implemented — `cerebro_query`/`cerebro_search` MCP tools reuse the same retrieval/RAG services and require caller principals.)*

### 6.6 API & Interfaces

- Internal API (REST/gRPC): `POST /query` (question → answer + citations) and `POST /search` (raw retrieval without generation).
- As an MCP server for agent consumption.
- **Auth:** SSO via Entra ID (OIDC); the end-user identity is propagated to retrieval on **every** path. **Invariant:** each MCP tool invocation must carry a per-user OAuth/OIDC token (not a shared service credential); the retrieval tool rejects any request lacking a resolvable end-user identity and **never returns results computed without an applied ACL filter**. A service-credential MCP call that bypasses the filter is the catastrophic permission-leakage case and is prohibited.

---

## 7. Permissions & Security

This is the most demanding and most frequently underestimated part. Without a clean solution you risk the most serious failure of an enterprise knowledge layer: a user getting to see, via the AI, content that is denied to them in the source system ("permission leakage").

**Approach (recommended, early binding):** During ingestion, each connector's `resolvePermissions` computes the **effective resolved read-set** per chunk — flattening layered/inherited source permissions and resolving **deny-over-allow** (Confluence space+page restrictions and inheritance breaks; GitLab role/visibility/inherited subgroup access; Teams/SharePoint inheritance), mapping GitLab/Confluence principals into the **Entra namespace** via a principal-mapping table, expanding **transitive (nested) Entra groups**, and using reserved pseudo-principals (`PUBLIC`/`ALL_USERS`) for unbounded ACLs. Attachment ACLs are resolved at the **object level**, not inherited from the parent. At query time the user's resolved groups hard-filter retrieval via SQL (`WHERE acl_principals && :user_groups`).

> A bare set-overlap test only models allow-lists, so deny/inheritance resolution above is **mandatory** — not optional. **Fail-closed invariants:** if no user groups resolve (Entra error/timeout) → empty result; an empty chunk ACL is treated as non-public unless explicitly certified public. **Filtered-ANN caveat:** over an HNSW index this predicate is post-filtered, so selective users can silently receive far fewer than _k_ results — mitigate with pgvector 0.8+ `hnsw.iterative_scan` and/or partial indexes keyed by a coarse ACL domain, and track **Recall@k segmented by permission breadth**. These become automated Phase-2 exit-gate tests (deny-over-allow, inheritance break, attachment-vs-page divergence, cross-source mapping, fail-closed-on-Entra-outage).

**Supplement (late binding) for especially sensitive areas:** an additional live check of retrieved hits against the current source permission — more accurate with rapidly changing rights, but slower. Pragmatically: early binding with periodic ACL refresh as the default, late binding optional for defined spaces.

**Further points:**

- **GDPR — erasure pipeline (scheduled in Phase 2, owned, sized):** EU data residency plus a full erasure pipeline covering (a) document deletion **and** person-level DSAR erasure spanning chunks across documents; (b) scheduled **VACUUM/REINDEX** so HNSW data is physically zeroed, not just tombstoned (pgvector defers physical deletion until VACUUM); (c) a backup/WAL/PITR re-erasure or rolling-retention policy so restores don't resurrect erased data; (d) propagation to all derived copies (answer caches, reranker payloads, BullMQ job payloads, audit logs, provider retention); (e) a stated erasure-completion SLA. Plus DPAs/SCCs (CLOUD Act exposure even in an EU region) and approved Azure OpenAI zero-data-retention.
- **Secrets & ingestion identity:** source API tokens are **least-privilege, read-only, scoped per connector**, in a secret manager (Vault / Azure Key Vault), rotated, and monitored. Because the design indexes everything then filters, this identity is a super-user and the ACL filter is the sole barrier — a token leak compromises the whole corpus.
- **Audit:** an audit log records the **ACL decision** (user, chunk ids, allow/deny, timestamp) — sufficient to prove non-leakage while minimizing stored query/answer content (query text can be Art. 9 special-category data), with bounded retention and restricted access. **German works-council co-determination (Betriebsrat/Mitbestimmung)** on employee-monitoring data is a Phase-0 legal gate alongside DPO sign-off — it can block go-live.

---

## 8. Recommended Tech Stack

| Layer | Recommendation | Trade-off / Alternative |
|---|---|---|
| Backend / orchestration | NestJS (TypeScript) | proven, good DI model; Python possible if ML tooling dominates |
| Vector store + full-text + metadata | PostgreSQL + pgvector + tsvector | one system; dedicated store (Qdrant) for very large corpora |
| Embedding | bge-m3 / e5 (self-hosted) or Azure OpenAI EU | cost vs. operational effort |
| Re-ranking | bge-reranker / Cohere Rerank | optional from Phase 3, high quality lever |
| LLM | Azure OpenAI (EU) or self-hosted | GDPR determines the choice |
| Identity | Entra ID (OIDC) | present in the M365 environment |
| Pipeline/jobs | queue-based (e.g., BullMQ) + webhooks | for incremental syncs |
| Interface | REST/gRPC + MCP server | agent-friendly |

---

## 9. Roadmap / Phases

*Effort estimates indicative for a team of ~2–3 people; adjust to your capacity before starting.*

*Note: GDPR sign-off / DPAs is an external critical-path dependency (legal/procurement run weeks-to-months) — start it in Phase 0 and run a parallel non-sensitive track so it doesn't block the program. Effort estimates are optimistic; treat them as lower bounds.*

**Phase 0 — Discovery & Setup (1–2 weeks).** Source prioritization, API access/tokens, GDPR sign-off + Betriebsrat gate, decision on embedding/LLM hosting **gated by a Recall@k threshold** on the gold set, a **cost/TCO model** (initial-crawl tokens, per-query inference, storage, GPU run-rate) with a budget ceiling, and base infrastructure. **Stand up the eval harness + gold set here** (moved earlier — see below). *Outcome:* architecture decisions made and measured, running base infrastructure.

**Phase 1 — MVP, one source end-to-end (3–4 weeks).** Confluence connector → pipeline → pgvector → basic RAG → lean UI or Teams bot. Permission **enforcement** deferred (non-sensitive space, certified PII-free by a named owner) but the **full ACL schema ships day one** (per-chunk principals, principal-mapping table, version/content_hash columns, tombstones) to avoid a later full re-ingest. MVP exit criteria also include per-query structured logs (chunk ids/scores), per-stage latency tracing (ACL→hybrid→RRF→rerank→LLM), token/cost counters, and a 👍/👎 widget. *Outcome:* a Recall@k/MRR + faithfulness eval harness running in CI on an SME-built gold set that **labels relevant chunks** (not just QA pairs) and includes cross-lingual (DE↔EN) and ACL-filtered cases, gating the embedding-model/chunking decision.

**Phase 2 — Permissions + erasure + second source (split into milestones).** ACL-aware retrieval with deny/inheritance resolution, Entra ID integration + principal mapping, the GDPR erasure pipeline (owned, sized, audited), then connect GitLab. The make-or-break phase for enterprise use. *Outcome:* demonstrably permission-safe delivery with passing ACL exit-gate tests.

**Phase 3 — Quality & multi-source (3–4 weeks).** Re-ranking funnel, stronger lexical arm (sparse/BM25), connect Teams, incremental delta syncs via webhooks + reconciliation sweeps. *Outcome:* measurably improved answer quality, current data. *(The eval harness was moved to Phase 0/1 — it must exist before the most expensive-to-reverse decisions.)*

**Phase 4 — Hardening, scaling & operations (ongoing).** Monitoring, cost control, feedback loop, automated re-indexing, load tests.

---

## 10. Team & Roles

- **Backend/data engineering:** connectors, pipeline, data model.
- **ML/AI engineering:** retrieval, RAG, re-ranking, evaluation.
- **DevOps:** infrastructure, deployment, monitoring, secrets.
- **Product owner / subject-matter experts (SMEs):** prioritization, quality assessment, adoption.
- **Security / data protection officer:** advisory, particularly for Chapter 7.

---

## 11. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Permission leakage | very high | medium | ACL-aware retrieval + test coverage, early Phase 2 |
| Hallucinations | high | medium | grounded prompting, citation requirement, "not found" behavior |
| Stale data | medium | high | incremental syncs, scheduled re-indexing, tombstones |
| Source API rate limits | medium | medium | backoff, incremental instead of full, caching |
| Embedding/LLM cost | medium | medium | batching, open-source models, caching frequent queries |
| Low retrieval quality | high | medium | hybrid search + re-ranking + eval harness |
| Scope creep | medium | high | strictly phased MVP, one source first |
| GDPR violation | very high | low | EU residency, deletion concept, DPO sign-off |

---

## 12. Success Criteria & Metrics

- **Retrieval quality:** Recall@k, MRR against a curated question-answer gold standard.
- **Answer quality:** faithfulness/groundedness (RAGAS-style), citation accuracy, human spot-check evaluation.
- **System:** p95 latency, data-freshness lag.
- **Adoption:** queries per user, thumbs-up/down rate.
- **Cost:** cost per query.

## 13. Operations & Maintenance

Build an **eval harness** (a fixed set of representative questions with target answers) that automatically measures quality on every change to chunking, model, or retrieval — this prevents silent regressions. Complement it with a **feedback loop** (👍/👎 in the UI) whose data feeds into improvement, scheduled re-indexing, monitoring/alerting for pipeline and latency, and a cost dashboard.

---

## 14. Next Steps

1. Make the Phase 0 decisions from Chapter 4 (above all LLM/embedding hosting and identity provider).
2. Obtain API access and tokens for Confluence, secure GDPR sign-off.
3. Set up Postgres + pgvector, define the document model and chunking strategy.
4. Build the Confluence connector as the first end-to-end slice (Phase 1).
5. Create an eval gold standard with the subject-matter experts to make quality measurable from the start.
