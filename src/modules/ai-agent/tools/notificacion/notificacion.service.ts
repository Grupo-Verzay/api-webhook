import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { SystemNotificationDispatcherService } from 'src/modules/whatsapp/services/system-notification-dispatcher.service';

@Injectable()
export class NotificacionToolService {
  constructor(
    private readonly logger: LoggerService,
    private readonly prisma: PrismaService,
    private readonly notificationDispatcher: SystemNotificationDispatcherService,
  ) {}

  private normalizePhone(value: string): string {
    const raw = String(value ?? '').split('@')[0];
    return raw.replace(/\D/g, '');
  }

  async handleNotificacionTool(
    args: any,
    userId: string,
    chatSessionId: string,
    _server_url: string,
    _apikey: string,
    _instanceName: string,
    remoteJid: string,
  ): Promise<string> {
    try {
      const appointmentAlreadyCreated = await this.hasRecentAppointment(userId, chatSessionId);
      if (appointmentAlreadyCreated) {
        this.logger.warn(
          `Notificacion_Asesor omitida: ya existe una cita/reserva reciente para sessionId=${chatSessionId}`,
          'NotificacionToolService',
        );
        return 'skipped_appointment';
      }

      const details = String(args.detalles ?? '');
      const sent = await this.notificationDispatcher.sendInternalNotification({
        ownerUserId: userId,
        targetUserId: userId,
        type: /asesor|humano|transfer|atenci[oó]n humana|agente humano|persona real/i.test(details)
          ? 'Solicitud de asesor'
          : 'Solicitud',
        name: String(args.nombre ?? 'Contacto'),
        description: details || 'Solicitud recibida desde el chat.',
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

  private async hasRecentAppointment(userId: string, chatSessionId: string): Promise<boolean> {
    const sessionId = Number(chatSessionId);
    if (!userId || !Number.isInteger(sessionId) || sessionId <= 0) return false;

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const appointment = await this.prisma.appointment.findFirst({
      where: {
        userId,
        sessionId,
        createdAt: { gte: tenMinutesAgo },
      },
      select: { id: true },
    });

    return Boolean(appointment);
  }
}
