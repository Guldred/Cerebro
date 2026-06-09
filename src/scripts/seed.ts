import 'reflect-metadata';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { IngestionService } from '../ingestion/ingestion.service';
import { SampleConnector } from '../ingestion/connectors/sample/sample.connector';

/**
 * Ingests the local seed corpus (seed/*.md) through the real pipeline:
 * normalize → chunk → embed → store. Idempotent — re-running skips unchanged docs.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    const ingestion = app.get(IngestionService, { strict: false });
    const seedDir = path.join(process.cwd(), 'seed');
    const connector = new SampleConnector(seedDir);
    const stats = await ingestion.runInitialCrawl(connector);
    console.log('Seed complete:', stats);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
