import { createHash } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, CerebroConfig } from '../config/config';
import { DatabaseService } from '../db/database.service';
import { EMBEDDING_PROVIDER, EmbeddingProvider, embedBatched, toVectorLiteral } from '../embedding/embedding.interface';
import { SourceDocument, documentId } from '../documents/document.model';
import { chunkMarkdown } from '../documents/chunking/chunker';
import { LoaderRegistry } from './loaders/loader-registry';
import { Connector } from './connectors/connector.interface';

export interface IngestStats {
  ingested: number;
  skipped: number;
  deleted: number;
  chunks: number;
  /** Documents whose ACLs were rewritten WITHOUT re-embedding (content unchanged). */
  aclUpdated: number;
  /** Documents quarantined because permission resolution failed (invisible). */
  quarantined: number;
  /** Documents whose ingestion threw — dead-lettered to ingestion_dlq, crawl continued. */
  failed: number;
  /** Scopes (e.g. repos) the connector could not read and skipped — a non-empty
   *  list means the crawl was PARTIAL and reconciliation deletion was skipped. */
  skippedScopes: string[];
}

export interface AclRefreshStats {
  checked: number;
  updated: number;
  quarantined: number;
  unchanged: number;
}

/**
 * The ingestion pipeline (plan §6.2): normalize → chunk → embed → store.
 * Idempotent via a content hash, transactional per document, and able to remove
 * documents down to the vector level for GDPR (§7).
 */
@Injectable()
export class IngestionService {
  private readonly log = new Logger(IngestionService.name);
  private readonly loaders = new LoaderRegistry();

  constructor(
    @Inject(CONFIG) private readonly config: CerebroConfig,
    private readonly db: DatabaseService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
  ) {}

