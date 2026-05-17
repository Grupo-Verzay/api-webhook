import { json, text, urlencoded } from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Aumentar límites del body
  app.use(json({ limit: '50mb' }));
  app.use(text({ type: 'text/plain', limit: '50mb' }));
  app.use(urlencoded({ limit: '50mb', extended: true }));

  await app.listen(process.env.PORT || 3000);
}
bootstrap();
