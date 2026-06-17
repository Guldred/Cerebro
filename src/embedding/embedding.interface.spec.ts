import { EmbeddingProvider, embedBatched } from './embedding.interface';

/** A provider that records the size of each embed() call and returns one vector
 *  per text (the vector encodes the text index so we can assert order). */
function recordingProvider() {
  const callSizes: number[] = [];
  let offset = 0;
  const provider: EmbeddingProvider = {
    dim: 1,
    model: 'rec',
    embed: async (texts: string[]) => {
      callSizes.push(texts.length);
      return texts.map(() => [offset++]);
    },
  };
  return { provider, callSizes };
}

describe('embedBatched', () => {
  const texts = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

  it('splits into batches of at most maxBatch, preserving order', async () => {
    const { provider, callSizes } = recordingProvider();
    const vecs = await embedBatched(provider, texts(5), 2);
    expect(callSizes).toEqual([2, 2, 1]); // 5 texts, cap 2 → 3 calls
    expect(vecs.map((v) => v[0])).toEqual([0, 1, 2, 3, 4]); // order preserved across batches
  });

  it('a single call when texts fit within the cap', async () => {
    const { provider, callSizes } = recordingProvider();
    await embedBatched(provider, texts(3), 96);
    expect(callSizes).toEqual([3]);
  });

  it('maxBatch <= 0 disables the cap (one call)', async () => {
    const { provider, callSizes } = recordingProvider();
    await embedBatched(provider, texts(10), 0);
    expect(callSizes).toEqual([10]);
  });

  it('exact multiple of maxBatch', async () => {
    const { provider, callSizes } = recordingProvider();
    await embedBatched(provider, texts(4), 2);
    expect(callSizes).toEqual([2, 2]);
  });
});
