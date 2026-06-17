-- 👍/👎 answer-quality feedback (Plan_Review P2 — feeds the eval/quality loop).
--
-- Privacy-safe: the query is stored as the SAME short hash the observability
-- events use (queryHash), never the raw text (it can be Art. 9 data) — so a
-- feedback row correlates to a query's log events without recording its content.
CREATE TABLE IF NOT EXISTS query_feedback (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    subject     TEXT NOT NULL,                  -- the caller (oid / dev-header principal)
    query_hash  TEXT NOT NULL,                  -- matches the observability queryHash
    rating      TEXT NOT NULL CHECK (rating IN ('up', 'down')),
    chunk_ids   TEXT[] NOT NULL DEFAULT '{}',   -- document ids shown in the rated answer
    comment     TEXT                            -- optional free text (length-capped in the DTO)
);

CREATE INDEX IF NOT EXISTS query_feedback_ts_idx ON query_feedback (ts);
CREATE INDEX IF NOT EXISTS query_feedback_rating_idx ON query_feedback (rating);
