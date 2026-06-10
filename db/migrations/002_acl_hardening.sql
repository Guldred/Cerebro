-- Phase 2 ACL hardening (Plan_Review P1.1/P1.2).
--
-- 1) principal_mappings — the principal-normalisation layer. Chunks keep the
--    source-native principals connectors emit (confluence-group:*, github-repo:*,
--    confluence-space:*, …); at query time the caller's Entra principals are
--    expanded through this table into the source-native principals they hold.
--    FAIL-CLOSED BY CONSTRUCTION: a source principal with no mapping row can
--    never appear in any caller's expanded set, so the && filter cannot match
--    it — an unresolved ACL is invisible, never public. Revoking access is one
--    DELETE; no re-ingest, no re-embed.
--
--    The CHECKs make dangerous rows unrepresentable even to a buggy admin tool:
--    the source side must be namespaced and never a reserved principal; the
--    entra side must be a namespaced Entra principal.
CREATE TABLE IF NOT EXISTS principal_mappings (
    source_principal TEXT NOT NULL
        CHECK (source_principal LIKE '%:%' AND source_principal NOT IN ('public', 'all-users')),
    entra_principal  TEXT NOT NULL
        CHECK (entra_principal LIKE 'entra-user:%' OR entra_principal LIKE 'entra-group:%'),
    note             TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_principal, entra_principal)
);

CREATE INDEX IF NOT EXISTS principal_mappings_entra_idx
    ON principal_mappings (entra_principal);

-- 2) documents.acl_status — quarantine marker. When a connector cannot resolve
--    a document's permissions (source API error), ingestion keeps the content
--    but zeroes acl_principals (invisible to everyone) and records 'failed'
--    here, so a retry sweep / dark-documents alert can find it. Stale-allow and
--    default-to-public are both structurally impossible.
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS acl_status TEXT NOT NULL DEFAULT 'resolved'
        CHECK (acl_status IN ('resolved', 'failed'));
