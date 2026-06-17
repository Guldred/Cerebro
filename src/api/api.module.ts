import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { HealthController } from './health.controller';
import { QueryController } from './query.controller';
import { WellKnownController } from './well-known.controller';

@Module({
  imports: [RagModule, RetrievalModule],
  controllers: [QueryController, HealthController, WellKnownController, FeedbackController],
  providers: [FeedbackService],
})
export class ApiModule {}
