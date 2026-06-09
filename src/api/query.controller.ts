import { Body, Controller, Headers, Post } from '@nestjs/common';
import { RagService } from '../rag/rag.service';
import { RetrievalService } from '../retrieval/retrieval.service';
import { QueryDto, SearchDto } from './dto';
import { PRINCIPALS_HEADER, resolvePrincipals } from './identity';

@Controller()
export class QueryController {
  constructor(
    private readonly rag: RagService,
    private readonly retrieval: RetrievalService,
  ) {}

  /** Full RAG: question → grounded, cited answer (plan §6.6 POST /query). */
  @Post('query')
  async query(
    @Body() dto: QueryDto,
    @Headers(PRINCIPALS_HEADER) principalsHeader?: string,
  ) {
    const principals = resolvePrincipals(principalsHeader);
    return this.rag.answer(dto.question, {
      principals,
      topK: dto.topK,
      sourceSystems: dto.sourceSystems,
    });
  }

  /** Raw retrieval without generation (plan §6.6 POST /search). */
  @Post('search')
  async search(
    @Body() dto: SearchDto,
    @Headers(PRINCIPALS_HEADER) principalsHeader?: string,
  ) {
    const principals = resolvePrincipals(principalsHeader);
    const results = await this.retrieval.search(dto.query, {
      principals,
      topK: dto.topK,
      sourceSystems: dto.sourceSystems,
    });
    return { query: dto.query, results };
  }
}
