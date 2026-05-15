import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';

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

  async execute(): Promise<{ deleted: number; olderThan: Date }> {
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

    return { deleted: result.count, olderThan };
  }
}
