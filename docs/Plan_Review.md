# Plan Review — AI Knowledge Layer (Cerebro)

**Status:** Reviewed and revised. Companion to [Project_Plan_AI_Knowledge_Layer.md](Project_Plan_AI_Knowledge_Layer.md).

This document records an independent, multi-perspective review of the project plan and the
concrete improvements that came out of it. It was produced by five parallel expert lenses —
architecture & scalability, GDPR/security/permissions, retrieval & generation quality, data
model & ingestion, and cost/ops/roadmap realism — whose findings were de-duplicated and
prioritized. The provable self-contradictions and the highest-leverage safety corrections have
been applied to the plan directly (it's now "v2"); the remaining items are tracked here as a
prioritized backlog.

---

## Verdict

This is a **strong, unusually security-aware plan with sound architectural bones.** It correctly
names permission leakage as the top risk and front-loads ACL work; treats GDPR deletion as a
first-class tombstone concern; commits to the right retrieval architecture (hybrid dense+lexical
with RRF plus cross-encoder reranking); insists on grounded prompting with mandatory citations
and "not found" abstention; and plans an eval harness against silent regressions.

The gaps are **not spread thin — they cluster in a few high-leverage places** where the plan as
written is either incorrect, internally contradictory, or compliance-blocking. Fixing those is
what turns a good design into a safe one.

---

## Provable contradictions (cheap fixes, applied to the plan)

These are inconsistencies visible from the plan text alone — the cheapest, most credible edits:

1. **Eval timing.** Ch.9 placed the eval harness in Phase 3, but Ch.13 says it must measure
   quality "on every change" and Ch.14 says quality must be "measurable from the start." → Moved
   to **Phase 0/1** and made the gate on the embedding-model/chunking decision.
2. **Claude vs. EU residency.** Ch.6.5 invited "any compatible agent (including Claude)" to
   consume retrieval, but retrieved chunks are real enterprise content and the EU-residency NFR
   (Ch.3) is the entire reason the LLM choice is constrained. → MCP/agent consumers constrained to
   EU-resident models unless DPO-approved; recorded in Ch.4.
3. **3072-dim vs. the HNSW ceiling.** Ch.6.3 offered `text-embedding-3-large` (3072-dim), but
   pgvector's `vector` type caps the HNSW index at **2000 dimensions** (verified against pgvector
   docs). → Documented: that model needs `halfvec` (≤4000) or Matryoshka truncation; default
   recommendation is **bge-m3 (1024-dim)**.
4. **"One system to operate."** The pgvector "lean stack" framing is contradicted by the plan's own
   footprint (Redis/BullMQ, embedding server, reranker server, Entra ID, Tika/unstructured). →
   Re-justified pgvector on its real merits (SQL-native ACL/metadata filtering, migratability).
5. **"Fast and correct" ACL pre-filter.** Over an HNSW index the ACL predicate is **post-filtered**,
   so selective users silently get far fewer than _k_ results. → Replaced with a measured
   filtered-ANN strategy (see P1.3).

---

## P1 — Must fix before enterprise (sensitive-source) use

### P1.1 — The ACL model can't express real source permissions
A set-overlap test (`acl_principals && :user_groups`) only models **allow-lists**. Confluence page
restrictions and SharePoint/Teams support **explicit DENY and inheritance breaks**, so a user in an
allowed group who is individually denied at source would be served the content via the AI. Required:
- Store the **effective resolved read-set** per chunk (each connector's `resolvePermissions`
  flattens layered permissions and resolves **deny-over-allow** at ingest).
- A **principal-normalisation layer** mapping GitLab/Confluence account ids into the Entra namespace
  (query time resolves only Entra groups); expand **transitive (nested) group membership**.
- Reserved pseudo-principals (`PUBLIC` / `ALL_USERS`) for unbounded ACLs.
- **Fail-closed invariants:** no resolved groups (Entra error/timeout) → empty result; empty chunk
  ACL → treated as non-public unless explicitly certified public. **An unresolved source ACL must
  map to _no principals_ (invisible), never to `public`** — a silent permission-lookup failure that
  defaults to public is a leak. (The MVP `SampleConnector.normalizeAcl` defaults seed docs to
  `public` for demo convenience and is explicitly annotated as seed-only — real connectors invert
  this default.)
- Attachment ACLs resolved at the **object level**, not inherited from the parent page.
- All of the above become **automated Phase-2 exit-gate tests** (deny-over-allow, inheritance break,
  attachment-vs-page divergence, cross-source mapping, fail-closed-on-Entra-outage).

### P1.2 — End-user identity must reach the SQL filter on every path, including MCP
MCP servers conventionally run under a single service credential, so the requesting employee's Entra
identity does not automatically reach the tool call — meaning **the agent path can bypass ACL
filtering entirely** (the exact catastrophic leak Ch.7 exists to prevent). Required: per-user
OAuth/OIDC token pass-through into every MCP tool invocation; the retrieval tool **hard-rejects any
request lacking a resolvable end-user identity** (no service-credential fallback that returns
unfiltered results). Invariant: _no consumer, agent or REST, ever receives results computed without
an applied ACL filter._
> Applied in code: the MCP server (`src/mcp/mcp-server.ts`) requires caller principals; without
> them, results are restricted to public content (fail-closed), never the whole corpus.

