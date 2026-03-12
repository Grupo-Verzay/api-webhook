import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LoggerService } from 'src/core/logger/logger.service';
import { CrmFollowUpRunnerService } from './crm-follow-up-runner.service';

@Injectable()
export class CrmFollowUpRunnerSchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly runner: CrmFollowUpRunnerService,
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
      this.configService.get<string>('crmFollowUpRunner.enabled')
        ?? this.configService.get<string>('CRM_FOLLOW_UP_RUNNER_ENABLED'),
      false,
    );
    const intervalMs = this.parsePositiveInt(
      this.configService.get<string>('crmFollowUpRunner.intervalMs')
        ?? this.configService.get<string>('CRM_FOLLOW_UP_RUNNER_INTERVAL_MS'),
      60_000,
    );
    const limit = this.parsePositiveInt(
      this.configService.get<string>('crmFollowUpRunner.limit')
        ?? this.configService.get<string>('CRM_FOLLOW_UP_RUNNER_LIMIT'),
      25,
    );

    return {
      enabled,
      intervalMs,
      limit: Math.min(limit, 100),
    };
  }

  async onModuleInit() {
    const { enabled, intervalMs } = this.getSettings();
    if (!enabled) {
      this.logger.log(
        'CRM follow-up runner scheduler deshabilitado por configuracion.',
        'CrmFollowUpRunnerSchedulerService',
      );
      return;
    }

    this.timer = setInterval(() => {
      void this.runTick();
    }, intervalMs);

    this.logger.log(
      `CRM follow-up runner scheduler iniciado. Intervalo: ${intervalMs}ms.`,
      'CrmFollowUpRunnerSchedulerService',
    );
  }

  onModuleDestroy() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async runTick() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const { limit } = this.getSettings();
      const summary = await this.runner.processDueFollowUps(limit);
      if (summary.sent > 0 || summary.failed > 0) {
        this.logger.log(
          `CRM follow-up runner ejecutado. due=${summary.due} sent=${summary.sent} failed=${summary.failed} skipped=${summary.skipped}`,
          'CrmFollowUpRunnerSchedulerService',
        );
      }
    } catch (error: any) {
      this.logger.error(
        'Error ejecutando CRM follow-up runner scheduler.',
        error?.message || error,
        'CrmFollowUpRunnerSchedulerService',
      );
    } finally {
      this.isRunning = false;
    }
  }
}
