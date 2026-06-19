# Synthetic-company demo — "Acme Robotics"

A small, realistic, multi-team knowledge base used to demonstrate Cerebro's
permission-aware retrieval end-to-end with the **real `bge-m3` brain** — no
external keys, no real company data, fully reproducible.

It exercises every permission behaviour from the architecture diagram in one
corpus, and is deliberately built so each restricted *fact* lives in **only one
document** (so a negative test actually proves something).

## Run it

```bash
docker compose up -d                       # Postgres (:5433), once
# local Ollama serving bge-m3 + a chat model (default mistral:latest) on :11434
./demo/acme-corp/run-demo.sh               # seed + serve + proof battery
```

`run-demo.sh` resets the demo DB, seeds this corpus with `bge-m3`, starts the API
with the real LLM, and runs `proof.py`. It uses two backward-compatible env knobs
so it never disturbs the canonical `seed/` + eval corpus:
`SAMPLE_SEED_DIR=demo/acme-corp/corpus` and `PRINCIPAL_MAPPINGS_FILE=demo/acme-corp/principal-mappings.json`.
(The 9 ingested docs live in `corpus/`; this README and the scripts sit one level
up so they are never crawled — the connector globs every `.md` it is pointed at.)

Restore the default corpus anytime with `npm run db:seed`.

## The corpus (9 docs, 3 sources)

| Doc | Source | ACL on chunks | Who can see it |
|---|---|---|---|
| company-handbook | confluence | `public` | everyone |
| eng-onboarding | confluence | `public` | everyone |
| product-overview | github | `public` | everyone |
| datenschutz-richtlinie (DE) | confluence | `public` | everyone |
| salary-bands | confluence | `confluence-group:hr` | `entra-group:hr` |
| finance-budget (Project Northwind) | confluence | `confluence-group:finance` | `entra-group:finance` |
| deployment-runbook | gitlab | `gitlab-project:acme/platform` | `entra-group:engineering` |
| board-strategy (Project BlueOak) | confluence | `confluence-group:board-confidential` | **nobody** — unmapped |
| security-incident | confluence | *(empty)* — `acl_status: failed` | **nobody** — quarantined |

Mappings live in `principal-mappings.json`. Two deliberate gaps:

- **`confluence-group:board-confidential` has no mapping row** → the board doc is
  invisible to every caller (fail-closed default: an unmapped source group can
  never be reached).
- **`confluence-group:security` *is* mapped** to `entra-group:security`, yet the
  security-incident doc is **quarantined** (`acl_status: failed` zeroes its ACL),
  so even a correctly-mapped caller sees nothing until resolution succeeds. This
  is what distinguishes "unmapped" from "quarantined".

## What it proves

- **Per-team isolation** — each restricted doc returns N chunks for its entitled
  caller and **0** for everyone else, on the *same* query (anchored on `/search`,
  no LLM ambiguity). Finance content is invisible to HR and vice-versa.
- **Fail-closed defaults** — unmapped source group → invisible to all; quarantined
  doc → invisible even to a mapped caller.
- **Grounded answers** — `/query` returns the real figures with deep-link citations
  for the entitled caller, and **abstains** ("Not found") for the non-entitled one.
- **No-leak under a wider window** — raising `RETRIEVAL_TOP_K` returns more
  *authorized* chunks but never a restricted one (ACL is a SQL pre-filter).

## Cross-lingual finding (honest scope)

`bge-m3` is multilingual, and this corpus surfaces exactly where that does and
doesn't carry through the full pipeline:

- **Embeddings: excellent.** An *English* query ranks the *German* Datenschutz
  chunks **#1–3 by vector similarity**.
- **Hybrid RRF fusion: under-weights it.** A pure cross-lingual hit shares zero
  tokens with the query, so the lexical (FTS) arm contributes nothing and RRF
  ranks it below mediocre-but-bilingual English chunks — it lands mid-pack.
- **Generation: in-language is reliable, cross-language is not (with mistral).** A
  *German* question over German evidence yields a perfect grounded German answer;
  an *English* question over (buried) German evidence makes mistral abstain rather
  than synthesise across languages — the correct fail-safe, but not a full answer.

Levers to close the cross-lingual gap (future work): weight the vector arm / a
language-aware fusion, add a cross-encoder reranker to lift the cross-lingual hit,
or use a stronger multilingual generation model.
