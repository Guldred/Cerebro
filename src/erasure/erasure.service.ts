import { createHash } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ENTRA_USER_PREFIX } from '../auth/identity.types';
import { CONFIG, CerebroConfig } from '../config/config';
import { DatabaseService } from '../db/database.service';

export type ErasureMode = 'documents' | 'author' | 'subject';

/** Rows touched per table — recorded on the receipt. */
export interface ErasureCounts {
  documents?: number;
  chunks?: number;
  principalMappings?: number;
  identityLinks?: number;
  auditPseudonymized?: number;
  suppressed?: number;
}

export interface ErasureReceipt {
  id: string;
  mode: ErasureMode;
  scopeLabel: string | null;
  targetDigest: string;
  counts: ErasureCounts;
  status: 'logical';
}

export interface VacuumResult {
  tablesZeroed: string[];
  receiptsCompleted: number;
}

/** Tables physically rewritten by the zeroing phase (constants — never user input). */
const ERASE_TABLES = ['chunks', 'documents', 'principal_mappings', 'identity_links', 'delegation_audit'];

/**
 * GDPR right-to-be-forgotten erasure (Plan_Review P1.4). Two-phase:
 *   1. LOGICAL erase — delete/pseudonymize the rows (immediately invisible) +
 *      write a {@link ErasureReceipt} + suppress re-ingest. Transactional.
 *   2. PHYSICAL zeroing — {@link vacuumReindex} runs VACUUM FULL so the dead heap
 *      bytes are overwritten and the HNSW index is rebuilt without the erased
 *      vectors (scheduled, exclusive-lock; see the runbook).
 *
 * Three entry points, by design:
 *   - {@link eraseDocuments} — an explicit document-id list (the target of the
 *     operator-driven content-mention search-then-confirm path; auto-deleting on
 *     a name match would be irreversible over-erasure, so it is NOT offered).
 *   - {@link eraseByAuthor} — content authored by a source-native author string.
 *   - {@link eraseSubject} — a person's ACCESS/AUDIT FOOTPRINT keyed off their
 *     Entra `oid`. It does NOT touch authored content (an oid does not reach
 *     `documents.author`, which is a source-native string) — that is a separate,
 *     coordinated `eraseByAuthor` step (see the runbook).
 *
 * What eraseSubject deliberately does NOT erase: `delegation_revocations`
 * (namespace = the human oid). Removing a revocation would RE-ENABLE a token
 * that was denied — still live within its ≤3600s TTL, its group claims still
 * matching group-ACL'd chunks. That is fail-OPEN, so revocations are RETAINED
 * and aged out by their short TTL, not erased here.
 */
@Injectable()
export class ErasureService {
  private readonly log = new Logger(ErasureService.name);

  constructor(
    @Inject(CONFIG) private readonly config: CerebroConfig,
    private readonly db: DatabaseService,
  ) {}

  /** Erase an explicit document-id list (+cascade chunks) and suppress re-ingest. */
  async eraseDocuments(ids: string[], scopeLabel: string | null = null): Promise<ErasureReceipt> {
    const targetDigest = this.digest('documents', [...ids].sort().join(','));
    const counts = await this.db.transaction(async (client) => {
      const present = await client.query<{ id: string }>('SELECT id FROM documents WHERE id = ANY($1)', [ids]);
      const foundIds = present.rows.map((r) => r.id);
      const chunks = await this.countChunks(client, foundIds);
      const del = await client.query('DELETE FROM documents WHERE id = ANY($1)', [foundIds]);
      // Suppress EVERY requested id — even those not currently present — so a
      // not-yet-ingested or already-removed doc cannot be (re)indexed later.
      const suppressed = await this.suppress(client, ids, scopeLabel);
      return { documents: del.rowCount ?? 0, chunks, suppressed };
    });
    return this.writeReceipt('documents', scopeLabel, targetDigest, counts);
  }

  /** Erase all documents by a source-native author (+cascade chunks) and suppress them. */
  async eraseByAuthor(author: string, scopeLabel: string | null = null): Promise<ErasureReceipt> {
    const targetDigest = this.digest('author', author);
    const counts = await this.db.transaction(async (client) => {
      const present = await client.query<{ id: string }>('SELECT id FROM documents WHERE author = $1', [author]);
      const ids = present.rows.map((r) => r.id);
      const chunks = await this.countChunks(client, ids);
      const del = await client.query('DELETE FROM documents WHERE author = $1', [author]);
      const suppressed = await this.suppress(client, ids, scopeLabel);
      return { documents: del.rowCount ?? 0, chunks, suppressed };
    });
    return this.writeReceipt('author', scopeLabel, targetDigest, counts);
  }

