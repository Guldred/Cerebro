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
| Connectors | `sample` (reads `seed/*.md`) + **Confluence Cloud** (REST/CQL, mock-tested) | GitLab, Teams; Confluence deny/inheritance + Entra principal mapping (Phase 2) |
| Retrieval | hybrid vector+FTS, RRF, HNSW iterative-scan, ACL pre-filter | cross-encoder reranking, BM25 lexical arm |
| Permissions | per-chunk `acl_principals`, hard SQL filter, fail-closed | Entra ID OIDC, deny/inheritance resolution, principal mapping (Phase 2) |
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

Try it (the `x-cerebro-principals` header stands in for the caller's Entra groups — Phase 2
replaces it with a validated OIDC token):

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

# PERMISSION-AWARE: the restricted "Salary Bands" doc...
#   ...as a public caller → "Not found", no leak:
curl -s -X POST localhost:3000/query -H 'content-type: application/json' \
  -H 'x-cerebro-principals: public' \
  -d '{"question":"What do the engineering salary bands cover?"}' | jq .answer
#   ...as an hr caller → grounded answer + citation:
curl -s -X POST localhost:3000/query -H 'content-type: application/json' \
  -H 'x-cerebro-principals: hr' \
  -d '{"question":"What do the engineering salary bands cover?"}' | jq

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

The MVP demonstrates the **mechanism** (per-chunk ACL, hard SQL filter, fail-closed default, public
caller cannot retrieve restricted docs). Before connecting sensitive sources, the **Phase-2**
hardening in [docs/Plan_Review.md](docs/Plan_Review.md) is required — notably: resolving
deny/inheritance into an effective read-set, cross-source principal mapping to Entra, per-user
identity on the MCP path (no service-credential fallback), and the full GDPR erasure pipeline.

> **Assumptions (reversible):** Confluence **Cloud**, **Entra ID** identity, default **`bge-m3`**
> embeddings, single trust domain (no multi-tenancy). Change in `.env` / connector config.
