import 'reflect-metadata';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { IngestionService } from '../ingestion/ingestion.service';
import { Connector } from '../ingestion/connectors/connector.interface';
import { SampleConnector } from '../ingestion/connectors/sample/sample.connector';
import { ConfluenceConnector } from '../ingestion/connectors/confluence/confluence.connector';
import { GitHubConnector } from '../ingestion/connectors/github/github.connector';

/**
 * Ingests a source through the real pipeline: normalize → chunk → embed → store.
 * Idempotent — re-running skips unchanged docs. Choose the source with
 * SEED_CONNECTOR=sample (default) | confluence | github.
 */
function buildConnector(): Connector {
  const which = process.env.SEED_CONNECTOR ?? 'sample';
  switch (which) {
    case 'confluence':
      return new ConfluenceConnector({
        baseUrl: required('CONFLUENCE_BASE_URL'),
        email: required('CONFLUENCE_EMAIL'),
        apiToken: required('CONFLUENCE_API_TOKEN'),
        spaceKeys: list('CONFLUENCE_SPACE_KEYS'),
      });
    case 'github':
      return new GitHubConnector({
        token: process.env.GITHUB_TOKEN, // optional — public repos work without it
        repos: list('GITHUB_REPOS') ?? [],
        apiUrl: process.env.GITHUB_API_URL,
      });
    case 'sample':
      return new SampleConnector(path.join(process.cwd(), 'seed'));
    default:
      throw new Error(`Unknown SEED_CONNECTOR: ${which}`);
  }
}

function list(key: string): string[] | undefined {
  return process.env[key]?.split(',').map((s) => s.trim()).filter(Boolean);
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`SEED_CONNECTOR=confluence requires ${key}`);
  return v;
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
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
