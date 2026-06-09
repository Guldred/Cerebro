export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

/**
 * Pluggable embedding backend. The vector dimension is fixed per provider and
 * MUST match the pgvector column (see the dimension contract in 001_init.sql).
 */
export interface EmbeddingProvider {
  /** Output dimension of every vector this provider returns. */
  readonly dim: number;
  /** Human-readable id of the active model, for logging/observability. */
  readonly model: string;
  /** Batch-embed. Order of the result matches the order of `texts`. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Convenience: embed a single string. */
export async function embedOne(provider: EmbeddingProvider, text: string): Promise<number[]> {
  const [vec] = await provider.embed([text]);
  return vec;
}

/** Serialize a vector into pgvector's text literal form: "[0.1,0.2,...]". */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
