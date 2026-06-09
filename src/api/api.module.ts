import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { HealthController } from './health.controller';
import { QueryController } from './query.controller';

@Module({
  imports: [RagModule, RetrievalModule],
  controllers: [QueryController, HealthController],
})
export class ApiModule {}
