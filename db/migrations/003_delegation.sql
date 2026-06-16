-- Phase-1 delegation layer (docs/Totem_Integration.md §6).
--
-- The AttestationAnchor default backend is LOCAL and APPEND-ONLY: it records
-- every delegation authorization decision and answers revocation reads. There is
-- NO on-chain dependency — the optional on-chain adapter plugs in behind the same
-- interface and is off by default. Both tables are inert until DELEGATION_ENABLED.

-- 1) delegation_audit — append-only decision log. One row per authorization
--    decision (allow / deny / needs-approval). No raw tokens or secrets are
--    stored; only an args digest. Used for traceability and incident review.
CREATE TABLE IF NOT EXISTS delegation_audit (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
    subject       TEXT,                 -- the human (oid/sub)
    actor         TEXT,                 -- the agent (act.sub)
    action        TEXT NOT NULL,        -- the invoked command, e.g. /cerebro/search
    args_digest   TEXT,                 -- sha256 of the invocation args (no raw values)
    decision      TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'needs-approval')),
    reasons       TEXT[] NOT NULL DEFAULT '{}',
    delegation_id TEXT                  -- the token jti
);

CREATE INDEX IF NOT EXISTS delegation_audit_ts_idx ON delegation_audit (ts);
CREATE INDEX IF NOT EXISTS delegation_audit_subject_idx ON delegation_audit (subject);

-- 2) delegation_revocations — the negative list. A delegation (token jti) is
--    revoked within a namespace (the root subject). isRevoked() is one indexed
--    lookup; revoking is one INSERT and takes effect on the very next call (no
--    TTL/cache by default), mirroring the principal_mappings revocation model.
CREATE TABLE IF NOT EXISTS delegation_revocations (
    namespace     TEXT NOT NULL,        -- the root subject the delegation is rooted at
    delegation_id TEXT NOT NULL,        -- the revoked token jti
    revoked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_by    TEXT,                 -- who issued the revocation (audit)
    PRIMARY KEY (namespace, delegation_id)
);
