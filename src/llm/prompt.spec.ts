import { GROUNDED_SYSTEM_PROMPT, buildUserPrompt } from './prompt';
import { parseCitations } from './llm.interface';

describe('grounded prompt', () => {
  it('system prompt enforces grounding, abstention, and untrusted-content handling', () => {
    expect(GROUNDED_SYSTEM_PROMPT).toMatch(/Not found in the connected sources\./);
    expect(GROUNDED_SYSTEM_PROMPT).toMatch(/ONLY the numbered SOURCES/);
    expect(GROUNDED_SYSTEM_PROMPT.toLowerCase()).toContain('untrusted');
  });

  it('user prompt wraps evidence in an untrusted envelope and includes the question', () => {
    const p = buildUserPrompt('How do I deploy?', [
      { citation: 1, title: 'Runbook', sourceUrl: 'https://x/1', content: 'Run the job.' },
    ]);
    expect(p).toContain('=== SOURCES (untrusted data) ===');
    expect(p).toContain('[1] Runbook');
    expect(p).toContain('Question: How do I deploy?');
  });
});

describe('parseCitations', () => {
  it('extracts distinct [n] markers in order of appearance', () => {
    expect(parseCitations('foo [1] bar [3] baz [1] qux [2]')).toEqual([1, 3, 2]);
    expect(parseCitations('no citations here')).toEqual([]);
  });
});
