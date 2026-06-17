import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, CerebroConfig } from '../config/config';
import { LLM_PROVIDER, LlmProvider, EvidenceItem, TokenUsage } from '../llm/llm.interface';
import { emitQueryEvent, queryHash } from '../observability/query-log';
import { RetrievalService } from '../retrieval/retrieval.service';
import { RetrievalOptions, RetrievedChunk } from '../retrieval/retrieval.types';
import { verifyCitations } from './faithfulness';
import { Citation, Faithfulness, RagAnswer } from './rag.types';

/**
 * The RAG/agent layer (plan §6.5). Retrieves permission-filtered evidence, asks
 * the LLM for an answer grounded ONLY in that evidence, and maps the citations
 * the model used back to clickable source deep links so every answer stays
 * verifiable. Emits one structured observability event per answer (timings +
 * token usage + cited count), with the query hashed, not stored.
 */
@Injectable()
export class RagService {
  private readonly log = new Logger(RagService.name);

  constructor(
    @Inject(CONFIG) private readonly config: CerebroConfig,
    private readonly retrieval: RetrievalService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  async answer(question: string, options: RetrievalOptions): Promise<RagAnswer> {
    const t0 = process.hrtime.bigint();
    const chunks = await this.retrieval.search(question, options);
    const tRetrieved = process.hrtime.bigint();

    if (chunks.length === 0) {
      const timings = { retrievalMs: ms(t0, tRetrieved), generationMs: 0, totalMs: ms(t0, tRetrieved) };
      this.observe(question, options, [], 0, true, undefined, timings, undefined);
      return { question, answer: 'Not found in the connected sources.', citations: [], evidence: [], notFound: true, timings };
    }

    const evidence: EvidenceItem[] = chunks.map((c, i) => ({
      citation: i + 1,
      title: citationLabel(c),
      sourceUrl: c.deepLink,
      content: c.content,
    }));

    const { answer: rawAnswer, usage } = await this.llm.generateGroundedAnswer(question, evidence);
    const tGenerated = process.hrtime.bigint();

    // Citation verification (faithfulness): only markers backed by real evidence
    // become citations; fabricated ones are flagged + stripped from the answer.
    const check = verifyCitations(rawAnswer, evidence.length);
    const citations: Citation[] = check.grounded
      .map((n) => chunks[n - 1])
      .filter((c): c is RetrievedChunk => Boolean(c))
      .map((c, idx) => ({
        number: check.grounded[idx],
        title: c.title,
        headingPath: c.headingPath,
        sourceSystem: c.sourceSystem,
        sourceUrl: c.sourceUrl,
        deepLink: c.deepLink,
      }));

    const faithfulness: Faithfulness = {
      allGrounded: check.hallucinated.length === 0,
      groundedCount: check.grounded.length,
      hallucinatedCitations: check.hallucinated,
    };
    if (!faithfulness.allGrounded) {
      this.log.warn(`answer cited fabricated sources [${check.hallucinated.join(',')}] — stripped from the answer`);
    }

    const notFound = check.grounded.length === 0;
    const timings = {
      retrievalMs: ms(t0, tRetrieved),
      generationMs: ms(tRetrieved, tGenerated),
      totalMs: ms(t0, tGenerated),
    };
    this.observe(question, options, chunks, citations.length, notFound, usage, timings, faithfulness);

    return { question, answer: check.cleanedAnswer, citations, evidence: chunks, notFound, usage, timings, faithfulness };
  }

  /** One structured JSON event per answer — chunk ids, cited count, timings,
   *  tokens. Query is hashed unless OBSERVABILITY_LOG_QUERY_TEXT is on. */
  private observe(
    question: string,
    options: RetrievalOptions,
    chunks: RetrievedChunk[],
    citedCount: number,
    notFound: boolean,
    usage: TokenUsage | undefined,
    timings: { retrievalMs: number; generationMs: number; totalMs: number },
    faithfulness: Faithfulness | undefined,
  ): void {
    emitQueryEvent(this.log, {
      event: 'rag',
      subject: options.identity.subject,
      ...(options.identity.delegation ? { agent: options.identity.delegation.agent } : {}),
      queryHash: queryHash(question),
      queryChars: question.length,
      ...(this.config.observability.logQueryText ? { query: question } : {}),
      hits: chunks.length,
      chunkIds: chunks.map((c) => c.documentId),
      citedCount,
      notFound,
      ...(usage
        ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens }
        : {}),
      ...(faithfulness && faithfulness.hallucinatedCitations.length > 0
        ? { hallucinatedCitations: faithfulness.hallucinatedCitations }
        : {}),
      ...timings,
    });
  }
}

function ms(start: bigint, end: bigint): number {
  return Math.round((Number(end - start) / 1e6) * 10) / 10;
}

function citationLabel(c: RetrievedChunk): string {
  return c.headingPath ? `${c.title} › ${c.headingPath}` : c.title;
}
