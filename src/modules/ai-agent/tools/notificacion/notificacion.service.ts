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
      const appointmentAlreadyCreated = await this.hasActiveAppointment(userId, chatSessionId, remoteJid);
      if (appointmentAlreadyCreated) {
        this.logger.warn(
          `Notificacion_Asesor omitida: el contacto ya tiene una cita/reserva reciente o proxima para sessionId=${chatSessionId}. La cita ya notifico al asesor con "Nuevo aviso: Cita".`,
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

  private async hasActiveAppointment(userId: string, chatSessionId: string, remoteJid: string): Promise<boolean> {
    const sessionId = Number(chatSessionId);
    if (!userId) return false;

    // Ventana amplia: la solicitud de asesor espuria puede dispararse bastante
    // despues de agendar (se han visto ~30 min de diferencia). Suprimimos el
    // aviso de asesor si el contacto agendo en las ultimas 12 h O tiene una cita
    // futura pendiente/confirmada; en ambos casos el asesor ya fue avisado con
    // "Nuevo aviso: Cita" y no debe recibir tambien "Solicitud de asesor".
    const recentSince = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const now = new Date();
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
        status: { notIn: ['CANCELADA', 'DESCARTADO'] as any },
        OR: sessionFilters,
        AND: [
          {
            OR: [
              { createdAt: { gte: recentSince } },
              { startTime: { gte: now } },
            ],
          },
        ],
      },
      select: { id: true },
    });

    return Boolean(appointment);
  }
}
