import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './db/database.module';
import { EmbeddingModule } from './embedding/embedding.module';
import { LlmModule } from './llm/llm.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { RetrievalModule } from './retrieval/retrieval.module';
import { RagModule } from './rag/rag.module';
import { ApiModule } from './api/api.module';

/**
 * Wires the three layers from the plan: ingestion, retrieval, generation — over
 * shared config, DB, embedding and LLM modules. Provider selection (fake / Azure
 * / self-hosted) is config-driven inside EmbeddingModule and LlmModule.
 */
@Module({
  imports: [
    ConfigModule,
    AuthModule,
    DatabaseModule,
    EmbeddingModule,
    LlmModule,
    IngestionModule,
    RetrievalModule,
    RagModule,
    ApiModule,
  ],
})
export class AppModule {}
