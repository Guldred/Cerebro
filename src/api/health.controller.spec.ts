import { ServiceUnavailableException } from '@nestjs/common';
import { CerebroConfig } from '../config/config';
import { DatabaseService } from '../db/database.service';
import { EmbeddingProvider } from '../embedding/embedding.interface';
import { LlmProvider } from '../llm/llm.interface';
import { HealthController } from './health.controller';

const config = {
  embedding: { provider: 'fake' },
  llm: { provider: 'fake' },
  acl: { enforced: true },
  auth: { mode: 'dev-header' },
} as CerebroConfig;
const embedder = { model: 'fake', dim: 4 } as EmbeddingProvider;
const llm = { model: 'fake' } as LlmProvider;

function controller(dbQuery: (sql: string) => Promise<unknown>): HealthController {
  const db = { query: dbQuery } as unknown as DatabaseService;
  return new HealthController(config, db, embedder, llm);
}

describe('HealthController readiness', () => {
  it('ready: 200 { ready: true } when the store is reachable', async () => {
    const h = controller(async () => ({ rows: [] }));
    expect(await h.ready()).toEqual({ ready: true, db: true });
  });

  it('ready: throws 503 ServiceUnavailable when the DB is unreachable', async () => {
    const h = controller(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(h.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('liveness /health reports degraded (still 200) on a DB error', async () => {
    const h = controller(async () => {
      throw new Error('down');
    });
    const res = await h.health();
    expect(res.status).toBe('degraded');
    expect(res.db.ok).toBe(false);
  });
});