### P1.3 — Filtered-ANN recall (HNSW post-filtering)
With HNSW the ACL predicate is post-filtered, so a user with selective group membership (the common
case) gets the top-`ef_search` candidates discarded down to far fewer than _k_ — silently degrading
recall **per user**, which is invisible in aggregate metrics. Commit to a concrete strategy:
pgvector 0.8.0+ `hnsw.iterative_scan` with a measured `hnsw.ef_search` budget, and/or
partial/partitioned HNSW indexes keyed by a coarse ACL domain. Add **Recall@k segmented by user
permission breadth** as a first-class eval metric. Budget the knob against the p95 < 3–5 s SLO.
> Applied in code: `RetrievalService` sets `hnsw.iterative_scan` + `hnsw.ef_search` per query.

### P1.4 — GDPR right-to-be-forgotten is a hard NFR assigned to no phase
Deletion appears in no roadmap phase and is never sized, and the concept stops at "source doc
deleted → vectors removed." Expand to a full **erasure pipeline**, scheduled in Phase 2 with an
owner and audit trail: (a) document deletion **and** person-level DSAR erasure (spanning chunks
across many documents); (b) scheduled **VACUUM/REINDEX** so HNSW data is physically zeroed, not just
tombstoned (pgvector defers physical deletion until VACUUM); (c) a backup/WAL/PITR re-erasure or
rolling-retention policy so restores don't resurrect erased data; (d) propagation to all derived
copies (answer caches, reranker payloads, BullMQ job payloads, audit logs, provider retention);
(e) a stated erasure-completion SLA.

### P1.5 — Stable ingestion identity, idempotency, reconciliation-based deletion
The DocModel had only `id` + `updated_at`; the tombstone mechanism was asserted, not designed. Since
BullMQ and webhooks are **at-least-once**, replay otherwise duplicates and orphans chunks. Required:
deterministic keys (`document_id = hash(source_instance_id, source_native_id)`,
`chunk_id = hash(document_id, ordinal)`), a per-document `content_hash`, ingestion as a single
transaction that upserts current chunks and deletes any chunk whose ordinal no longer exists; a
**periodic reconciliation sweep** (enumerate live source ids, tombstone anything indexed but absent)
as the primary deletion mechanism (webhooks are an optimization — CQL `lastModified` and Graph delta
never report deletions); a durable per-connector cursor; a **dead-letter queue**; and an
**embedding-pipeline concurrency cap** sized to embedder TPM/GPU (backpressure is currently only
modelled for source APIs, not the embedder — the initial full crawl will saturate it).
> Applied in code: `content_hash` idempotency, transactional delete-then-insert chunks, and
> crawl-vs-stored reconciliation are implemented in `IngestionService`.

### P1.6 — Move the eval harness + gold set to Phase 0/1 and gate the model decision
The embedding model, dimensionality, chunking, and schema are committed in Phases 0–1 and are the
most expensive to reverse (full re-embed). Move a minimal Recall@k/MRR + faithfulness harness and
the gold set into Phase 0/early Phase 1, wire into CI, and make a Recall@k threshold the explicit
gate. The gold set must **label relevant chunks** (not just QA pairs) and include **cross-lingual**
(DE-query/EN-doc) and **ACL-filtered** cases.
> Applied in code: `eval/gold.json` + `src/scripts/eval.ts` — gates on Recall@k and treats any ACL
> leak as a hard failure; cross-lingual cases included and reported separately under the fake model.

---

## P2 — Important, address during Phases 1–2

- **EU residency across the whole path.** Hosted Cohere Rerank receives content chunks → require
  private VPC or self-hosted `bge-reranker`. Azure OpenAI retains prompts ~30 days in an
  abuse-monitoring store → require approved zero-data-retention (Phase-0 lead time). Embeddings
  egress the **whole corpus** at ingest, not just queries. Add a transfer-impact assessment + SCCs
  (CLOUD Act exposure for US-controlled providers even in an EU region).
- **Decouple ACL refresh from content sync.** Revocation is the dangerous direction: a removed user,
  or a tightened restriction on an unchanged page, is never re-evaluated because content-delta sync
  never fires. Give ACL refresh its own faster SLA; make late-binding **mandatory** (not optional)
  for sensitive spaces, run before generation, fail closed if the source API is unreachable.
- **Embedding-model versioning + blue/green re-index.** Add `embedding_version`/`chunking_version`
  columns; dual-write/backfill a new index, validate against gold, atomically cut over — never mix
  versions in a live index. _(Applied in code: `embedding_model` column on `chunks`.)_
- **Ship the full ACL schema in Phase 1** even with enforcement deferred (retrofitting later forces a
  full re-ingest). Certify any "non-sensitive" Phase-1 space as PII-free before ingest.
