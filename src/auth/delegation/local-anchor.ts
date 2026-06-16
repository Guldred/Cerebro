import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';
import type { AttestationAnchor, AuthorizationDecisionRecord, RevocationStatus } from '../../totem-sdk';

/**
 * The default AttestationAnchor backend (docs/Totem_Integration.md §6): a LOCAL,
 * append-only audit log plus a negative-list revocation registry, both in
 * Postgres (migration 003). NO external/on-chain dependency — the optional
 * on-chain adapter implements the same interface and is off by default.
 *
 * Fail-closed split:
 *   - isRevoked() does NOT swallow DB errors — a failure aborts verification
 *     (the caller denies) rather than silently reporting "not revoked", matching
 *     PrincipalMappingService's fail-closed posture.
 *   - record() is best-effort: an audit-write failure is logged loudly but does
 *     NOT take the request down (audit is observability; denying retrieval
 *     because the audit table blipped is a worse failure mode). The gap is
 *     visible via the error log and the 'unrecorded' handle.
 */
@Injectable()
export class LocalAppendOnlyAnchor implements AttestationAnchor {
  private readonly log = new Logger(LocalAppendOnlyAnchor.name);

  constructor(private readonly db: DatabaseService) {}

  async record(rec: AuthorizationDecisionRecord): Promise<{ handle: string }> {
    try {
      const res = await this.db.query<{ id: string }>(
        `INSERT INTO delegation_audit
           (subject, actor, action, args_digest, decision, reasons, delegation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          rec.subject ?? null,
          rec.actor ?? null,
          rec.action,
          rec.argsDigest ?? null,
          rec.decision,
          rec.reasons,
          rec.delegationId ?? null,
        ],
      );
      return { handle: `audit:${res.rows[0]?.id ?? 'unknown'}` };
    } catch (err) {
      this.log.error(`delegation_audit write failed (decision still enforced): ${String(err)}`);
      return { handle: 'unrecorded' };
    }
  }

  async isRevoked(namespace: string, id: string): Promise<RevocationStatus> {
    const res = await this.db.query<{ revoked_at: Date }>(
      `SELECT revoked_at FROM delegation_revocations WHERE namespace = $1 AND delegation_id = $2`,
      [namespace, id],
    );
    const row = res.rows[0];
    return { revoked: row !== undefined, asOf: row?.revoked_at?.toISOString?.() };
  }

  /** Revoke a delegation (admin / eval / test). Takes effect on the next call (no cache). */
  async revoke(namespace: string, delegationId: string, revokedBy?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO delegation_revocations (namespace, delegation_id, revoked_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (namespace, delegation_id) DO NOTHING`,
      [namespace, delegationId, revokedBy ?? null],
    );
  }
}
