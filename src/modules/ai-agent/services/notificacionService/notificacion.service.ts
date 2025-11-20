import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { UserService } from '../../../user/user.service'; // <- AJUSTA la ruta si es distinta

@Injectable()
export class AgentNotificationService {
  constructor(
    private readonly logger: LoggerService,
    private readonly userService: UserService,
  ) {}

  async getNotificationPhone(
    userId: string,
    fallbackRemoteJid?: string,
  ): Promise<string | null> {
    try {
      if (!userId) {
        this.logger.warn(
          '[AgentNotificationService] userId vacío al intentar obtener notificationNumber',
        );
        return fallbackRemoteJid ?? null;
      }

      const user = await this.userService.getUserWithPausar(userId);
      const notificationNumber = user?.notificationNumber?.trim();

      if (notificationNumber) {
        return notificationNumber;
      }

      if (fallbackRemoteJid) {
        this.logger.warn(
          `[AgentNotificationService] Usuario sin notificationNumber, usando fallback remoteJid=${fallbackRemoteJid}`,
        );
        return fallbackRemoteJid;
      }

      this.logger.warn(
        '[AgentNotificationService] No se encontró notificationNumber ni fallbackRemoteJid',
      );
      return null;
    } catch (error) {
      this.logger.error(
        `[AgentNotificationService] Error obteniendo notificationNumber para userId=${userId}`,
        error,
      );
      return fallbackRemoteJid ?? null;
    }
  }
}
