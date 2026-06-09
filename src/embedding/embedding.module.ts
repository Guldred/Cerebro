import { Global, Logger, Module } from '@nestjs/common';
import { CONFIG, CerebroConfig } from '../config/config';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from './embedding.interface';
import { FakeEmbeddingProvider } from './providers/fake-embedding.provider';
import { AzureOpenAIEmbeddingProvider } from './providers/azure-openai-embedding.provider';
import { OpenAICompatibleEmbeddingProvider } from './providers/openai-compatible-embedding.provider';

function createEmbeddingProvider(config: CerebroConfig): EmbeddingProvider {
  const { provider, dim } = config.embedding;
  let impl: EmbeddingProvider;
  switch (provider) {
    case 'azure-openai':
      impl = new AzureOpenAIEmbeddingProvider(dim, config.embedding.azure);
      break;
    case 'openai-compatible':
      impl = new OpenAICompatibleEmbeddingProvider(dim, config.embedding.openaiCompatible);
      break;
    case 'fake':
      impl = new FakeEmbeddingProvider(dim);
      break;
    default:
      throw new Error(`Unknown EMBEDDING_PROVIDER: ${provider}`);
  }
  new Logger('EmbeddingModule').log(`Embedding provider=${provider} model=${impl.model} dim=${impl.dim}`);
  return impl;
}

@Global()
@Module({
  providers: [
    { provide: EMBEDDING_PROVIDER, useFactory: createEmbeddingProvider, inject: [CONFIG] },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingModule {}
