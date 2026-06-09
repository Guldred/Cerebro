import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CONFIG, CerebroConfig } from './config/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  const config = app.get<CerebroConfig>(CONFIG);
  await app.listen(config.port);
  new Logger('Bootstrap').log(`Cerebro API listening on http://localhost:${config.port}`);
}

void bootstrap();
