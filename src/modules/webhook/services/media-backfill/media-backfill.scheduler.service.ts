import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { LoggerService } from 'src/core/logger/logger.service';

import { MediaBackfillService } from './media-backfill.service';

@Injectable()
export class MediaBackfillSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly logger: LoggerService,
    private readonly backfill: MediaBackfillService,
  ) {}

  private getErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  async onModuleInit() {
    const settings = this.backfill.getSettings();

    if (!settings.enabled) {
      await this.logger.log(
        'Media backfill scheduler deshabilitado (MEDIA_BACKFILL_ENABLED!=true).',
        'MediaBackfillSchedulerService',
      );
      return;
    }

    this.timer = setInterval(() => {
      void this.runTick();
    }, settings.intervalMs);

    await this.logger.log(
      `Media backfill scheduler iniciado. Intervalo=${settings.intervalMs}ms ventana=${settings.windowHours}h maxIntentos=${settings.maxAttempts} lote=${settings.batchSize}`,
      'MediaBackfillSchedulerService',
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
        'Se omite una corrida del media backfill porque la anterior sigue en ejecución.',
        'MediaBackfillSchedulerService',
      );
      return;
    }

    this.isRunning = true;

    try {
      const result = await this.backfill.execute();
      await this.logger.log(
        `Media backfill completado. Revisados=${result.scanned} rellenados=${result.filled} descartados=${result.discarded}`,
        'MediaBackfillSchedulerService',
      );
    } catch (error: unknown) {
      await this.logger.error(
        'Error ejecutando media backfill scheduler.',
        this.getErrorMessage(error),
        'MediaBackfillSchedulerService',
      );
    } finally {
      this.isRunning = false;
    }
  }
}
