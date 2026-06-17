-- Incremental sync + ingestion resilience (Plan_Review P1.5).

-- Durable per-connector delta-sync cursor. `npm run sync` loads it, runs the
-- connector's deltaSync, and persists the returned cursor — so incremental sync
-- RESUMES where it left off instead of re-crawling from the beginning. The
-- cursor is saved ONLY after a successful deltaSync; if the source API throws,
-- it is left unchanged and the same window is retried next run.
CREATE TABLE IF NOT EXISTS sync_cursors (
    source_system TEXT PRIMARY KEY,
    cursor        TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dead-letter queue: a document whose ingestion FAILED (embedder error, malformed
-- content). The crawl records it here and CONTINUES instead of aborting the whole
-- batch — one poison document cannot stall the stream. A successful (re-)ingest
-- clears the row; a deletion at source clears it too (no ghost rows).
--
-- RETRY is by FULL CRAWL (runInitialCrawl re-fetches everything and re-attempts
-- DLQ'd docs, clearing rows that now succeed). deltaSync's cursor advances PAST
-- failures by design, so a DLQ'd doc is not re-seen by the next deltaSync — the
-- DLQ is the visibility + retry-counter, NOT a self-draining queue. `npm run
-- sync` exits non-zero while rows remain so a scheduled run alerts (see README).
CREATE TABLE IF NOT EXISTS ingestion_dlq (
    document_id     TEXT PRIMARY KEY,        -- <source_system>:<external_id>
    source_system   TEXT NOT NULL,
    external_id     TEXT NOT NULL,
    error           TEXT NOT NULL,
    attempts        INT  NOT NULL DEFAULT 1,
    first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_failed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ingestion_dlq_source_idx ON ingestion_dlq (source_system);
