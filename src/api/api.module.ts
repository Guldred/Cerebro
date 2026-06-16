import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { HealthController } from './health.controller';
import { QueryController } from './query.controller';
import { WellKnownController } from './well-known.controller';

@Module({
  imports: [RagModule, RetrievalModule],
  controllers: [QueryController, HealthController, WellKnownController],
})
export class ApiModule {}
