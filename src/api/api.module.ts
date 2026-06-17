import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
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
  providers: [
    FeedbackService,
    // DTO validation as an APP_PIPE (not main.ts useGlobalPipes) so it applies on
    // EVERY boot path — production AND any test/embedded context — not just the
    // CLI bootstrap. whitelist + forbidNonWhitelisted reject unknown fields.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    },
  ],
})
export class ApiModule {}
