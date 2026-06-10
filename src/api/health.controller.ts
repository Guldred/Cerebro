import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../auth/auth.guard';
import { CONFIG, CerebroConfig } from '../config/config';
import { DatabaseService } from '../db/database.service';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../embedding/embedding.interface';
import { LLM_PROVIDER, LlmProvider } from '../llm/llm.interface';

/** Liveness/readiness — the only identity-free endpoint (@Public). */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(CONFIG) private readonly config: CerebroConfig,
    private readonly db: DatabaseService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  @Get()
  async health() {
    let dbOk = false;
    let chunkCount: number | null = null;
    try {
      const res = await this.db.query<{ count: string }>('SELECT count(*)::text AS count FROM chunks');
      chunkCount = Number(res.rows[0]?.count ?? 0);
      dbOk = true;
    } catch {
      dbOk = false;
    }

    return {
      status: dbOk ? 'ok' : 'degraded',
      db: { ok: dbOk, chunks: chunkCount },
      embedding: { provider: this.config.embedding.provider, model: this.embedder.model, dim: this.embedder.dim },
      llm: { provider: this.config.llm.provider, model: this.llm.model },
      aclEnforced: this.config.acl.enforced,
      authMode: this.config.auth.mode,
    };
  }
}
