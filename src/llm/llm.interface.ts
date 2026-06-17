export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/** One piece of retrieved evidence handed to the model, with a stable citation number. */
export interface EvidenceItem {
  citation: number; // 1-based, stable for the lifetime of one answer
  title: string;
  sourceUrl: string;
  content: string;
}

/** Token accounting for one generation — cost + capacity observability. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GroundedAnswer {
  answer: string;
  /** Citation numbers the model actually used, parsed from [n] markers. */
  usedCitations: number[];
  /** Token usage — from the provider's API `usage` block when present, else a
   *  heuristic estimate (see estimateTokens). */
  usage?: TokenUsage;
}

/** Pluggable generation backend. Every provider must answer ONLY from evidence. */
export interface LlmProvider {
  readonly model: string;
  generateGroundedAnswer(question: string, evidence: EvidenceItem[]): Promise<GroundedAnswer>;
}

/** Rough token estimate (~4 chars/token) for providers/endpoints that don't
 *  return a usage block. Approximate by design — for cost/capacity trend lines,
 *  not billing reconciliation. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Build a TokenUsage from an OpenAI-style `usage` object, falling back to an
 *  estimate over the prompt + completion text when the field is absent. */
export function usageFrom(
  apiUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
  promptText: string,
  completionText: string,
): TokenUsage {
  if (apiUsage && (apiUsage.prompt_tokens != null || apiUsage.total_tokens != null)) {
    const promptTokens = apiUsage.prompt_tokens ?? 0;
    const completionTokens = apiUsage.completion_tokens ?? 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: apiUsage.total_tokens ?? promptTokens + completionTokens,
    };
  }
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/** Extract the distinct [n] citation markers a model emitted, in order of appearance. */
export function parseCitations(answer: string): number[] {
  const seen = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    seen.add(Number.parseInt(m[1], 10));
  }
  return [...seen];
}
