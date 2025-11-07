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
    sessionId: string,            // aquí realmente llega userId (mantenemos el nombre para no romper firmas)
    server_url: string,
    apikey: string,
    instanceName: string,
    remoteJid: string
  ): Promise<string> {
    try {
      // 🔍 Buscar el número de notificación desde el "userId"
      const user = await this.prisma.user.findUnique({
        where: { id: sessionId },
      });

      const notificacionNumber = user?.notificationNumber;
      const celular = remoteJid.split('@')[0];

      if (!notificacionNumber) {
        throw new Error('El usuario no tiene un número de notificación configurado');
      }

      // 🧹 Normaliza los campos esperados
      const detalle =
        args?.detalle_notificacion ??
        args?.detalles ??
        args?.detalle ??
        args?.descripcion ??
        'Solicita hablar con un asesor.';

      const nombre =
        args?.nombre ??
        args?.name ??
        'Cliente';

      // 📲 Envía mensaje al asesor
      await this.nodeSenderService.sendTextNode(
        server_url + '/message/sendText/' + instanceName,
        apikey,
        notificacionNumber,
        `✅ *Tienes Nueva Solicitud:*\n\n👤 *Nombre:* ${nombre}\n📝 *Descripción:*\n${detalle}\n\n📱 *WhatsApp del usuario:*\n\n👉 +${celular}`
      );

      // 🗣️ Retorna el mensaje final que verá el usuario (lo tomará el agente principal)
      return '📝 ¡He registrado tu solicitud! 👨🏻‍💻 Un asesor se pondrá en contacto a la brevedad posible. ⏰';
    } catch (error) {
      this.logger.error('Error enviando notificación', (error as any)?.message, 'NotificacionToolService');
      return '[ERROR_SENDING_NOTIFICATION]';
    }
  }
}
