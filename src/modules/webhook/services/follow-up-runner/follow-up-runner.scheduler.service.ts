import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LoggerService } from 'src/core/logger/logger.service';
import { FollowUpRunnerService } from './follow-up-runner.service';

@Injectable()
export class FollowUpRunnerSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly followUpRunnerService: FollowUpRunnerService,
  ) {}

  private parseBoolean(value: string | undefined, fallback = false) {
    if (!value) return fallback;

    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
  }

  private parsePositiveInt(value: string | undefined, fallback: number) {
    const parsed = Number.parseInt((value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private getSettings() {
    const enabled = this.parseBoolean(
      this.configService.get<string>('followUpRunner.enabled') ??
        this.configService.get<string>('FOLLOW_UP_RUNNER_ENABLED'),
      false,
    );
    const intervalMs = this.parsePositiveInt(
      this.configService.get<string>('followUpRunner.intervalMs') ??
        this.configService.get<string>('FOLLOW_UP_RUNNER_INTERVAL_MS'),
      60_000,
    );
    const limit = this.parsePositiveInt(
      this.configService.get<string>('followUpRunner.limit') ??
        this.configService.get<string>('FOLLOW_UP_RUNNER_LIMIT'),
      25,
    );

    return {
      enabled,
      intervalMs,
      limit: Math.min(limit, 500),
    };
  }

  async onModuleInit() {
    const { enabled, intervalMs } = this.getSettings();

    if (!enabled) {
      this.logger.log(
        'Follow-up runner scheduler deshabilitado por configuracion.',
        'FollowUpRunnerSchedulerService',
      );
      return;
    }

    // Recuperar seguimientos atascados en 'processing' (reinicio inesperado)
    try {
      await this.followUpRunnerService.recoverStuckProcessing();
    } catch (err: any) {
      this.logger.error(
        'Error en recoverStuckProcessing al iniciar.',
        err?.message || err,
        'FollowUpRunnerSchedulerService',
      );
    }

    this.timer = setInterval(() => {
      void this.runTick();
    }, intervalMs);

    this.logger.log(
      `Follow-up runner scheduler iniciado. Intervalo: ${intervalMs}ms.`,
      'FollowUpRunnerSchedulerService',
    );
  }

  onModuleDestroy() {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;
  }

  private async runTick() {
    if (this.isRunning) {
      this.logger.warn(
        'Se omite una corrida del follow-up runner porque la anterior sigue en ejecucion.',
        'FollowUpRunnerSchedulerService',
      );
      return;
    }

    this.isRunning = true;

    try {
      const { limit } = this.getSettings();
      const summary =
        await this.followUpRunnerService.processDueFollowUps(limit);

      if (summary.due > 0 || summary.failed > 0 || summary.sent > 0) {
        this.logger.log(
          `Runner scheduler procesado. due=${summary.due} sent=${summary.sent} failed=${summary.failed} skipped=${summary.skipped} (fuera_de_ventana=${summary.skippedOutOfWindow})`,
          'FollowUpRunnerSchedulerService',
        );
      }
    } catch (error: any) {
      this.logger.error(
        'Error ejecutando follow-up runner scheduler.',
        error?.message || error,
        'FollowUpRunnerSchedulerService',
      );
    } finally {
      this.isRunning = false;
    }
  }
}
