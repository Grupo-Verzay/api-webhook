import { json, urlencoded } from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Aumentar límites del body
  app.use(json({ limit: '50mb' })); // para JSON
  app.use(urlencoded({ limit: '5  0mb', extended: true })); // para formularios x-www-form-urlencoded

  await app.listen(process.env.PORT || 3000);
}
bootstrap();