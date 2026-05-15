import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { LoggerService } from 'src/core/logger/logger.service';

import { LogCleanupService } from './log-cleanup.service';

@Injectable()
export class LogCleanupSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly logger: LoggerService,
    private readonly logCleanupService: LogCleanupService,
  ) {}

  private getErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  async onModuleInit() {
    const settings = this.logCleanupService.getSettings();

    if (!settings.enabled) {
      await this.logger.log(
        'Log cleanup scheduler deshabilitado por configuracion.',
        'LogCleanupSchedulerService',
      );
      return;
    }

    this.timer = setInterval(() => {
      void this.runTick();
    }, settings.intervalMs);

    await this.logger.log(
      `Log cleanup scheduler iniciado. Intervalo=${settings.intervalMs}ms retención=${settings.retentionDays} días`,
      'LogCleanupSchedulerService',
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
        'Se omite una corrida del log cleanup porque la anterior sigue en ejecucion.',
        'LogCleanupSchedulerService',
      );
      return;
    }

    this.isRunning = true;

    try {
      const result = await this.logCleanupService.execute();
      await this.logger.log(
        `Log cleanup completado. Eliminados=${result.deleted} anteriores a ${result.olderThan.toISOString()}`,
        'LogCleanupSchedulerService',
      );
    } catch (error: unknown) {
      await this.logger.error(
        'Error ejecutando log cleanup scheduler.',
        this.getErrorMessage(error),
        'LogCleanupSchedulerService',
      );
    } finally {
      this.isRunning = false;
    }
  }
}
