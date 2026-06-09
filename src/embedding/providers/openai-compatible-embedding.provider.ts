import { CerebroConfig } from '../../config/config';
import { EmbeddingProvider } from '../embedding.interface';

/**
 * Any OpenAI-compatible embeddings endpoint. This is the path for self-hosted,
 * GDPR-friendly multilingual models — e.g. bge-m3 or multilingual-e5 served via
 * HuggingFace TEI, vLLM, or Ollama — which is the recommended production default
 * for a DE+EN corpus. Set EMBEDDING_BASE_URL/EMBEDDING_MODEL (and dim to 1024).
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;

  constructor(
    readonly dim: number,
    private readonly cfg: CerebroConfig['embedding']['openaiCompatible'],
  ) {
    this.model = cfg.model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;

    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.cfg.model, input: texts }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Embedding endpoint failed: ${res.status} ${body}`);
    }

    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
