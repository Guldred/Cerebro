export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/** One piece of retrieved evidence handed to the model, with a stable citation number. */
export interface EvidenceItem {
  citation: number; // 1-based, stable for the lifetime of one answer
  title: string;
  sourceUrl: string;
  content: string;
}

export interface GroundedAnswer {
  answer: string;
  /** Citation numbers the model actually used, parsed from [n] markers. */
  usedCitations: number[];
}

/** Pluggable generation backend. Every provider must answer ONLY from evidence. */
export interface LlmProvider {
  readonly model: string;
  generateGroundedAnswer(question: string, evidence: EvidenceItem[]): Promise<GroundedAnswer>;
}

/** Extract the distinct [n] citation markers a model emitted, in order of appearance. */
export function parseCitations(answer: string): number[] {
  const seen = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    seen.add(Number.parseInt(m[1], 10));
  }
  return [...seen];
}
