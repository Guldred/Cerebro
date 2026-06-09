import { Inject, Injectable } from '@nestjs/common';
import { LLM_PROVIDER, LlmProvider, EvidenceItem } from '../llm/llm.interface';
import { RetrievalService } from '../retrieval/retrieval.service';
import { RetrievalOptions, RetrievedChunk } from '../retrieval/retrieval.types';
import { Citation, RagAnswer } from './rag.types';

/**
 * The RAG/agent layer (plan §6.5). Retrieves permission-filtered evidence, asks
 * the LLM for an answer grounded ONLY in that evidence, and maps the citations
 * the model used back to clickable source deep links so every answer stays
 * verifiable.
 */
@Injectable()
export class RagService {
  constructor(
    private readonly retrieval: RetrievalService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  async answer(question: string, options: RetrievalOptions): Promise<RagAnswer> {
    const chunks = await this.retrieval.search(question, options);

    if (chunks.length === 0) {
      return {
        question,
        answer: 'Not found in the connected sources.',
        citations: [],
        evidence: [],
        notFound: true,
      };
    }

    const evidence: EvidenceItem[] = chunks.map((c, i) => ({
      citation: i + 1,
      title: citationLabel(c),
      sourceUrl: c.deepLink,
      content: c.content,
    }));

    const { answer, usedCitations } = await this.llm.generateGroundedAnswer(question, evidence);

    const citations: Citation[] = usedCitations
      .map((n) => chunks[n - 1])
      .filter((c): c is RetrievedChunk => Boolean(c))
      .map((c, idx) => ({
        number: usedCitations[idx],
        title: c.title,
        headingPath: c.headingPath,
        sourceSystem: c.sourceSystem,
        sourceUrl: c.sourceUrl,
        deepLink: c.deepLink,
      }));

    return {
      question,
      answer,
      citations,
      evidence: chunks,
      notFound: usedCitations.length === 0,
    };
  }
}

function citationLabel(c: RetrievedChunk): string {
  return c.headingPath ? `${c.title} › ${c.headingPath}` : c.title;
}
