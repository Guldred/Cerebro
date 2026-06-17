import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { IdentityService } from '../auth/identity.service';
import { DatabaseService } from '../db/database.service';
import { ErasureService } from '../erasure/erasure.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { RetrievalService } from '../retrieval/retrieval.service';
import { buildConnector } from './connector-factory';

/**
 * npm run erase:smoke — the end-to-end gate for GDPR erasure (Plan_Review P1.4).
 *
 * Unit tests assert the SQL the ErasureService emits; this proves the EFFECT
 * against a live store: a document erased is no longer RETRIEVABLE, a re-crawl
 * does not resurrect it (the suppression tombstone), and the physical-zeroing
 * phase runs on the real schema. Runs in dev-header mode against the seeded
 * corpus (zero external keys), as its own CI step after migrate+seed.
 *
 * SELF-RESTORING: the corpus is mutated (erase + vacuum + re-crawl) and restored
 * in a finally, so a failed run (or a re-run) leaves the store exactly as seeded.
 */
const SCOPE = 'erase-smoke';

async function main(): Promise<void> {
  process.env.AUTH_MODE = process.env.AUTH_MODE ?? 'dev-header';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const db = app.get(DatabaseService, { strict: false });
  const retrieval = app.get(RetrievalService, { strict: false });
  const erasure = app.get(ErasureService, { strict: false });
  const ingestion = app.get(IngestionService, { strict: false });
  const identityService = app.get(IdentityService, { strict: false });

  // Target a RESTRICTED resolved doc (discovered, not hard-coded) so the erase is
  // exercised through the real ACL path, with a caller holding its principals.
  const found = await db.query<{ id: string; title: string; acl_principals: string[] }>(
    `SELECT id, title, acl_principals FROM documents
      WHERE acl_status = 'resolved' AND NOT ('public' = ANY(acl_principals))
        AND array_length(acl_principals, 1) >= 1
      ORDER BY id LIMIT 1`,
  );
  if (found.rows.length === 0) {
    throw new Error('erase-smoke: no restricted seeded document found — run `npm run db:seed` first');
  }
  const target = found.rows[0]!;
  const identity = await identityService.resolve({ devHeader: target.acl_principals.join(',') });
  console.log(`erase-smoke target: ${target.id} ("${target.title}") acl=${target.acl_principals.join(',')}`);

  // With the small sample corpus topK=20 returns everything, so "retrievable"
  // is exactly "exists AND passes this caller's ACL" — deterministic.
  const retrievable = async (): Promise<boolean> => {
    const chunks = await retrieval.search(target.title, { identity, topK: 20 });
    return chunks.some((c) => c.documentId === target.id);
  };
  const count = async (sql: string): Promise<number> =>
    Number((await db.query<{ n: string }>(sql, [target.id])).rows[0]?.n ?? 0);

  const checks: { name: string; ok: boolean }[] = [];
  const check = (name: string, ok: boolean): void => {
    checks.push({ name, ok });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  };

  try {
    check('retrievable BEFORE erase', await retrievable());

    const receipt = await erasure.eraseDocuments([target.id], SCOPE);
    check(
      'erase removed the document + its chunks + wrote a suppression',
      (receipt.counts.documents ?? 0) >= 1 &&
        (receipt.counts.chunks ?? 0) >= 1 &&
        (receipt.counts.suppressed ?? 0) >= 1,
    );

    const vac = await erasure.vacuumReindex();
    check('physical-zeroing phase completed the receipt', vac.receiptsCompleted >= 1);

    check('NOT retrievable after erase (the core guarantee)', !(await retrievable()));
    check('document row gone', (await count('SELECT count(*) n FROM documents WHERE id=$1')) === 0);
    check('chunk rows gone (cascade)', (await count('SELECT count(*) n FROM chunks WHERE document_id=$1')) === 0);
    check('suppression tombstone written', (await count('SELECT count(*) n FROM suppressed_documents WHERE document_id=$1')) === 1);

    // Re-crawl with suppression ACTIVE — the document must not come back.
    await ingestion.runInitialCrawl(buildConnector());
    check('NOT resurrected by a re-crawl (suppression holds)', !(await retrievable()));
    check('still absent in the store after re-crawl', (await count('SELECT count(*) n FROM documents WHERE id=$1')) === 0);
  } catch (err) {
    check(`no unexpected error (${String(err)})`, false);
  } finally {
    // ALWAYS restore: drop the tombstone + smoke receipts, then re-crawl to
    // re-ingest the erased document. Leaves the corpus exactly as seeded.
    await db.query('DELETE FROM suppressed_documents WHERE document_id = $1', [target.id]);
    await db.query('DELETE FROM erasure_log WHERE scope_label = $1', [SCOPE]);
    await ingestion.runInitialCrawl(buildConnector());
  }

  // Verify the restore worked (after the finally re-crawl).
  check('retrievable AGAIN after restore (corpus reset)', await retrievable());

  await app.close();
  const passed = checks.every((c) => c.ok);
  console.log(`\n  ${passed ? 'PASS' : 'FAIL'}\n`);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('erase-smoke failed:', err);
  process.exit(1);
});
