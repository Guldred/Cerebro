-- Cerebro initial schema.
-- One Postgres instance holds embeddings (pgvector), full-text (tsvector),
-- metadata and ACLs — the single-system bet from the plan (§6.3).
--
-- DIMENSION CONTRACT: chunks.embedding is vector(1024) to match the default
-- multilingual model (bge-m3 / multilingual-e5-large). EMBEDDING_DIM in the env
-- MUST equal this number. Changing the model to a different dimension requires a
-- new migration (ALTER TYPE + index rebuild) — pgvector's HNSW caps `vector` at
-- 2000 dims, so 3072-dim models (text-embedding-3-large) need `halfvec` or the
-- API `dimensions` parameter. See README "Choosing an embedding model".

CREATE EXTENSION IF NOT EXISTS vector;

-- ── documents ────────────────────────────────────────────────────────────────
-- One row per source document (a Confluence page, a GitLab README, a Teams
-- message thread, ...). `id` is a stable natural key "<source_system>:<external_id>"
-- so re-ingesting the same source document is idempotent.
CREATE TABLE IF NOT EXISTS documents (
    id            TEXT PRIMARY KEY,
    source_system TEXT        NOT NULL,
    external_id   TEXT        NOT NULL,
    source_url    TEXT        NOT NULL,
    title         TEXT        NOT NULL DEFAULT '',
    breadcrumb    TEXT        NOT NULL DEFAULT '',
    author        TEXT,
    content_type  TEXT        NOT NULL DEFAULT 'text/markdown',
    lang          TEXT,
    -- Attachment → parent page linkage (deep link / breadcrumb / ACL inheritance /
    -- cascade-on-parent-delete). NULL for top-level documents.
    parent_id     TEXT,
    -- Principals (Entra ID groups / user ids) allowed to see this document in the
    -- source. The retrieval ACL filter (§7, early binding) tests membership.
    acl_principals TEXT[]     NOT NULL DEFAULT '{}',
    -- Hash of the normalized body; lets delta sync skip unchanged documents and
    -- makes re-index idempotent.
    content_hash  TEXT        NOT NULL DEFAULT '',
    source_created_at  TIMESTAMPTZ,
    source_updated_at  TIMESTAMPTZ,
    indexed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_system, external_id)
);

CREATE INDEX IF NOT EXISTS documents_source_system_idx ON documents (source_system);

-- ── chunks ───────────────────────────────────────────────────────────────────
-- Searchable blocks. Citation-relevant metadata (source_url, title, heading_path,
-- anchor, acl_principals) is denormalized onto the chunk so retrieval is a single
-- indexed table scan with no joins at query time.
CREATE TABLE IF NOT EXISTS chunks (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id   TEXT        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index   INT         NOT NULL,
    heading_path  TEXT        NOT NULL DEFAULT '',
    anchor        TEXT,                          -- deep-link fragment for the heading
    content       TEXT        NOT NULL,
    token_estimate INT        NOT NULL DEFAULT 0,
    embedding     vector(1024),
    -- Which model produced this vector. Enables blue/green re-index: build new
    -- vectors under a new model, validate, then atomically cut over — never mix
    -- model versions in one live index (similarity across models is meaningless).
    embedding_model TEXT      NOT NULL DEFAULT '',
    -- Denormalized from documents for filter/citation without a join.
    source_system TEXT        NOT NULL,
    source_url    TEXT        NOT NULL,
    title         TEXT        NOT NULL DEFAULT '',
    acl_principals TEXT[]     NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Generated full-text vector. We index title + heading path + content
    -- ("contextual chunk headers") so heading-only terms (e.g. a page titled
    -- "Salary Bands 2026") are still lexically retrievable. `simple` config avoids
    -- language-specific stemming that would mis-handle a mixed DE+EN corpus.
    tsv           tsvector GENERATED ALWAYS AS (
                    to_tsvector('simple', coalesce(title, '') || ' ' ||
                                          coalesce(heading_path, '') || ' ' || content)
                  ) STORED,
    UNIQUE (document_id, chunk_index)
);

-- Approximate-nearest-neighbour index for dense retrieval (cosine distance).
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
    ON chunks USING hnsw (embedding vector_cosine_ops);

-- Lexical retrieval (the other leg of hybrid search).
CREATE INDEX IF NOT EXISTS chunks_tsv_gin_idx ON chunks USING gin (tsv);

-- ACL pre-filter: `acl_principals && :caller_principals` uses this GIN index.
CREATE INDEX IF NOT EXISTS chunks_acl_gin_idx ON chunks USING gin (acl_principals);

CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id);
CREATE INDEX IF NOT EXISTS chunks_source_system_idx ON chunks (source_system);
