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

## Cross-lingual finding (verified by layer — the gap is generation-bound)

`bge-m3` is multilingual, and this corpus pinpoints where the cross-lingual path
does and doesn't hold. The decisive experiment: an English question whose only
answer is in the German Datenschutz doc.

- **Embeddings: excellent.** The English query ranks the German chunks **#1–3 by
  vector similarity** — cross-lingual *retrieval* works.
- **Hybrid RRF ranking: under-weights a pure cross-lingual hit.** With zero lexical
  overlap it scores in only one arm, so RRF ranks it mid-pack (≈ fused-pos 10–13)
  behind bilingual English chunks. This affects `/search` *ordering* — but with a
  sufficient `top_k` the chunk still reaches the LLM (verified: at `top_k=16` the
  German chunks are inside the evidence window).
- **Generation is the binding constraint.** With the German evidence *in* the
  window, **mistral-7B still abstained** ("Not found") — it would not synthesise an
  English answer from German evidence (the correct fail-safe, but not an answer).
  A stronger multilingual model closes it: with **`LLM_MODEL=qwen3:8b`** the same
  English question returns a **grounded, cited answer** from the German doc (here in
  the source language; full target-language translation scales with model strength).

So the end-to-end answer gap is **generation-bound, not retrieval-bound** — closed
by model choice (config), not a ranking change. A retrieval tweak (e.g. guaranteed
vector-arm representation to lift the cross-lingual hit in `/search`) is a *separate*,
optional ordering improvement; on its own it would **not** have closed the answer gap,
as the `top_k=16` test shows. Run the demo with `LLM_MODEL=qwen3:8b ./run-demo.sh` to
see the cross-lingual answer succeed.

> Honest caveat on validation: the zero-key eval uses the deterministic `fake`
> embedder, which cannot reproduce cross-lingual retrieval — so eval-green proves
> *non-regression only*, never that the cross-lingual behaviour itself is gated. A
> real CI gate would need a bge-m3 eval leg with EN↔DE query→expected-doc pairs.
