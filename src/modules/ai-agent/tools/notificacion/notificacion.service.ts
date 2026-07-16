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
      const details = String(args.detalles ?? '');
      const appointmentAlreadyCreated = await this.hasRecentAppointment(userId, chatSessionId, remoteJid);
      if (appointmentAlreadyCreated) {
        this.logger.warn(
          `Notificacion_Asesor omitida: ya existe una cita/reserva reciente para sessionId=${chatSessionId}`,
          'NotificacionToolService',
        );
        return 'skipped_appointment';
      }

      if (this.isGenericAdvisorNotification(details)) {
        this.logger.warn(
          `Notificacion_Asesor omitida: detalle generico sin solicitud humana explicita para remoteJid=${remoteJid}`,
          'NotificacionToolService',
        );
        return 'skipped_generic_advisor';
      }

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

  private isGenericAdvisorNotification(details: string): boolean {
    const normalized = details
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    return normalized.includes('este contacto esta esperando tu respuesta en el chat');
  }

  private async hasRecentAppointment(userId: string, chatSessionId: string, remoteJid: string): Promise<boolean> {
    const sessionId = Number(chatSessionId);
    if (!userId) return false;

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const remote = String(remoteJid ?? '').trim();
    const remotePhone = this.normalizePhone(remote);

    const sessionFilters: any[] = [];
    if (Number.isInteger(sessionId) && sessionId > 0) {
      sessionFilters.push({ sessionId });
    }
    if (remote) {
      sessionFilters.push({
        session: {
          userId,
          OR: [
            { remoteJid: remote },
            { remoteJidAlt: remote },
            ...(remotePhone
              ? [
                  { remoteJid: { contains: remotePhone } },
                  { remoteJidAlt: { contains: remotePhone } },
                ]
              : []),
          ],
        },
      });
    }
    if (!sessionFilters.length) return false;

    const appointment = await this.prisma.appointment.findFirst({
      where: {
        userId,
        createdAt: { gte: tenMinutesAgo },
        OR: sessionFilters,
      },
      select: { id: true },
    });

    return Boolean(appointment);
  }
}
