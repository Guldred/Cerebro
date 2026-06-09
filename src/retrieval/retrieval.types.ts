export interface RetrievalOptions {
  /** Caller's resolved principals (Entra ID groups + user id). The public
   *  principal is always added by the service so public content stays visible. */
  principals: string[];
  /** Final number of chunks returned after fusion. Defaults to config topK. */
  topK?: number;
  /** Candidates pulled per leg (vector + FTS) before fusion. Defaults to config. */
  candidates?: number;
  /** Optional restriction to specific source systems. */
  sourceSystems?: string[];
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
