import { Injectable } from '@nestjs/common';
import { NodeSenderService } from 'src/modules/workflow/services/node-sender.service.ts/node-sender.service';
import { LoggerService } from 'src/core/logger/logger.service';
import { NotificationContactsService } from 'src/modules/ai-agent/services/notificacionService/notification-contacts.service';

@Injectable()
export class NotificacionToolService {
  constructor(
    private readonly nodeSenderService: NodeSenderService,
    private readonly logger: LoggerService,
    private readonly notificationContactsService: NotificationContactsService,
  ) {}

  async handleNotificacionTool(
    args: any,
    sessionId: string,
    server_url: string,
    apikey: string,
    instanceName: string,
    remoteJid: string,
  ): Promise<string> {
    try {
      const phones = await this.notificationContactsService.getActiveNumbers(sessionId);

      if (phones.length === 0) {
        throw new Error(
          'El usuario no tiene números de notificación configurados',
        );
      }

      const celular = remoteJid.split('@')[0];
      const message = `✅ *Tienes Nueva Solicitud:*\n\n👤 *Nombre:* ${args.nombre}\n📝 *Descripción:*\n${args.detalles}\n\n📱 *WhatsApp del usuario:*\n\n👉 +${celular}`;
      const url = `${server_url}/message/sendText/${instanceName}`;

      await Promise.all(
        phones.map((phone) =>
          this.nodeSenderService.sendTextNode(url, apikey, phone, message),
        ),
      );

      return `ok`;
    } catch (error) {
      this.logger.error(
        'Error enviando notificación',
        error?.message,
        'NotificacionToolService',
      );
      return '[ERROR_SENDING_NOTIFICATION]';
    }
  }
}
