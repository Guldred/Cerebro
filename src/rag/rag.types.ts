import { RetrievedChunk } from '../retrieval/retrieval.types';

export interface Citation {
  number: number; // matches the [n] marker in the answer text
  title: string;
  headingPath: string;
  sourceSystem: string;
  sourceUrl: string;
  deepLink: string; // section-precise link the UI renders as clickable
}

export interface RagAnswer {
  question: string;
  answer: string;
  /** Only the sources the model actually cited. */
  citations: Citation[];
  /** The full retrieved evidence, for transparency/debugging and UI "show sources". */
  evidence: RetrievedChunk[];
  /** True when the evidence was insufficient and the model declined to answer. */
  notFound: boolean;
}
