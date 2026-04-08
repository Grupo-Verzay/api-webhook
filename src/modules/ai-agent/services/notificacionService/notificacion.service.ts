import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { NotificationContactsService } from './notification-contacts.service';

@Injectable()
export class AgentNotificationService {
  constructor(
    private readonly logger: LoggerService,
    private readonly notificationContactsService: NotificationContactsService,
  ) {}

  /**
   * Devuelve todos los números de notificación activos para el usuario.
   * Si no hay ninguno, retorna el fallbackRemoteJid como único elemento (si existe).
   */
  async getNotificationPhones(
    userId: string,
    fallbackRemoteJid?: string,
  ): Promise<string[]> {
    try {
      if (!userId) {
        this.logger.warn(
          '[AgentNotificationService] userId vacío al intentar obtener números de notificación',
        );
        return fallbackRemoteJid ? [fallbackRemoteJid] : [];
      }

      const phones = await this.notificationContactsService.getActiveNumbers(userId);

      if (phones.length > 0) {
        return phones;
      }

      if (fallbackRemoteJid) {
        this.logger.warn(
          `[AgentNotificationService] Sin números configurados, usando fallback remoteJid=${fallbackRemoteJid}`,
        );
        return [fallbackRemoteJid];
      }

      this.logger.warn(
        '[AgentNotificationService] No se encontró ningún número de notificación ni fallbackRemoteJid',
      );
      return [];
    } catch (error) {
      this.logger.error(
        `[AgentNotificationService] Error obteniendo números para userId=${userId}`,
        error,
      );
      return fallbackRemoteJid ? [fallbackRemoteJid] : [];
    }
  }

  /**
   * @deprecated Usar getNotificationPhones() para soporte multi-número.
   * Mantenido por compatibilidad con código existente que espera un solo string.
   */
  async getNotificationPhone(
    userId: string,
    fallbackRemoteJid?: string,
  ): Promise<string | null> {
    const phones = await this.getNotificationPhones(userId, fallbackRemoteJid);
    return phones[0] ?? null;
  }
}
