import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CONFIG, CerebroConfig } from './config/config';

async function bootstrap(): Promise<void> {
  // Input validation is wired as an APP_PIPE in ApiModule (applies on every boot
  // path), so no useGlobalPipes here.
  const app = await NestFactory.create(AppModule);

  const config = app.get<CerebroConfig>(CONFIG);
  await app.listen(config.port);
  new Logger('Bootstrap').log(`Cerebro API listening on http://localhost:${config.port}`);
}

void bootstrap();
