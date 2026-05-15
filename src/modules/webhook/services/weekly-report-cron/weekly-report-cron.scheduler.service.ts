import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { LoggerService } from 'src/core/logger/logger.service';
import { WeeklyReportCronService } from './weekly-report-cron.service';

@Injectable()
export class WeeklyReportCronSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly logger: LoggerService,
    private readonly weeklyReportCronService: WeeklyReportCronService,
  ) {}

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  async onModuleInit() {
    const settings = this.weeklyReportCronService.getSettings();

    if (!settings.enabled) {
      await this.logger.log(
        'Weekly report cron scheduler deshabilitado por configuracion.',
        'WeeklyReportCronSchedulerService',
      );
      return;
    }

    this.timer = setInterval(() => {
      void this.runTick();
    }, settings.intervalMs);

    const dayNames = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];
    await this.logger.log(
      `Weekly report cron scheduler iniciado. dia=${dayNames[settings.dayOfWeek]} hora=${String(settings.hour).padStart(2, '0')}:${String(settings.minute).padStart(2, '0')} tz=${settings.timeZone}`,
      'WeeklyReportCronSchedulerService',
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
        'Se omite una corrida del weekly report cron porque la anterior sigue en ejecucion.',
        'WeeklyReportCronSchedulerService',
      );
      return;
    }

    this.isRunning = true;

    try {
      const result = await this.weeklyReportCronService.execute({
        source: 'scheduler',
      });

      if (result.triggered && result.success) {
        await this.logger.log(
          `Weekly report cron procesado. slot=${result.slotKey} status=${result.statusCode ?? 200}`,
          'WeeklyReportCronSchedulerService',
        );
      } else if (!result.success && result.skippedReason !== 'MISSING_ENDPOINT') {
        await this.logger.error(
          'Error ejecutando weekly report cron scheduler.',
          result.error ?? result.message,
          'WeeklyReportCronSchedulerService',
        );
      } else if (result.skippedReason === 'MISSING_ENDPOINT') {
        await this.logger.warn(result.message, 'WeeklyReportCronSchedulerService');
      }
    } catch (error: unknown) {
      await this.logger.error(
        'Error ejecutando weekly report cron scheduler.',
        this.getErrorMessage(error),
        'WeeklyReportCronSchedulerService',
      );
    } finally {
      this.isRunning = false;
    }
  }
}