  /** Ingest one document. Returns whether it was (re)indexed or skipped as unchanged. */
  async ingestDocument(
    doc: SourceDocument,
  ): Promise<{ skipped: boolean; chunks: number; aclOnly?: boolean; quarantined?: boolean }> {
    const id = documentId(doc.sourceSystem, doc.externalId);

    // ERASURE SUPPRESSION (Plan_Review P1.4): a document erased for GDPR must not
    // be silently resurrected by a later crawl while it still exists at the
    // source. One indexed PK lookup before any work; suppressed → never written.
    const suppressed = await this.db.query('SELECT 1 FROM suppressed_documents WHERE document_id = $1', [id]);
    if ((suppressed.rowCount ?? 0) > 0) {
      this.log.warn(`Document ${id} is erasure-suppressed — skipping re-ingest`);
      return { skipped: true, chunks: 0 };
    }

    const body = this.loaders.toMarkdown(doc.contentType, doc.body);

    // QUARANTINE (Plan_Review P1.1): a document whose permissions could not be
    // resolved is stored with ZERO principals — invisible to everyone until a
    // successful re-resolution. Never stale-allow, never public.
    const quarantined = doc.aclStatus === 'failed';
    const acl = quarantined ? [] : [...doc.aclPrincipals].sort();
    const aclStatus = quarantined ? 'failed' : 'resolved';
    if (quarantined) {
      this.log.warn(`Document ${id}: ACL resolution failed — quarantined (invisible)`);
    }

    // The content hash deliberately EXCLUDES the ACL: permission changes on
    // unchanged content take the ACL-only path below and never re-embed.
    const hash = contentHash(doc, body);

    // Skip re-embedding only when BOTH the content is unchanged AND the existing
    // vectors were produced by the current embedding model. A model change must
    // force a re-embed — mixed-model vectors in one index corrupt similarity
    // (the blue/green versioning concern, critique P2).
    const existing = await this.db.query<{
      content_hash: string;
      acl_principals: string[];
      acl_status: string;
      embedding_model: string | null;
    }>(
      `SELECT d.content_hash, d.acl_principals, d.acl_status, c.embedding_model
         FROM documents d
         LEFT JOIN chunks c ON c.document_id = d.id AND c.chunk_index = 0
        WHERE d.id = $1`,
      [id],
    );
    const prior = existing.rows[0];
    if (prior?.content_hash === hash && prior?.embedding_model === this.embedder.model) {
      const aclChanged =
        JSON.stringify([...prior.acl_principals].sort()) !== JSON.stringify(acl) ||
        prior.acl_status !== aclStatus;
      if (!aclChanged) return { skipped: true, chunks: 0, quarantined };
      // ACL-only rewrite: content and vectors untouched.
      await this.writeAcl(id, acl, aclStatus);
      return { skipped: false, chunks: 0, aclOnly: true, quarantined };
    }

    const chunks = chunkMarkdown(body);
    if (chunks.length === 0) {
      // LEAK GUARD: when a STORED document's body empties out, returning early
      // would leave the previous version's chunks live under their OLD — and
      // possibly broader — ACL (e.g. page emptied in the same window its
      // restriction tightened, or its resolution failed). Remove the stale
      // chunks and persist the new ACL/status before yielding.
      if (prior) {
        await this.db.transaction(async (client) => {
          await client.query('DELETE FROM chunks WHERE document_id = $1', [id]);
          await client.query(
            `UPDATE documents
                SET acl_principals = $2, acl_status = $3, content_hash = $4, indexed_at = now()
              WHERE id = $1`,
            [id, acl, aclStatus, hash],
          );
        });
        this.log.warn(`Document ${id} now produces no chunks — stale chunks removed, ACL updated`);
        return { skipped: false, chunks: 0, aclOnly: true, quarantined };
      }
      this.log.warn(`Document ${id} produced no chunks (empty body) — skipping`);
      return { skipped: true, chunks: 0 };
    }

    // Embed all chunks in one batch before opening the transaction. We prepend the
    // document title + heading path ("contextual chunk headers") so heading-only
    // terms are captured in the vector too — symmetric with the tsvector, which
    // also indexes title + heading_path + content.
    const vectors = await embedBatched(
      this.embedder,
      chunks.map((c) => `${doc.title} ${c.headingPath}\n${c.content}`.trim()),
      this.config.ingestion.embedMaxBatch,
    );

    await this.db.transaction(async (client) => {
      await client.query(
        `INSERT INTO documents
           (id, source_system, external_id, source_url, title, breadcrumb, author,
            content_type, lang, acl_principals, acl_status, content_hash,
            source_created_at, source_updated_at, indexed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
         ON CONFLICT (id) DO UPDATE SET
           source_url=EXCLUDED.source_url, title=EXCLUDED.title, breadcrumb=EXCLUDED.breadcrumb,
           author=EXCLUDED.author, content_type=EXCLUDED.content_type, lang=EXCLUDED.lang,
           acl_principals=EXCLUDED.acl_principals, acl_status=EXCLUDED.acl_status,
           content_hash=EXCLUDED.content_hash,
           source_created_at=EXCLUDED.source_created_at, source_updated_at=EXCLUDED.source_updated_at,
           indexed_at=now()`,
        [
          id, doc.sourceSystem, doc.externalId, doc.sourceUrl, doc.title, doc.breadcrumb,
          doc.author ?? null, doc.contentType, doc.lang ?? null, acl, aclStatus, hash,
          doc.sourceCreatedAt ?? null, doc.sourceUpdatedAt ?? null,
        ],
      );

      // Re-index = delete-then-insert chunks. Clean and idempotent for MVP scale;
      // batch the inserts or diff chunks if corpora grow large.
      await client.query('DELETE FROM chunks WHERE document_id = $1', [id]);

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        await client.query(
          `INSERT INTO chunks
             (document_id, chunk_index, heading_path, anchor, content, token_estimate,
              embedding, embedding_model, source_system, source_url, title, acl_principals)
           VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,$10,$11,$12)`,
          [
            id, c.chunkIndex, c.headingPath, c.anchor, c.content, c.tokenEstimate,
            toVectorLiteral(vectors[i]), this.embedder.model, doc.sourceSystem, doc.sourceUrl,
            doc.title, acl,
          ],
        );
      }
    });

