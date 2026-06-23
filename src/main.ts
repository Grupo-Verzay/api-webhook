import { json, text, urlencoded } from 'express';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Adaptador de socket.io montado sobre el mismo servidor HTTP (puerto 3000,
  // path /socket.io). Lo usa el ChatEventsGateway para el tiempo real de Chats.
  app.useWebSocketAdapter(new IoAdapter(app));

  app.useGlobalPipes(new ValidationPipe({ transform: true }));

  // Aumentar límites del body
  app.use(json({ limit: '50mb' }));
  app.use(text({ type: 'text/plain', limit: '50mb' }));
  app.use(urlencoded({ limit: '50mb', extended: true }));

  await app.listen(process.env.PORT || 3000);
}
bootstrap();
