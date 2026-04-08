import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';

const DISABLED_SENTINEL = '0000000000';

/**
 * SRP: única responsabilidad — resolver la lista completa de números de
 * notificación activos para un usuario (número primario + contactos adicionales).
 *
 * DIP: los servicios consumidores dependen de esta abstracción en lugar de
 * acceder directamente al modelo User.
 */
@Injectable()
export class NotificationContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Devuelve todos los números de notificación configurados para el usuario.
   * El número primario (User.notificationNumber) siempre va primero si está activo.
   * Los contactos adicionales (UserNotificationContact) se agregan a continuación.
   */
  async getActiveNumbers(userId: string): Promise<string[]> {
    if (!userId) return [];

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        notificationNumber: true,
        notificationContacts: {
          select: { phone: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!user) {
      this.logger.warn(
        `[NotificationContactsService] Usuario no encontrado: ${userId}`,
      );
      return [];
    }

    const numbers: string[] = [];

    const primary = user.notificationNumber?.trim();
    if (primary && primary !== DISABLED_SENTINEL) {
      numbers.push(primary);
    }

    for (const contact of user.notificationContacts ?? []) {
      const phone = contact.phone?.trim();
      if (phone && phone !== DISABLED_SENTINEL && !numbers.includes(phone)) {
        numbers.push(phone);
      }
    }

    return numbers;
  }
}