    return { skipped: false, chunks: chunks.length, quarantined };
  }

  /**
   * ACL-only rewrite for a document whose content is unchanged: one transaction
   * over documents + chunks, vectors untouched (no re-embedding). This is what
   * makes the dangerous revocation direction — a tightened restriction on an
   * unchanged page — cheap enough to run on a fast cadence.
   */
  private async writeAcl(id: string, acl: string[], aclStatus: 'resolved' | 'failed'): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(
        'UPDATE documents SET acl_principals = $2, acl_status = $3, indexed_at = now() WHERE id = $1',
        [id, acl, aclStatus],
      );
      await client.query('UPDATE chunks SET acl_principals = $2 WHERE document_id = $1', [id, acl]);
    });
  }

  /**
   * Re-resolve permissions for every stored document of a connector WITHOUT
   * touching content (Plan_Review P2 "decouple ACL refresh from content sync";
   * cron-able via npm run acl:refresh). Fail-closed: a document whose
   * resolution fails is quarantined (zero principals) — never left with its
   * stale allow-set.
   */
  async refreshAcls(connector: Connector): Promise<AclRefreshStats> {
    const stored = await this.db.query<{ id: string; external_id: string; acl_principals: string[]; acl_status: string }>(
      'SELECT id, external_id, acl_principals, acl_status FROM documents WHERE source_system = $1',
      [connector.sourceSystem],
    );

    const stats: AclRefreshStats = { checked: 0, updated: 0, quarantined: 0, unchanged: 0 };
    for (const row of stored.rows) {
      stats.checked++;
      let acl: string[];
      let status: 'resolved' | 'failed';
      try {
        acl = (await connector.resolvePermissions(row.external_id)).sort();
        status = 'resolved';
      } catch (err) {
        this.log.warn(`refreshAcls(${row.id}): resolution failed — quarantining: ${String(err)}`);
        acl = [];
        status = 'failed';
      }

      const changed =
        JSON.stringify([...row.acl_principals].sort()) !== JSON.stringify(acl) ||
        row.acl_status !== status;
      if (!changed) {
        stats.unchanged++;
        continue;
      }
      await this.writeAcl(row.id, acl, status);
      if (status === 'failed') stats.quarantined++;
      else stats.updated++;
    }

    this.log.log(
      `refreshAcls(${connector.sourceSystem}): checked=${stats.checked} updated=${stats.updated} ` +
        `quarantined=${stats.quarantined} unchanged=${stats.unchanged}`,
    );
    return stats;
  }

  /** Tombstone delete: a document removed at the source (reconciliation /
   *  deltaSync). Removes the document + its vectors (cascade) and clears any DLQ
   *  row, so a failed-then-deleted document leaves no ghost. (GDPR erasure has
   *  its own path in ErasureService — this is source-driven deletion.) */
  async deleteDocument(sourceSystem: string, externalId: string): Promise<void> {
    const id = documentId(sourceSystem, externalId);
    await this.db.query('DELETE FROM documents WHERE id = $1', [id]);
    await this.clearDlq(id);
  }

  // ── resilient per-document ingest + dead-letter queue (Plan_Review P1.5) ─────

  private newStats(): IngestStats {
    return { ingested: 0, skipped: 0, deleted: 0, chunks: 0, aclUpdated: 0, quarantined: 0, failed: 0, skippedScopes: [] };
  }

  /**
   * Ingest ONE document with per-document resilience: a failure is dead-lettered
   * and the crawl CONTINUES — one poison document never aborts the batch. A
   * success clears any prior DLQ row. (ingestDocument is transactional and embeds
   * BEFORE opening the transaction, so a failed re-ingest of an existing document
   * rolls back / never starts — the last-good version stays live. A transient
   * embedder hiccup degrades to staleness, not data loss; keep it that way.)
   */
  private async ingestOne(doc: SourceDocument, stats: IngestStats): Promise<void> {
    const id = documentId(doc.sourceSystem, doc.externalId);
    try {
      const r = await this.ingestDocument(doc);
      await this.clearDlq(id);
      if (r.quarantined) stats.quarantined++;
      if (r.skipped) stats.skipped++;
      else if (r.aclOnly) stats.aclUpdated++;
      else {
        stats.ingested++;
        stats.chunks += r.chunks;
      }
    } catch (err) {
      stats.failed++;
      this.log.error(`Document ${id} failed ingest — dead-lettered (crawl continues): ${String(err)}`);
      await this.recordDlq(doc, err);
    }
  }

  private async recordDlq(doc: SourceDocument, err: unknown): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO ingestion_dlq (document_id, source_system, external_id, error, attempts)
         VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT (document_id) DO UPDATE SET
           error = EXCLUDED.error, attempts = ingestion_dlq.attempts + 1, last_failed_at = now()`,
        [documentId(doc.sourceSystem, doc.externalId), doc.sourceSystem, doc.externalId, String(err).slice(0, 1000)],
      );
    } catch (dlqErr) {
      // Best-effort: a DLQ write failure (e.g. DB down) must not mask the crawl.
      this.log.error(`DLQ write failed for ${doc.sourceSystem}:${doc.externalId}: ${String(dlqErr)}`);
    }
  }

  private async clearDlq(id: string): Promise<void> {
    await this.db.query('DELETE FROM ingestion_dlq WHERE document_id = $1', [id]);
  }

  // ── durable delta-sync cursor (Plan_Review P1.5) ────────────────────────────

  async loadCursor(sourceSystem: string): Promise<string | null> {
    const res = await this.db.query<{ cursor: string | null }>(
      'SELECT cursor FROM sync_cursors WHERE source_system = $1',
      [sourceSystem],
    );
    return res.rows[0]?.cursor ?? null;
  }

  private async saveCursor(sourceSystem: string, cursor: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO sync_cursors (source_system, cursor, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (source_system) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
      [sourceSystem, cursor],
    );
  }

  /**
   * Incremental sync: resume from the stored cursor, then persist the new one.
   * The cursor is saved ONLY after a successful runDeltaSync — if the source API
   * throws, it propagates (cursor unchanged, the window is retried next run).
   * Do NOT wrap this in a try that swallows the throw.
   */
  async sync(connector: Connector): Promise<{ stats: IngestStats; cursor: string | null }> {
    const cursor = await this.loadCursor(connector.sourceSystem);
    const result = await this.runDeltaSync(connector, cursor);
    await this.saveCursor(connector.sourceSystem, result.cursor);
    return result;
  }

  /** Full crawl + reconcile: ingest everything the connector returns, then delete
   *  any previously-stored document of that source that the crawl no longer sees
   *  (tombstone handling — plan §6.1). */
  async runInitialCrawl(connector: Connector): Promise<IngestStats> {
    const docs = await connector.initialCrawl();
    const skippedScopes = connector.skippedScopes?.() ?? [];
    const stats = this.newStats();
    stats.skippedScopes = skippedScopes;

    const seen = new Set<string>();
    for (const doc of docs) {
      seen.add(documentId(doc.sourceSystem, doc.externalId));
      await this.ingestOne(doc, stats);
    }

    if (skippedScopes.length > 0) {
      // PARTIAL crawl — the connector could not read some scopes. Do NOT
      // reconcile-delete: a crawl that never saw a scope cannot conclude its docs
      // are gone (a narrower token / transient outage would otherwise wipe real
      // data). Stale docs of crawled scopes are cleaned on the next COMPLETE crawl.
      this.log.warn(
        `initialCrawl(${connector.sourceSystem}): PARTIAL — could not read ${skippedScopes.length} ` +
          `scope(s) [${skippedScopes.join(', ')}]; reconciliation (stale-doc deletion) SKIPPED to protect them.`,
      );
    } else {
      const stored = await this.db.query<{ id: string }>(
        'SELECT id FROM documents WHERE source_system = ANY($1)',
        [[...new Set(docs.map((d) => d.sourceSystem)).add(connector.sourceSystem)]],
      );
      for (const row of stored.rows) {
        if (!seen.has(row.id)) {
          await this.db.query('DELETE FROM documents WHERE id = $1', [row.id]);
          await this.clearDlq(row.id); // a reconciled-away doc leaves no ghost DLQ row
          stats.deleted++;
        }
      }
    }

    this.log.log(
      `initialCrawl(${connector.sourceSystem}): ingested=${stats.ingested} skipped=${stats.skipped} ` +
        `deleted=${stats.deleted} chunks=${stats.chunks} failed=${stats.failed}` +
        (skippedScopes.length ? ` unreadable=[${skippedScopes.join(',')}]` : ''),
    );
    return stats;
  }

  /** Incremental sync core: ingest changes, remove tombstoned documents. A
   *  per-document failure is dead-lettered (the batch continues); a wholesale
   *  connector.deltaSync() throw propagates (so sync() does not advance the
   *  cursor). Prefer sync() — it loads + persists the cursor around this. */
  async runDeltaSync(connector: Connector, cursor: string | null): Promise<{ stats: IngestStats; cursor: string | null }> {
    const result = await connector.deltaSync(cursor);
    const stats = this.newStats();

    for (const doc of result.documents) {
      await this.ingestOne(doc, stats);
    }
    for (const externalId of result.deletedExternalIds) {
      await this.deleteDocument(connector.sourceSystem, externalId);
      stats.deleted++;
    }

    this.log.log(
      `deltaSync(${connector.sourceSystem}): ingested=${stats.ingested} skipped=${stats.skipped} ` +
        `deleted=${stats.deleted} chunks=${stats.chunks} failed=${stats.failed}`,
    );
    return { stats, cursor: result.cursor };
  }
}

/**
 * Content-only hash — the ACL is deliberately NOT part of it, so a permission
 * change on unchanged content is an ACL-only rewrite, never a re-embed.
 * (Formula change note: hashes computed before the Phase-2 split included the
 * ACL, so the first seed after upgrading re-ingests every document once.)
 */
function contentHash(doc: SourceDocument, body: string): string {
  return createHash('sha256')
    .update(doc.title)
    .update(' ')
    .update(doc.breadcrumb)
    .update(' ')
    .update(body)
    .digest('hex');
}
