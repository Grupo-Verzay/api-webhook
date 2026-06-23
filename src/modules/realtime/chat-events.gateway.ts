import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { verifyRealtimeToken } from './realtime-token.util';

/**
 * Gateway de tiempo real para el módulo de Chats de la app.
 *
 * - Se monta sobre el MISMO servidor HTTP de Nest (puerto 3000, path
 *   /socket.io), por lo que el router de Traefik existente lo expone sin
 *   configuración extra (Traefik hace el upgrade de WebSocket transparente).
 * - El navegador se conecta con un token corto firmado por la app (NextAuth),
 *   que aquí verificamos con el secreto compartido REALTIME_JWT_SECRET.
 * - Cada socket se une a las rooms `user:{userId}` que el token autoriza.
 *
 * Es puramente aditivo: si el secreto no está configurado, todas las conexiones
 * se rechazan y el sistema de chats sigue funcionando con su polling de fondo.
 */
@WebSocketGateway({
  cors: {
    origin: (process.env.REALTIME_CORS_ORIGIN || '*')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    credentials: true,
  },
})
export class ChatEventsGateway implements OnGatewayConnection {
  private readonly logger = new Logger('ChatEventsGateway');

  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket): void {
    try {
      const secret = process.env.REALTIME_JWT_SECRET || '';
      const rawToken =
        (client.handshake.auth?.token as string | undefined) ||
        (client.handshake.query?.token as string | undefined) ||
        '';

      const payload = verifyRealtimeToken(String(rawToken), secret);
      if (!payload) {
        client.disconnect(true);
        return;
      }

      for (const userId of payload.userIds) {
        if (userId) client.join(`user:${userId}`);
      }
      client.data.userIds = payload.userIds;
    } catch (error) {
      this.logger.warn(`Conexión rechazada: ${(error as Error)?.message}`);
      client.disconnect(true);
    }
  }

  /**
   * Notifica que una conversación cambió (mensaje entrante o saliente).
   * El cliente lo usa como disparador para refrescar ese chat / la lista.
   * Nunca lanza: si el servidor aún no está listo, simplemente no emite.
   */
  emitChatChanged(params: {
    userId: string;
    remoteJid: string;
    instanceName?: string | null;
  }): void {
    try {
      if (!params?.userId || !this.server) return;
      this.server.to(`user:${params.userId}`).emit('chat:changed', {
        remoteJid: params.remoteJid,
        instanceName: params.instanceName ?? null,
        ts: Date.now(),
      });
    } catch {
      // No bloquear nunca el flujo del webhook por un fallo de emisión.
    }
  }
}
