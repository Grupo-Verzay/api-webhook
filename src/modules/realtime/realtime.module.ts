import { Global, Module } from '@nestjs/common';
import { ChatEventsGateway } from './chat-events.gateway';

/**
 * Módulo global de tiempo real. Al ser @Global, el ChatEventsGateway queda
 * disponible para inyección en cualquier servicio (p. ej. WebhookService) sin
 * tener que importarlo en cada módulo.
 */
@Global()
@Module({
  providers: [ChatEventsGateway],
  exports: [ChatEventsGateway],
})
export class RealtimeModule {}
