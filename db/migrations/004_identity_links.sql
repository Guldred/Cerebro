-- Phase-2 connector-backed membership (docs/Totem_Integration.md §11).
--
-- identity_links binds a Cerebro caller (their Entra `oid`) to their STABLE login
-- at a source system, so the Phase-2 PDP can re-confirm LIVE source-side
-- membership at call time for DELEGATION_SENSITIVE_SOURCES (e.g. "is this person
-- still in the GitHub org RIGHT NOW?"). It holds the durable identity bind ONLY —
-- the volatile membership itself is read live from the source, never cached here.
--
-- It is DELIBERATELY a separate table from principal_mappings. principal_mappings
-- is read by RetrievalService.expand() straight into the hard SQL ACL pre-filter
-- (`acl_principals && $principals`) on EVERY query, with no type column — so a
-- source-login row living there would silently become a user-scoped content
-- GRANT the moment any chunk is login-scoped. identity_links is read by the
-- membership checker ALONE and can never widen the ACL set. Inert until
-- DELEGATION_MEMBERSHIP_CHECKER selects a connector-backed checker.
CREATE TABLE IF NOT EXISTS identity_links (
    entra_principal TEXT NOT NULL
        CHECK (entra_principal LIKE 'entra-user:%'),   -- only a user has a login (never a group)
    source_system   TEXT NOT NULL CHECK (source_system <> ''),
    source_login    TEXT NOT NULL CHECK (source_login <> ''),
    note            TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One login per user per source. The PK btree also serves the checker's
    -- `entra_principal = ANY(...) AND source_system = $2` lookup (no extra index).
    PRIMARY KEY (entra_principal, source_system)
);