  /** Erase a subject's access/audit footprint by Entra `oid`. Footprint only. */
  async eraseSubject(oid: string, scopeLabel: string | null = null): Promise<ErasureReceipt> {
    const userPrincipal = `${ENTRA_USER_PREFIX}${oid}`;
    const targetDigest = this.digest('subject', oid);
    const pseudonym = `erased:${targetDigest}`; // stable: correlatable to the receipt, reveals nothing
    const counts = await this.db.transaction(async (client) => {
      // EXACT match on the user principal — never the caller's entra-group:* rows,
      // or this would revoke access for an entire group (over-erasure / outage).
      const pm = await client.query('DELETE FROM principal_mappings WHERE entra_principal = $1', [userPrincipal]);
      const il = await client.query('DELETE FROM identity_links WHERE entra_principal = $1', [userPrincipal]);
      // Pseudonymize, not delete: preserve the (append-only) decision record while
      // stripping the PII. delegation_revocations is deliberately left untouched.
      const au = await client.query('UPDATE delegation_audit SET subject = $1 WHERE subject = $2', [pseudonym, oid]);
      return {
        principalMappings: pm.rowCount ?? 0,
        identityLinks: il.rowCount ?? 0,
        auditPseudonymized: au.rowCount ?? 0,
      };
    });
    return this.writeReceipt('subject', scopeLabel, targetDigest, counts);
  }

  /**
   * Physical-zeroing phase. VACUUM FULL cannot run in a transaction; it rewrites
   * each table's heap and rebuilds every index — so the old chunk-content bytes
   * are physically dropped and the HNSW graph is rebuilt without the erased
   * vectors. Plain VACUUM would only mark the tuples reusable (bytes linger), so
   * the "physically zeroed" claim requires FULL. WAL + base backups still retain
   * until rotation — the residual the runbook's retention policy covers.
   */
  async vacuumReindex(): Promise<VacuumResult> {
    for (const table of ERASE_TABLES) {
      await this.db.query(`VACUUM (FULL, ANALYZE) ${table}`);
    }
    const done = await this.db.query(
      "UPDATE erasure_log SET status = 'physically-zeroed', zeroed_at = now() WHERE status = 'logical'",
    );
    this.log.warn(
      `erasure vacuum: physically zeroed ${ERASE_TABLES.join(', ')}; ${done.rowCount ?? 0} receipt(s) completed`,
    );
    return { tablesZeroed: ERASE_TABLES, receiptsCompleted: done.rowCount ?? 0 };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private digest(mode: ErasureMode, target: string): string {
    return createHash('sha256')
      .update(this.config.erasure.pepper)
      .update('\0')
      .update(`${mode}:${target}`)
      .digest('hex');
  }

  private async countChunks(client: PoolClient, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const r = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM chunks WHERE document_id = ANY($1)',
      [ids],
    );
    return Number(r.rows[0]?.count ?? 0);
  }

  private async suppress(client: PoolClient, ids: string[], reason: string | null): Promise<number> {
    if (ids.length === 0) return 0;
    const r = await client.query(
      `INSERT INTO suppressed_documents (document_id, reason)
         SELECT unnest($1::text[]), $2
       ON CONFLICT (document_id) DO NOTHING`,
      [ids, reason],
    );
    return r.rowCount ?? 0;
  }

  private async writeReceipt(
    mode: ErasureMode,
    scopeLabel: string | null,
    targetDigest: string,
    counts: ErasureCounts,
  ): Promise<ErasureReceipt> {
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO erasure_log (mode, scope_label, target_digest, counts, status)
       VALUES ($1, $2, $3, $4::jsonb, 'logical')
       RETURNING id::text AS id`,
      [mode, scopeLabel, targetDigest, JSON.stringify(counts)],
    );
    return { id: res.rows[0]!.id, mode, scopeLabel, targetDigest, counts, status: 'logical' };
  }
}
