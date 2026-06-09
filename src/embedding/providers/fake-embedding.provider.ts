import { EmbeddingProvider } from '../embedding.interface';

/**
 * Deterministic, key-free embedding for local dev, CI and the eval harness.
 *
 * This is a hashing vectorizer (the "hashing trick"): every token is hashed into
 * a bucket of the output vector with a signed weight, then the vector is
 * L2-normalized. The result is NOT random noise — two texts that share tokens get
 * a high cosine similarity, so the dense-retrieval leg ranks sensibly without any
 * model server. It will not capture true semantics (synonyms, cross-lingual
 * matches); swap in `bge-m3` via the openai-compatible provider for that. Behind
 * the EmbeddingProvider interface, nothing downstream changes.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'fake-hashing-vectorizer';

  constructor(readonly dim: number) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedText(t));
  }

  private embedText(text: string): number[] {
    const vec = new Float64Array(this.dim);
    const tokens = tokenize(text);
    for (const tok of tokens) {
      const h = fnv1a(tok);
      const bucket = h % this.dim;
      const sign = (h >>> 31) & 1 ? 1 : -1; // second bit of the hash → sign
      vec[bucket] += sign;
    }
    return l2normalize(vec);
  }
}

/** Lowercase, split on non-alphanumeric (Unicode letters/digits incl. äöüß). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

/** 32-bit FNV-1a hash — small, fast, deterministic across runs and machines. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2normalize(vec: Float64Array): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  const out = new Array<number>(vec.length);
  if (norm === 0) {
    out.fill(0);
    return out;
  }
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}
