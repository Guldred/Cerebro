#!/usr/bin/env bash
# Synthetic-company end-to-end demo for Cerebro.
#
# Seeds a small, realistic multi-team corpus (this directory) with the REAL
# bge-m3 brain, starts the API with the real LLM, and runs the permission +
# retrieval proof battery (proof.py). Self-contained: zero external keys, all
# local (Postgres-in-Docker on :5433, Ollama on :11434).
#
# Prereqs: docker compose up -d  (Postgres) and a local Ollama serving
#   bge-m3 (embeddings) + a chat model (default mistral:latest). Override the
#   chat model with LLM_MODEL=... ./run-demo.sh
#
# Usage:  ./demo/acme-corp/run-demo.sh
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

LLM_MODEL="${LLM_MODEL:-mistral:latest}"
OLLAMA="${OLLAMA_BASE_URL:-http://localhost:11434/v1}"
REAL_BRAIN=(
  EMBEDDING_PROVIDER=openai-compatible "EMBEDDING_BASE_URL=$OLLAMA" EMBEDDING_MODEL=bge-m3 EMBEDDING_DIM=1024
  LLM_PROVIDER=openai-compatible "LLM_BASE_URL=$OLLAMA" "LLM_MODEL=$LLM_MODEL"
)

echo "== 1/4  Reset the demo DB to exactly this corpus =="
docker exec cerebro-postgres psql -U cerebro -d cerebro -c \
  "TRUNCATE documents, chunks RESTART IDENTITY CASCADE; TRUNCATE principal_mappings;"

echo "== 2/4  Seed with real bge-m3 embeddings =="
env SEED_CONNECTOR=sample SAMPLE_SEED_DIR=demo/acme-corp/corpus \
    PRINCIPAL_MAPPINGS_FILE=demo/acme-corp/principal-mappings.json \
    "${REAL_BRAIN[@]}" \
    npm run db:seed

echo "== 3/4  Start the API with the real brain (top_k=16 so cross-lingual vector hits reach the LLM) =="
lsof -ti:3000 | xargs kill 2>/dev/null || true
env AUTH_MODE=dev-header RETRIEVAL_TOP_K=16 "${REAL_BRAIN[@]}" \
    npm start > /tmp/cerebro-demo-server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
curl -s --retry 90 --retry-delay 1 --retry-connrefused --max-time 120 http://localhost:3000/health >/dev/null
echo "   API ready on http://localhost:3000"

echo "== 4/4  Proof battery =="
python3 demo/acme-corp/proof.py
