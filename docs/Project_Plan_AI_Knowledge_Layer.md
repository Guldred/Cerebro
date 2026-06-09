# Project Plan: AI Knowledge Layer

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
| Confluence variant | Cloud vs. Data Center (different APIs) | determines connector implementation |
| Data sensitivity level | Assumption: mixed, partly access-restricted | decides whether permissions are needed from the MVP |

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

- **Embedding model:** multilingual, since content is DE + EN. Options: `bge-m3` or `multilingual-e5` (self-hosted, GDPR-friendly, also produce both dense and sparse vectors) or Azure OpenAI `text-embedding-3-large` (EU region). Self-hosted saves running costs, Azure saves operational effort — decide the trade-off in Phase 0.
- **Vector store: pgvector in PostgreSQL.** Rationale: only **one** system to operate, metadata and permission filtering directly in SQL, an HNSW index for fast ANN search, and full-text search (`tsvector`) lives in the same DB. This keeps the stack lean and leverages existing Postgres/NestJS know-how. Trade-off: for very large corpora (tens of millions of chunks) or advanced hybrid features, a dedicated store (Qdrant, Weaviate) may be superior later — but pgvector is the pragmatic and migratable start.

### 6.4 Retrieval Layer

- **Hybrid search:** dense vector search (pgvector) + lexical search (Postgres FTS), fused via Reciprocal Rank Fusion. Captures both semantic proximity and exact terms/proper names.
- **Metadata pre-filtering:** by source system and — crucially — by permission (see Chapter 7).
- **Re-ranking:** a cross-encoder (`bge-reranker` self-hosted or Cohere Rerank) precisely reorders the top-k. This is often the biggest quality lever for manageable effort.
- **Output:** the best N chunks together with `source_url` and metadata to the generation layer.

### 6.5 RAG / Agent Layer

The agent receives the retrieved evidence and a prompt instructing it to answer **exclusively from the provided context**, to substantiate every statement, and to say "not found" when the evidence is insufficient — this is the most effective measure against hallucinations. Every answer references its sources; the UI renders them as clickable links (`Source: [page title](url)`).

A recommendation that fits your agentic approach: **expose the knowledge layer as an MCP server / tool.** Then any compatible agent (including Claude) can invoke the retrieval function as a tool, instead of hardwiring RAG. Orchestration kept lean via LlamaIndex or a custom NestJS implementation.

### 6.6 API & Interfaces

- Internal API (REST/gRPC): `POST /query` (question → answer + citations) and `POST /search` (raw retrieval without generation).
- As an MCP server for agent consumption.
- **Auth:** SSO via Entra ID (OIDC); the user identity is propagated so retrieval can filter in a permission-aware manner.

---

## 7. Permissions & Security

This is the most demanding and most frequently underestimated part. Without a clean solution you risk the most serious failure of an enterprise knowledge layer: a user getting to see, via the AI, content that is denied to them in the source system ("permission leakage").

**Approach (recommended, early binding):** During ingestion, the authorized principals (groups/users) are stored as metadata per chunk. At query time, the user's group memberships are resolved from Entra ID and retrieval is hard-filtered on them via SQL (`WHERE acl_principals && :user_groups`). Fast and correct for the majority of cases.

**Supplement (late binding) for especially sensitive areas:** an additional live check of retrieved hits against the current source permission — more accurate with rapidly changing rights, but slower. Pragmatically: early binding with periodic ACL refresh as the default, late binding optional for defined spaces.

**Further points:**

- **GDPR:** EU data residency, deletion pipeline (source document deleted → corresponding vectors removed), data processing agreements with cloud providers, audit logging.
- **Secrets:** source API tokens in a secret manager (Vault / Azure Key Vault), never in code.
- **Audit:** logging of queries (who/what) for traceability — weighed against data minimization, to be coordinated with the DPO.

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

**Phase 0 — Discovery & Setup (1–2 weeks).** Source prioritization, API access/tokens, GDPR sign-off, decision on embedding/LLM hosting, set up infrastructure. *Outcome:* architecture decisions made, a running base infrastructure.

**Phase 1 — MVP, one source end-to-end (3–4 weeks).** Confluence connector → pipeline → pgvector → basic RAG → lean UI or Teams bot. Initially without permission logic (non-sensitive space). *Outcome:* a robust proof that retrieval and citation quality hold up.

**Phase 2 — Permissions + second source (3–4 weeks).** ACL-aware retrieval, Entra ID integration, connect GitLab. The make-or-break phase for enterprise use. *Outcome:* demonstrably permission-safe delivery.

**Phase 3 — Quality & multi-source (3–4 weeks).** Hybrid search + re-ranking, connect Teams, incremental delta syncs via webhooks, build an eval harness. *Outcome:* measurably improved answer quality, current data.

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
