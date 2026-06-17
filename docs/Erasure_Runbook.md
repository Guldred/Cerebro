# Erasure Runbook — GDPR right-to-be-forgotten (Plan_Review P1.4)

Operational guidance for handling an erasure / Data Subject Access Request (DSAR). The code-level
behaviour is in [`src/erasure/erasure.service.ts`](../src/erasure/erasure.service.ts); this document
covers the parts code cannot do on its own — the **two coordinated DSAR steps**, the **physical-zeroing
SLA**, and the **backup/WAL retention residual**.

## The model in one paragraph

Erasure is **two-phase**. A *logical* erase (`ERASE_MODE=documents|author|subject`) deletes or
pseudonymizes the rows in one transaction — the data is immediately invisible to retrieval and the ACL
filter — writes an append-only `erasure_log` receipt, and (for content) records a
`suppressed_documents` tombstone so the next crawl does not resurrect it. A scheduled *physical* phase
(`ERASE_MODE=vacuum`) then runs `VACUUM FULL`, which rewrites each table's heap and rebuilds its indexes
— overwriting the dead bytes and dropping the erased vectors from the HNSW graph.

## A complete DSAR is two coordinated steps

A person ("data subject") has two distinct kinds of personal data in Cerebro, reached by **different
keys**, so a full erasure is two commands:

1. **Footprint** — keyed off the Entra `oid`:
   ```bash
   ERASE_MODE=subject ERASE_TARGET=<entra-oid> ERASE_SCOPE=DSAR-123 npm run erase
   ```
   Deletes their `principal_mappings` / `identity_links` user rows and pseudonymizes their
   `delegation_audit` rows.

2. **Authored content** — keyed off the *source-native* author string (a Confluence account, a git
   author — **not** the oid, which is why one command can't do both):
   ```bash
   ERASE_MODE=author ERASE_TARGET="<source-author-string>" ERASE_SCOPE=DSAR-123 npm run erase
   ```
   For content that *mentions* the subject (rather than being authored by them), search the corpus,
   confirm the hits with a human, and erase the confirmed ids with `ERASE_MODE=documents` — Cerebro
   never auto-deletes on a fuzzy name match.

Then run the physical phase (below). Record the `erasure_log` receipt id(s) against the DSAR ticket.

### Audit sink is DB-only

The only authorization-record sink is the `delegation_audit` table —
`LocalAppendOnlyAnchor` writes there via SQL, with **no file/JSONL sink** in any mode. So a subject's
audit footprint is fully covered by the `eraseSubject` pseudonymization above; there is no out-of-band
log to sweep separately.

## What is deliberately NOT erased

- **`delegation_revocations`** (namespace = the human oid) is **retained**. Deleting a revocation would
  *re-enable* a token that had been denied — still live within its ≤`DELEGATION_MAX_TTL_S` (≤3600s)
  window, its group claims still matching group-ACL'd chunks. That is fail-**open**. Revocations age out
  on their own short TTL; a periodic time-based sweep (not erasure) is the right cleanup.
- **`delegation_audit`** rows are **pseudonymized, not deleted** — the decision record (an append-only
  audit trail) is preserved with the PII stripped (`subject → erased:<digest>`).

## Physical zeroing — the SLA and what it does / doesn't cover

```bash
ERASE_MODE=vacuum npm run erase   # VACUUM FULL chunks, documents, principal_mappings, identity_links, delegation_audit
```

- **`VACUUM FULL` is required for the physical claim.** Plain `VACUUM` only marks dead tuples reusable —
  the old `chunks.content` bytes linger in the heap until overwritten by chance. `VACUUM FULL` rewrites
  the heap and rebuilds every index, so the bytes are gone and the HNSW graph no longer contains the
  erased vectors.
- **It takes an `ACCESS EXCLUSIVE` lock** on each table (blocks reads/writes for the duration) — run it
  in a maintenance window, not on the hot path. This is why it is a separate, schedulable phase.
- **Recommended SLA:** physical zeroing within **24h** of the logical erase (one nightly maintenance
  run). The `erasure_log.status` (`logical` → `physically-zeroed`) and `zeroed_at` columns let you audit
  the gap; alert if any row stays `logical` past the SLA.

### The residual code cannot reach — backups, WAL, PITR (Plan_Review P1.4(c))

`VACUUM FULL` zeroes the *live* database. It does **not** reach:

- **WAL** (write-ahead log) and **base backups / PITR snapshots** — these still contain the pre-erasure
  bytes until they rotate out.

This must be handled by **retention policy**, not application code:

- Set a **bounded backup/PITR retention window** (e.g. 30 days) and document it as the maximum time the
  data can survive in cold storage after a logical erase. The erasure is "complete" only once that
  window has also elapsed (or a targeted backup re-write is performed).
- For a hard deadline, schedule a **re-erasure pass** on restore: any database restored from a backup
  older than an erasure receipt must replay the outstanding `erasure_log` entries before serving.
- State this window in your privacy notice as the erasure-completion SLA.

## Verifying an erasure (verify-on-demand)

The `erasure_log` stores `sha256(ERASURE_PEPPER ‖ mode ‖ ':' ‖ target)`, not the identifier. To answer
"did you erase X?", recompute the digest with the deployment pepper and match a row:

```sql
SELECT id, ts, mode, scope_label, counts, status, zeroed_at
FROM erasure_log
WHERE target_digest = encode(digest(:pepper || E'\\000' || :mode || ':' || :target, 'sha256'), 'hex');
```

(Set `ERASURE_PEPPER` to a deployment-wide secret in production; an empty pepper makes the digest an
unsalted hash of the identifier — the erase script warns when it is unset.)
