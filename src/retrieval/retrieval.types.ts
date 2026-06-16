import { CallerIdentity } from '../auth/identity.types';

export interface RetrievalOptions {
  /** WHO is asking — minted exclusively by IdentityService (P1.2). Principal
   *  mapping expansion and the public-principal append happen INSIDE the
   *  retrieval service, so no caller can fabricate or forget them. */
  identity: CallerIdentity;
  /** Final number of chunks returned after fusion. Defaults to config topK. */
  topK?: number;
  /** Candidates pulled per leg (vector + FTS) before fusion. Defaults to config. */
  candidates?: number;
  /** Optional restriction to specific source systems. */
  sourceSystems?: string[];
  /**
   * The Totem command path for this call (e.g. `/cerebro/search`, `/cerebro/query`),
   * used to authorize a delegated caller against the grant. Ignored for
   * non-delegated callers. Defaults to `/cerebro/search`.
   */
  command?: string;
}

export interface RetrievedChunk {
  id: number;
  documentId: string;
  chunkIndex: number;
  headingPath: string;
  anchor: string | null;
  content: string;
  sourceSystem: string;
  sourceUrl: string;
  title: string;
  /** Section-precise deep link: sourceUrl + #anchor when an anchor exists. */
  deepLink: string;
  /** Reciprocal Rank Fusion score (higher = better). */
  score: number;
  vectorRank: number | null;
  ftsRank: number | null;
}
