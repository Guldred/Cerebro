import { Module } from '@nestjs/common';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { RagService } from './rag.service';

@Module({
  imports: [RetrievalModule],
  providers: [RagService],
  exports: [RagService],
})
export class RagModule {}
