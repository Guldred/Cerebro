import { parseCitations } from '../llm/llm.interface';

/**
 * Machine-checkable citation verification (Plan_Review P3). The system's value
 * is that every answer is verifiable, so a citation the model emitted MUST point
 * at a piece of evidence that was actually in context. A `[n]` marker outside the
 * provided evidence range is a HALLUCINATED source — the model invented a
 * reference. This check is deterministic (no model needed): it partitions the
 * cited markers into grounded vs hallucinated and strips the hallucinated ones
 * from the displayed answer so a reader never sees a citation that links nowhere.
 *
 * It does NOT (yet) verify that the answer's CLAIMS are entailed by the cited
 * evidence — that is the NLI/groundedness step, which needs a model and is a
 * follow-up. This closes the cheaper, deterministic half: no dangling citations.
 */
export interface CitationCheck {
  /** Cited markers that map to a real evidence item (1..evidenceCount). */
  grounded: number[];
  /** Cited markers with no backing evidence — the model fabricated them. */
  hallucinated: number[];
  /** The answer with hallucinated [n] markers removed (and whitespace tidied). */
  cleanedAnswer: string;
}

export function verifyCitations(answer: string, evidenceCount: number): CitationCheck {
  const grounded: number[] = [];
  const hallucinated: number[] = [];
  for (const n of parseCitations(answer)) {
    if (n >= 1 && n <= evidenceCount) grounded.push(n);
    else hallucinated.push(n);
  }

  let cleanedAnswer = answer;
  for (const n of hallucinated) {
    // Drop the marker and any space immediately before it ("foo [9]" → "foo").
    cleanedAnswer = cleanedAnswer.replace(new RegExp(`\\s*\\[${n}\\]`, 'g'), '');
  }
  cleanedAnswer = cleanedAnswer.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();

  return { grounded, hallucinated, cleanedAnswer };
}
