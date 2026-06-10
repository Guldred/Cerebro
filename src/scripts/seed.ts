import 'reflect-metadata';
import { promises as fs } from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DatabaseService } from '../db/database.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { buildConnector } from './connector-factory';

/**
 * Ingests a source through the real pipeline: normalize → chunk → embed → store.
 * Idempotent — re-running skips unchanged docs. Choose the source with
 * SEED_CONNECTOR=sample (default) | confluence | github.
 */

/**
 * Upsert the versioned principal-mapping fixture (seed/principal-mappings.json)
 * so demo, eval and CI share one reviewable source→Entra mapping set. The
 * schema CHECKs reject malformed or public-granting rows at the DB layer.
 */
async function syncPrincipalMappings(db: DatabaseService): Promise<void> {
  const file = path.join(process.cwd(), 'seed', 'principal-mappings.json');
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) return;

  const fixture = JSON.parse(raw) as {
    mappings: { source_principal: string; entra_principal: string; note?: string }[];
  };
  for (const m of fixture.mappings) {
    await db.query(
      `INSERT INTO principal_mappings (source_principal, entra_principal, note, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (source_principal, entra_principal)
       DO UPDATE SET note = EXCLUDED.note, updated_at = now()`,
      [m.source_principal, m.entra_principal, m.note ?? null],
    );
  }
  console.log(`Principal mappings synced: ${fixture.mappings.length} row(s)`);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    await syncPrincipalMappings(app.get(DatabaseService, { strict: false }));
    const ingestion = app.get(IngestionService, { strict: false });
    const stats = await ingestion.runInitialCrawl(buildConnector());
    console.log('Seed complete:', stats);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
