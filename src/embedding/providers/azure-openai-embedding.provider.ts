import { Logger } from '@nestjs/common';
import { CerebroConfig } from '../../config/config';
import { EmbeddingProvider } from '../embedding.interface';

/**
 * Azure OpenAI embeddings (EU region for GDPR). Real implementation; needs
 * AZURE_OPENAI_* env vars. text-embedding-3-large is 3072-dim natively — to fit
 * pgvector's 2000-dim HNSW ceiling we request the `dimensions` parameter so the
 * output matches the column. Keep EMBEDDING_DIM and the migration in sync.
 */
export class AzureOpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly log = new Logger(AzureOpenAIEmbeddingProvider.name);
  readonly model: string;

  constructor(
    readonly dim: number,
    private readonly cfg: CerebroConfig['embedding']['azure'],
  ) {
    if (!cfg.endpoint || !cfg.apiKey) {
      throw new Error(
        'EMBEDDING_PROVIDER=azure-openai requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY',
      );
    }
    this.model = cfg.deployment;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const url =
      `${this.cfg.endpoint.replace(/\/$/, '')}/openai/deployments/${this.cfg.deployment}` +
      `/embeddings?api-version=${this.cfg.apiVersion}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': this.cfg.apiKey },
      body: JSON.stringify({ input: texts, dimensions: this.dim }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Azure embeddings failed: ${res.status} ${body}`);
    }

    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    // Azure does not guarantee response order — sort by `index`.
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
