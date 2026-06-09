import { FakeEmbeddingProvider } from './fake-embedding.provider';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both vectors are L2-normalized, so dot product = cosine similarity
}

describe('FakeEmbeddingProvider', () => {
  const provider = new FakeEmbeddingProvider(1024);

  it('produces vectors of the configured dimension', async () => {
    const [vec] = await provider.embed(['hello world']);
    expect(vec).toHaveLength(1024);
  });

  it('is deterministic and L2-normalized', async () => {
    const [a] = await provider.embed(['database setup guide']);
    const [b] = await provider.embed(['database setup guide']);
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('ranks token-overlapping text higher than unrelated text (the dense leg is meaningful)', async () => {
    const [q] = await provider.embed(['database setup guide']);
    const [related] = await provider.embed(['database setup steps']);
    const [unrelated] = await provider.embed(['banana fruit smoothie recipe']);
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
  });
});
