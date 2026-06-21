import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { LoggerService } from 'src/core/logger/logger.service';

import { TrialFollowUpCronService } from './trial-followup-cron.service';

@Injectable()
export class TrialFollowUpCronSchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly logger: LoggerService,
    private readonly trialFollowUpCronService: TrialFollowUpCronService,
  ) {}

  private getErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  async onModuleInit() {
    const settings = this.trialFollowUpCronService.getSettings();

    if (!settings.enabled) {
      await this.logger.log(
        'Trial follow-up cron scheduler deshabilitado por configuracion.',
        'TrialFollowUpCronSchedulerService',
      );
      return;
    }

    this.timer = setInterval(() => {
      void this.runTick();
    }, settings.intervalMs);

    await this.logger.log(
      `Trial follow-up cron scheduler iniciado. Intervalo=${settings.intervalMs}ms hora=${String(settings.hour).padStart(2, '0')}:${String(settings.minute).padStart(2, '0')} tz=${settings.timeZone}`,
      'TrialFollowUpCronSchedulerService',
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
        'Se omite una corrida del trial follow-up cron porque la anterior sigue en ejecucion.',
        'TrialFollowUpCronSchedulerService',
      );
      return;
    }

    this.isRunning = true;

    try {
      const result = await this.trialFollowUpCronService.execute({ source: 'scheduler' });

      if (result.triggered && result.success) {
        await this.logger.log(
          `Trial follow-up cron procesado. slot=${result.slotKey} status=${result.statusCode ?? 200}`,
          'TrialFollowUpCronSchedulerService',
        );
      } else if (!result.success && result.skippedReason !== 'MISSING_ENDPOINT') {
        await this.logger.error(
          'Error ejecutando trial follow-up cron scheduler.',
          result.error ?? result.message,
          'TrialFollowUpCronSchedulerService',
        );
      } else if (result.skippedReason === 'MISSING_ENDPOINT') {
        await this.logger.warn(result.message, 'TrialFollowUpCronSchedulerService');
      }
    } catch (error: unknown) {
      await this.logger.error(
        'Error ejecutando trial follow-up cron scheduler.',
        this.getErrorMessage(error),
        'TrialFollowUpCronSchedulerService',
      );
    } finally {
      this.isRunning = false;
    }
  }
}
