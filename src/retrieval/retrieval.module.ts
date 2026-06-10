import { Module } from '@nestjs/common';
import { PrincipalMappingService } from './principal-mapping.service';
import { RetrievalService } from './retrieval.service';

@Module({
  providers: [RetrievalService, PrincipalMappingService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
