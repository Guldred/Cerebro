-- GDPR right-to-be-forgotten erasure pipeline (Plan_Review P1.4).
--
-- Two tables back a durable, accountable erasure:
--   1) erasure_log       — the append-only receipt (WHAT scope, HOW MUCH, WHEN,
--                          and whether the physical-zeroing phase has run).
--   2) suppressed_documents — a do-not-re-ingest tombstone so a document that is
--                          erased but still PRESENT AT THE SOURCE is not silently
--                          resurrected by the next crawl (without this, nightly
--                          sync undoes every erasure).

-- erasure_log — DATA-MINIMIZING by design. It stores a DIGEST of the erased
-- identifier (sha256 of ERASURE_PEPPER ‖ identifier), never the identifier
-- itself, so the accountability log is not itself a store of the personal data
-- it records erasing. Accountability is verify-on-demand: "did you erase me?" →
-- recompute the digest with the deployment pepper and match a row.
CREATE TABLE IF NOT EXISTS erasure_log (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
    mode          TEXT NOT NULL CHECK (mode IN ('documents', 'author', 'subject')),
    scope_label   TEXT,                  -- operator free-text (e.g. a DSAR ticket id)
    target_digest TEXT NOT NULL,         -- sha256(pepper ‖ mode ‖ ':' ‖ target)
    counts        JSONB NOT NULL DEFAULT '{}',  -- rows touched per table
    -- 'logical' = rows deleted/pseudonymized (immediately invisible); the heap
    -- bytes are reclaimable but not yet overwritten. 'physically-zeroed' = the
    -- VACUUM FULL maintenance phase has rewritten the heap + rebuilt the indexes.
    status        TEXT NOT NULL DEFAULT 'logical'
                    CHECK (status IN ('logical', 'physically-zeroed')),
    zeroed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS erasure_log_status_idx ON erasure_log (status);
CREATE INDEX IF NOT EXISTS erasure_log_target_digest_idx ON erasure_log (target_digest);

-- suppressed_documents — the durable tombstone IngestionService.ingestDocument
-- consults before (re)writing a document. Keyed by the document_id natural key
-- ("<source_system>:<external_id>"); a document_id is a source PATH, not in
-- itself personal data, and this is a legitimate-interest "do not re-import"
-- record that makes erasure stick regardless of source state.
CREATE TABLE IF NOT EXISTS suppressed_documents (
    document_id   TEXT PRIMARY KEY,
    reason        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
