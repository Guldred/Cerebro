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

/**
 * Batch-embed with a per-request cap (Plan_Review P1.5). A single large document
 * would otherwise put ALL its chunks in one embed() call and blow the provider's
 * per-request item/token limit. Splits `texts` into batches of at most `maxBatch`
 * and concatenates, PRESERVING ORDER (each text is embedded independently, so the
 * vectors are identical to an uncapped call). `maxBatch <= 0` disables the cap.
 */
export async function embedBatched(
  provider: EmbeddingProvider,
  texts: string[],
  maxBatch: number,
): Promise<number[][]> {
  if (maxBatch <= 0 || texts.length <= maxBatch) return provider.embed(texts);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += maxBatch) {
    out.push(...(await provider.embed(texts.slice(i, i + maxBatch))));
  }
  return out;
}

/** Serialize a vector into pgvector's text literal form: "[0.1,0.2,...]". */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
