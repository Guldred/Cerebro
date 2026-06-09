import { Global, Module } from '@nestjs/common';
import { CONFIG, loadConfig } from './config';

/**
 * Global so every module can inject the typed config via `@Inject(CONFIG)`
 * without re-importing.
 */
@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: loadConfig }],
  exports: [CONFIG],
})
export class ConfigModule {}
