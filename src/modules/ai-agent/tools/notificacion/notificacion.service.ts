import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { SystemNotificationDispatcherService } from 'src/modules/whatsapp/services/system-notification-dispatcher.service';

@Injectable()
export class NotificacionToolService {
  constructor(
    private readonly logger: LoggerService,
    private readonly notificationDispatcher: SystemNotificationDispatcherService,
  ) {}

  private normalizePhone(value: string): string {
    const raw = String(value ?? '').split('@')[0];
    return raw.replace(/\D/g, '');
  }

  async handleNotificacionTool(
    args: any,
    sessionId: string,
    _server_url: string,
    _apikey: string,
    _instanceName: string,
    remoteJid: string,
  ): Promise<string> {
    try {
      const sent = await this.notificationDispatcher.sendInternalNotification({
        ownerUserId: sessionId,
        targetUserId: sessionId,
        type: /asesor|humano|transfer|esperando/i.test(String(args.detalles ?? ''))
          ? 'Solicitud de asesor'
          : 'Solicitud',
        name: String(args.nombre ?? 'Contacto'),
        description: String(args.detalles ?? 'Solicitud recibida desde el chat.'),
        contact: this.normalizePhone(remoteJid),
      });

      if (sent <= 0) {
        throw new Error('No se encontro un destino o una linea valida para la notificacion.');
      }

      return 'ok';
    } catch (error) {
      this.logger.error(
        'Error enviando notificacion',
        error?.message,
        'NotificacionToolService',
      );
      return '[ERROR_SENDING_NOTIFICATION]';
    }
  }
}
