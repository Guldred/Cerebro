import { EvidenceItem, GroundedAnswer, LlmProvider, usageFrom } from '../llm.interface';
import { tokenize } from '../../embedding/providers/fake-embedding.provider';

/**
 * Deterministic, key-free generator for local dev, CI and the eval harness.
 *
 * It does not call any model. Instead it performs faithful EXTRACTIVE
 * summarization: it scores each sentence in the evidence by token overlap with
 * the question and stitches the best ones together, each tagged with its source
 * citation [n]. This exercises the entire RAG path — retrieval → grounded answer
 * → citations → "not found" behaviour — with reproducible output. Swap in a real
 * provider for abstractive answers; the interface is identical.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly model = 'fake-extractive';

  async generateGroundedAnswer(
    question: string,
    evidence: EvidenceItem[],
  ): Promise<GroundedAnswer> {
    // Estimated usage (no real model/API) so the cost-observability path is
    // exercised end-to-end on the fake provider too.
    const promptText = [question, ...evidence.map((e) => e.content)].join('\n');
    const notFound = (): GroundedAnswer => {
      const answer = 'Not found in the connected sources.';
      return { answer, usedCitations: [], usage: usageFrom(undefined, promptText, answer) };
    };

    if (evidence.length === 0) {
      return notFound();
    }

    // Score on CONTENT tokens only (drop stopwords) so a sentence sharing just
    // "the"/"for"/"und" with the question doesn't count as support. Light stemming
    // lets morphological variants match (band↔bands, cover↔covers, engineer↔
    // engineering) — a real LLM handles this natively; the stub approximates it.
    const contentQTokens = tokenize(question)
      .filter((t) => !STOPWORDS.has(t))
      .map(stem);
    const qTokens = new Set(contentQTokens);
    // Require a sentence to share ≥2 content tokens (or 1 if the question itself
    // has only one) before it counts as an answer — otherwise abstain. This makes
    // the fake provider exhibit the same "not found on weak evidence" behaviour a
    // grounded LLM should, instead of answering from loosely-related context.
    const minOverlap = contentQTokens.length <= 1 ? 1 : 2;

    type Scored = { citation: number; sentence: string; score: number };
    const scored: Scored[] = [];

    for (const e of evidence) {
      for (const sentence of splitSentences(e.content)) {
        const sTokens = tokenize(sentence).map(stem);
        if (sTokens.length === 0) continue;
        const overlap = new Set(sTokens.filter((t) => qTokens.has(t))).size;
        if (overlap >= minOverlap) {
          scored.push({ citation: e.citation, sentence: sentence.trim(), score: overlap });
        }
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 3);

    if (top.length === 0) {
      // Evidence retrieved but nothing meaningfully matched the question.
      return notFound();
    }

    const usedCitations: number[] = [];
    const parts = top.map((t) => {
      if (!usedCitations.includes(t.citation)) usedCitations.push(t.citation);
      return `${t.sentence} [${t.citation}]`;
    });

    const answer = parts.join(' ');
    return { answer, usedCitations, usage: usageFrom(undefined, promptText, answer) };
  }
}

// Small EN+DE stoplist — enough to stop function words from counting as support.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'for', 'and', 'or', 'in', 'on',
  'at', 'how', 'do', 'does', 'can', 'what', 'which', 'with', 'as', 'that', 'this', 'my', 'me',
  'you', 'it', 'its', 'i', 'we', 'der', 'die', 'das', 'des', 'dem', 'den', 'und', 'oder', 'für',
  'auf', 'ist', 'sind', 'wie', 'ein', 'eine', 'einen', 'im', 'zu', 'mit', 'ich', 'man', 'kann',
  'gilt', 'werden', 'wird',
]);

/** Very light suffix stripping — enough to unify common EN/DE inflections. */
function stem(token: string): string {
  if (token.length <= 4) return token;
  for (const suffix of ['ing', 'en', 'es', 'ed', 's', 'e']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0);
}
