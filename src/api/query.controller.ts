import { Body, Controller, Post } from '@nestjs/common';
import { Identity } from '../auth/auth.guard';
import { CallerIdentity } from '../auth/identity.types';
import { RagService } from '../rag/rag.service';
import { RetrievalService } from '../retrieval/retrieval.service';
import { QueryDto, SearchDto } from './dto';

@Controller()
export class QueryController {
  constructor(
    private readonly rag: RagService,
    private readonly retrieval: RetrievalService,
  ) {}

  /** Full RAG: question → grounded, cited answer (plan §6.6 POST /query). */
  @Post('query')
  async query(@Body() dto: QueryDto, @Identity() identity: CallerIdentity) {
    return this.rag.answer(dto.question, {
      identity,
      topK: dto.topK,
      sourceSystems: dto.sourceSystems,
      command: '/cerebro/query',
    });
  }

  /** Raw retrieval without generation (plan §6.6 POST /search). */
  @Post('search')
  async search(@Body() dto: SearchDto, @Identity() identity: CallerIdentity) {
    const results = await this.retrieval.search(dto.query, {
      identity,
      topK: dto.topK,
      sourceSystems: dto.sourceSystems,
      command: '/cerebro/search',
    });
    return { query: dto.query, results };
  }
}
