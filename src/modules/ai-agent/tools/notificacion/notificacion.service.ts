import { Injectable } from '@nestjs/common';
import { NodeSenderService } from 'src/modules/workflow/services/node-sender.service.ts/node-sender.service';
import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';

@Injectable()
export class NotificacionToolService {
  constructor(
    private readonly nodeSenderService: NodeSenderService,
    private readonly logger: LoggerService,
    private readonly prisma: PrismaService,
  ) { }

  async handleNotificacionTool(
    args: any,
    sessionId: string,
    server_url: string,
    apikey: string,
    instanceName: string,
    remoteJid: string
  ): Promise<string> {
    try {
      // 🔍 Buscar el número de notificación desde la sesión
      const user = await this.prisma.user.findUnique({
        where: { id: sessionId },
      });

      const notificacionNumber = user?.notificationNumber;
      const celular = remoteJid.split('@')[0];

      if (!notificacionNumber) {
        throw new Error('El usuario no tiene un número de notificación configurado');
      }

      await this.nodeSenderService.sendTextNode(
        server_url + '/message/sendText/' + instanceName,
        apikey,
        notificacionNumber,
        `✅ *Tienes Nueva Solicitud:*\n\n👤 *Nombre:* ${args.nombre}\n📝 *Descripción:*\n${args.detalles}\n\n📱 *WhatsApp del usuario:*\n\n👉 +${celular}`
      );
      return `✅ Notificación enviada para ${args.nombre} con detalles: ${args.detalles}`;
    } catch (error) {
      this.logger.error('Error enviando notificación', error?.message, 'NotificacionToolService');
      return '[ERROR_SENDING_NOTIFICATION]';
    }
  }
}