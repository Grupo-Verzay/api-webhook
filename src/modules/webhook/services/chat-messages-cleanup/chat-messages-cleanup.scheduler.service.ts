import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { LoggerService } from 'src/core/logger/logger.service';

import { ChatMessagesCleanupService } from './chat-messages-cleanup.service';

@Injectable()
export class ChatMessagesCleanupSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly logger: LoggerService,
    private readonly cleanup: ChatMessagesCleanupService,
  ) {}

  private getErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  async onModuleInit() {
    const settings = this.cleanup.getSettings();

    if (!settings.enabled) {
      await this.logger.log(
        'Chat messages cleanup scheduler deshabilitado (CHAT_MESSAGES_CLEANUP_ENABLED!=true).',
        'ChatMessagesCleanupSchedulerService',
      );
      return;
    }

    this.timer = setInterval(() => {
      void this.runTick();
    }, settings.intervalMs);

    await this.logger.log(
      `Chat messages cleanup scheduler iniciado. Intervalo=${settings.intervalMs}ms retención=${settings.retentionDays} días`,
      'ChatMessagesCleanupSchedulerService',
    );
  }

  onModuleDestroy() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async runTick() {
    if (this.isRunning) {
      await this.logger.warn(
        'Se omite una corrida del chat messages cleanup porque la anterior sigue en ejecución.',
        'ChatMessagesCleanupSchedulerService',
      );
      return;
    }

    this.isRunning = true;

    try {
      const result = await this.cleanup.execute();
      await this.logger.log(
        `Chat messages cleanup completado. Eliminados=${result.deleted} anteriores a ${result.olderThan.toISOString()}`,
        'ChatMessagesCleanupSchedulerService',
      );
    } catch (error: unknown) {
      await this.logger.error(
        'Error ejecutando chat messages cleanup scheduler.',
        this.getErrorMessage(error),
        'ChatMessagesCleanupSchedulerService',
      );
    } finally {
      this.isRunning = false;
    }
  }
}
