import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';

const CHAT_HISTORY_KEEP_PER_SESSION = 60;

type LogCleanupSettings = {
  enabled: boolean;
  intervalMs: number;
  retentionDays: number;
};

@Injectable()
export class LogCleanupService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
  ) {}

  getSettings(): LogCleanupSettings {
    return {
      enabled: this.config.get<string>('LOG_CLEANUP_ENABLED') !== 'false',
      intervalMs: Number(
        this.config.get<string>('LOG_CLEANUP_INTERVAL_MS') ?? 86400000,
      ),
      retentionDays: Number(
        this.config.get<string>('LOG_CLEANUP_RETENTION_DAYS') ?? 30,
      ),
    };
  }

  async execute(): Promise<{ deleted: number; olderThan: Date; chatHistoryDeleted: number }> {
    const { retentionDays } = this.getSettings();
    const olderThan = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    );

    const result = await this.prisma.log.deleteMany({
      where: { timestamp: { lt: olderThan } },
    });

    await this.logger.log(
      `Log cleanup: eliminados ${result.count} registros anteriores a ${olderThan.toISOString()}`,
      'LogCleanupService',
    );

    // Mantener solo los últimos CHAT_HISTORY_KEEP_PER_SESSION mensajes por sesión
    const chatHistoryDeleted = await this.cleanChatHistory();

    return { deleted: result.count, olderThan, chatHistoryDeleted };
  }

  private async cleanChatHistory(): Promise<number> {
    try {
      const result = await this.prisma.$executeRaw`
        DELETE FROM n8n_chat_histories
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) AS rn
            FROM n8n_chat_histories
          ) ranked
          WHERE rn <= ${CHAT_HISTORY_KEEP_PER_SESSION}
        )
      `;
      await this.logger.log(
        `Chat history cleanup: eliminados ${result} mensajes (conservando últimos ${CHAT_HISTORY_KEEP_PER_SESSION} por sesión)`,
        'LogCleanupService',
      );
      return result;
    } catch (error: any) {
      this.logger.error('Error en chat history cleanup', error?.message, 'LogCleanupService');
      return 0;
    }
  }
}
