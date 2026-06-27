import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';

type ChatMessagesCleanupSettings = {
  enabled: boolean;
  intervalMs: number;
  retentionDays: number;
  batchSize: number;
};

/**
 * Limpieza periódica de la tabla `chat_messages` (BD del CRM): borra los
 * mensajes con más de N días (por defecto 180), alineado con la regla de
 * ciclo de vida de MinIO. Así no quedan mensajes apuntando a media ya
 * expirada y la tabla no crece sin límite.
 *
 * OPT-IN: solo corre si CHAT_MESSAGES_CLEANUP_ENABLED=true (es una operación
 * destructiva, no debe activarse por accidente en un despliegue).
 * El borrado se hace en lotes para no bloquear la tabla.
 */
@Injectable()
export class ChatMessagesCleanupService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
  ) {}

  getSettings(): ChatMessagesCleanupSettings {
    return {
      enabled:
        this.config.get<string>('CHAT_MESSAGES_CLEANUP_ENABLED') === 'true',
      intervalMs: Number(
        this.config.get<string>('CHAT_MESSAGES_CLEANUP_INTERVAL_MS') ??
          86400000, // cada 24 h
      ),
      retentionDays: Number(
        this.config.get<string>('CHAT_MESSAGES_CLEANUP_RETENTION_DAYS') ?? 180,
      ),
      batchSize: Number(
        this.config.get<string>('CHAT_MESSAGES_CLEANUP_BATCH_SIZE') ?? 5000,
      ),
    };
  }

  async execute(): Promise<{ deleted: number; olderThan: Date }> {
    const { retentionDays, batchSize } = this.getSettings();
    const olderThan = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    let totalDeleted = 0;
    // Borrado por lotes; cap de seguridad para no quedar en bucle infinito.
    for (let i = 0; i < 5000; i++) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM "chat_messages"
        WHERE "id" IN (
          SELECT "id" FROM "chat_messages"
          WHERE "messageTimestamp" < ${olderThan}
          LIMIT ${batchSize}
        )
      `;
      const count = Number(deleted);
      totalDeleted += count;
      if (count < batchSize) break;
    }

    await this.logger.log(
      `Chat messages cleanup: eliminados ${totalDeleted} mensajes anteriores a ${olderThan.toISOString()}`,
      'ChatMessagesCleanupService',
    );

    return { deleted: totalDeleted, olderThan };
  }
}
