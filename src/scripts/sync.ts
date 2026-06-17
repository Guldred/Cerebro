import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DatabaseService } from '../db/database.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { buildConnector } from './connector-factory';

/**
 * npm run sync — incremental delta sync (Plan_Review P1.5). Resumes from the
 * durable per-connector cursor (sync_cursors), ingests changes + tombstones, and
 * persists the new cursor. Choose the source with SEED_CONNECTOR (same as seed).
 *
 * Resilience: a per-document failure is dead-lettered (ingestion_dlq) and the
 * batch CONTINUES — one poison document never stalls the stream. RETRY of DLQ'd
 * documents is by FULL CRAWL (`npm run db:seed`), which re-fetches everything and
 * clears rows that now succeed.
 *
 * Fail-loud: exits NON-ZERO when this run dead-lettered documents OR the DLQ is
 * non-empty for the connector — so a scheduled run alerts instead of silently
 * leaving dark documents (mirrors `npm run acl:refresh`).
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const ingestion = app.get(IngestionService, { strict: false });
    const db = app.get(DatabaseService, { strict: false });
    const connector = buildConnector();

    const { stats, cursor } = await ingestion.sync(connector);
    console.log('Delta sync:', { ...stats, cursor });

    // Count the WHOLE DLQ, not WHERE source_system = connector.sourceSystem: a
    // document is keyed by its OWN source (doc.sourceSystem), which diverges from
    // connector.sourceSystem for multi-source connectors (the sample emits
    // confluence:/gitlab: docs under 'sample') — a per-connector filter would
    // then read 0 and silently miss lingering dark docs. Any dark doc → alert.
    const dlq = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM ingestion_dlq');
    const dlqCount = Number(dlq.rows[0]?.count ?? 0);
    if (stats.failed > 0 || dlqCount > 0) {
      console.error(
        `Dead-lettered documents: ${stats.failed} this run, ${dlqCount} in ingestion_dlq total. ` +
          `Inspect ingestion_dlq; retry with a full crawl (npm run db:seed).`,
      );
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('sync failed:', err);
  process.exit(1);
});
