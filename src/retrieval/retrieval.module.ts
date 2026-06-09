import { Module } from '@nestjs/common';
import { RetrievalService } from './retrieval.service';

@Module({
  providers: [RetrievalService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
