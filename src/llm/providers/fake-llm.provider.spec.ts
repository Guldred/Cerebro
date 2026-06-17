import { FakeLlmProvider } from './fake-llm.provider';
import { EvidenceItem } from '../llm.interface';

const ev = (citation: number, content: string): EvidenceItem => ({
  citation,
  title: `Doc ${citation}`,
  sourceUrl: `https://example.com/${citation}`,
  content,
});

describe('FakeLlmProvider', () => {
  const llm = new FakeLlmProvider();

  it('abstains when there is no evidence', async () => {
    const r = await llm.generateGroundedAnswer('anything?', []);
    expect(r.answer).toBe('Not found in the connected sources.');
    expect(r.usedCitations).toEqual([]);
  });

  it('reports estimated token usage on every path (cost observability)', async () => {
    const answered = await llm.generateGroundedAnswer('What is the rollback procedure?', [
      ev(1, 'The rollback procedure: re-run the previous successful deployment job.'),
    ]);
    expect(answered.usage).toBeDefined();
    expect(answered.usage!.promptTokens).toBeGreaterThan(0);
    expect(answered.usage!.completionTokens).toBeGreaterThan(0);
    expect(answered.usage!.totalTokens).toBe(answered.usage!.promptTokens + answered.usage!.completionTokens);

    const abstained = await llm.generateGroundedAnswer('anything?', []);
    expect(abstained.usage!.totalTokens).toBeGreaterThan(0); // even the abstention path accounts tokens
  });

  it('abstains when evidence is only weakly related', async () => {
    const r = await llm.generateGroundedAnswer('What are the engineering salary bands?', [
      ev(1, 'The weather today is mild and the canteen serves soup.'),
    ]);
    expect(r.answer).toBe('Not found in the connected sources.');
    expect(r.usedCitations).toEqual([]);
  });

  it('answers with a citation when evidence strongly supports the question', async () => {
    const r = await llm.generateGroundedAnswer('What is the rollback procedure for a failed deployment?', [
      ev(1, 'The rollback procedure: re-run the previous successful deployment job.'),
    ]);
    expect(r.answer).toContain('[1]');
    expect(r.usedCitations).toContain(1);
  });

  it('matches morphological variants via light stemming', async () => {
    // band↔bands, engineer↔engineering, cover↔covers → ≥2 content-token overlap
    const r = await llm.generateGroundedAnswer('What do the engineering salary bands cover?', [
      ev(4, 'Band E5 covers staff engineers and lists the salary ranges.'),
    ]);
    expect(r.usedCitations).toContain(4);
  });
});
