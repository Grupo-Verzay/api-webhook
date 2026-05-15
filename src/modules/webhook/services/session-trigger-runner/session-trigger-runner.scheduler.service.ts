import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LoggerService } from 'src/core/logger/logger.service';
import { SessionTriggerRunnerService } from './session-trigger-runner.service';

@Injectable()
export class SessionTriggerRunnerSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly sessionTriggerRunnerService: SessionTriggerRunnerService,
  ) {}

  private parseBoolean(value: string | undefined, fallback = false): boolean {
    if (!value) return fallback;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
  }

  private parsePositiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt((value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private getSettings() {
    return {
      enabled: this.parseBoolean(
        this.configService.get<string>('SESSION_TRIGGER_RUNNER_ENABLED'),
        true,
      ),
      intervalMs: this.parsePositiveInt(
        this.configService.get<string>('SESSION_TRIGGER_RUNNER_INTERVAL_MS'),
        60_000,
      ),
    };
  }

  async onModuleInit() {
    const { enabled, intervalMs } = this.getSettings();

    if (!enabled) {
      this.logger.log(
        'Session trigger runner scheduler deshabilitado por configuracion.',
        'SessionTriggerRunnerSchedulerService',
      );
      return;
    }

    this.timer = setInterval(() => {
      void this.runTick();
    }, intervalMs);

    this.logger.log(
      `Session trigger runner scheduler iniciado. Intervalo: ${intervalMs}ms.`,
      'SessionTriggerRunnerSchedulerService',
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
        'Se omite una corrida del session trigger runner porque la anterior sigue en ejecucion.',
        'SessionTriggerRunnerSchedulerService',
      );
      return;
    }

    this.isRunning = true;

    try {
      const summary = await this.sessionTriggerRunnerService.processDueTriggers();

      if (summary.processed > 0 || summary.failed > 0) {
        this.logger.log(
          `Session trigger runner procesado. processed=${summary.processed} failed=${summary.failed}`,
          'SessionTriggerRunnerSchedulerService',
        );
      }
    } catch (error: any) {
      this.logger.error(
        'Error ejecutando session trigger runner scheduler.',
        error?.message || error,
        'SessionTriggerRunnerSchedulerService',
      );
    } finally {
      this.isRunning = false;
    }
  }
}
