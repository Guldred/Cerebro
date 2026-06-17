import { CerebroConfig } from '../config/config';
import { GroundedAnswer, LlmProvider } from '../llm/llm.interface';
import { RetrievalService } from '../retrieval/retrieval.service';
import { RetrievedChunk } from '../retrieval/retrieval.types';
import { CallerIdentity } from '../auth/identity.types';
import { RagService } from './rag.service';

const config = { observability: { logQueryText: false } } as CerebroConfig;
const identity: CallerIdentity = { subject: 'oid-1', principals: ['entra-user:oid-1'], mode: 'oidc' };

function chunk(documentId: string, content: string): RetrievedChunk {
  return {
    id: 1,
    documentId,
    chunkIndex: 0,
    headingPath: '',
    anchor: null,
    content,
    sourceSystem: 'confluence',
    sourceUrl: 'https://x/1',
    title: 'Doc',
    deepLink: 'https://x/1',
    score: 1,
    vectorRank: 1,
    ftsRank: 1,
  };
}

function ragWith(chunks: RetrievedChunk[], answer: GroundedAnswer): { rag: RagService } {
  const retrieval = { search: async () => chunks } as unknown as RetrievalService;
  const llm = { model: 'fake', generateGroundedAnswer: async () => answer } as unknown as LlmProvider;
  return { rag: new RagService(config, retrieval, llm) };
}

describe('RagService observability threading', () => {
  it('surfaces token usage + per-stage timings on an answered query', async () => {
    const { rag } = ragWith(
      [chunk('confluence:1', 'The rollback procedure is to re-run the last good job.')],
      {
        answer: 'Re-run the last good job [1]',
        usedCitations: [1],
        usage: { promptTokens: 40, completionTokens: 8, totalTokens: 48 },
      },
    );
    const result = await rag.answer('rollback?', { identity });

    expect(result.notFound).toBe(false);
    expect(result.usage).toEqual({ promptTokens: 40, completionTokens: 8, totalTokens: 48 });
    expect(result.timings).toBeDefined();
    expect(result.timings!.totalMs).toBeGreaterThanOrEqual(result.timings!.retrievalMs);
    expect(result.citations).toHaveLength(1);
  });

  it('no retrieval hits → notFound with timings (generation skipped)', async () => {
    const { rag } = ragWith([], { answer: '', usedCitations: [] });
    const result = await rag.answer('nothing matches', { identity });

    expect(result.notFound).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.timings!.generationMs).toBe(0);
  });

  it('evidence retrieved but model cited nothing → notFound', async () => {
    const { rag } = ragWith([chunk('confluence:1', 'unrelated content')], {
      answer: 'Not found in the connected sources.',
      usedCitations: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    const result = await rag.answer('q', { identity });
    expect(result.notFound).toBe(true);
    expect(result.usage!.totalTokens).toBe(15);
  });
});