- **Observability + cost model in Phase 1.** Per-query structured logs (retrieved chunk ids/scores),
  per-stage latency tracing (ACL→hybrid→RRF→rerank→LLM), token/cost counters, 👍/👎 widget; an
  explicit cost/TCO model (initial-crawl tokens, per-query inference, storage growth, and for
  self-hosting concrete GPU instance type/count/run-rate) with a budget ceiling + alert.
- **Prompt injection / untrusted content.** Indexed content is user-writable → indirect prompt
  injection, made worse by agentic tool-calling. Treat retrieved content as data not instructions
  (delimited/role-isolated); output-encode rendered text; **allow-list citation link domains** to
  known source hosts; never auto-load remote images; gate agent tool calls behind policy. Write
  access to an indexed space is a privilege-escalation surface. _(Partially applied: the grounded
  prompt wraps evidence in an untrusted-data envelope.)_
- **Least-privilege ingestion service account.** "Index everything then filter" makes the ingestion
  token a super-user and the ACL filter the sole barrier — a leak compromises the whole corpus.
  Mandate read-only, scoped-per-connector, rotated tokens; monitor the ingestion identity.
- **Commit to Confluence Cloud vs. Data Center now** (it determines auth, delta, webhooks,
  permission APIs, rate limits — not a config flag). Replace the naive storage-format loader with the
  rendered `view`/`export_view` representation + a macro-aware sanitizer (`ac:`/`ri:` markup, deep
  links), OCR for scanned PDFs, and per-attachment size/timeout/quarantine limits.

---

## P3 — Quality, hardening, operations

- **Strengthen the lexical arm.** Postgres `ts_rank` has no IDF and doesn't decompound German
  compounds (e.g. *Datenschutzgrundverordnung*) — weak exactly where exact-term matching matters.
  Prefer bge-m3 **native sparse vectors** or a real BM25 extension (ParadeDB / VectorChord-bm25).
  Specify RRF operationally: fixed `k≈60`, **weighted** per-retriever weights tuned on the gold set;
  make `k`/weights/top-k sweepable.
- **Per-content-type chunking.** The uniform recipe fits prose but fragments code and merges
  unrelated chat. Structure-aware prose (keep tables/code intact), function/class-aware code
  splitting (name the parser, e.g. tree-sitter), thread/message-window chat chunking.
- **Reranker funnel + latency budget.** hybrid top-50 → `bge-reranker-v2-m3` (multilingual) → top-5;
  budget reranker + embedding + generation against p95 3–5 s.
- **Machine-checkable citations + faithfulness gate.** The model emits chunk ids the system verifies
  are in-context and support the claim; a post-generation NLI/LLM-judge groundedness gate can force
  abstention. Treat citation accuracy + faithfulness as **computed, gated** metrics.
- **Cross-lingual validation + model prefix footgun.** Add DE↔EN cases to the gold set;
  `multilingual-e5` requires `query:`/`passage:` prefixes (silent quality halving if omitted),
  bge-m3 and text-embedding-3-large do not.
- **Postgres read/write separation + SPOF capacity.** Bulk ingest + HNSW maintenance contend with
  low-latency serving — plan a read replica for serving; give the self-hosted embedder/reranker
  capacity/autoscaling/failover notes; load-test a full re-index concurrent with query traffic.
- **CI/CD, staging, migration tooling, rollback.** Add CI gates, a staging env, a migration
  framework, a tested rollback, on-call ownership + runbooks (token expiry, webhook outage, Entra
  failure, GPU down, vector store degraded), and a Postgres DR posture with RPO/RTO (including the
  re-embedding recovery cost).
- **Actionable risk table + gated metrics.** Each risk row gets an owner, a detection signal, and a
  trigger threshold; add rows for connector/source-API drift, GPU cost spike, the pgvector/HNSW
  scaling cliff (with a corpus-size migration trigger to Qdrant), prompt injection, and bus factor.
  In Ch.12, attach numeric targets, baselines, and per-phase go/no-go gates — including an
  ACL-correctness gate before exposing sensitive sources.
- **Audit-log schema + German works council.** Query text can be Art. 9 special-category data; an
  audit log records the ACL decision (user, chunk ids, allow/deny, timestamp) with bounded retention
  and restricted access. **German works-council co-determination (Betriebsrat/Mitbestimmung)** on
  employee-monitoring data is a Phase-0 legal gate alongside DPO sign-off — it can block go-live.
- **Roadmap realism.** ~11–14 weeks for Phases 0–3 with 2–3 people is optimistic; split Phase 2
  (ACL + Entra + full GitLab connector) into separate milestones; mark GDPR sign-off/DPAs as an
  external critical-path dependency with weeks-to-months lead time and run a parallel non-sensitive
  track. State one assumption line: **single trust domain / single tenant** — no hard data-isolation
  boundary; a tenant partition key + per-tenant index would be needed if that ever changes (do not
  build multi-tenancy now).
