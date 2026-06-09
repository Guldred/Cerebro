import { Global, Logger, Module } from '@nestjs/common';
import { CONFIG, CerebroConfig } from '../config/config';
import { LLM_PROVIDER, LlmProvider } from './llm.interface';
import { FakeLlmProvider } from './providers/fake-llm.provider';
import { AzureOpenAILlmProvider } from './providers/azure-openai-llm.provider';
import { OpenAICompatibleLlmProvider } from './providers/openai-compatible-llm.provider';

function createLlmProvider(config: CerebroConfig): LlmProvider {
  const { provider } = config.llm;
  let impl: LlmProvider;
  switch (provider) {
    case 'azure-openai':
      impl = new AzureOpenAILlmProvider(config.llm.azure);
      break;
    case 'openai-compatible':
      impl = new OpenAICompatibleLlmProvider(config.llm.openaiCompatible);
      break;
    case 'fake':
      impl = new FakeLlmProvider();
      break;
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
  }
  new Logger('LlmModule').log(`LLM provider=${provider} model=${impl.model}`);
  return impl;
}

@Global()
@Module({
  providers: [{ provide: LLM_PROVIDER, useFactory: createLlmProvider, inject: [CONFIG] }],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
