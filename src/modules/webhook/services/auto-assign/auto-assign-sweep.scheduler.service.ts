import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LoggerService } from 'src/core/logger/logger.service';
import { AutoAssignService } from './auto-assign.service';

/**
 * Red de seguridad de auto-asignación: cada N ms barre las sesiones activas que
 * quedaron sin asesor (porque el tryAssign en tiempo real se perdió por un
 * reinicio del backend o un fallo transitorio) y las asigna. Así ningún lead
 * queda huérfano indefinidamente.
 */
@Injectable()
export class AutoAssignSweepSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly autoAssignService: AutoAssignService,
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
        this.configService.get<string>('AUTO_ASSIGN_SWEEP_ENABLED'),
        true,
      ),
      intervalMs: this.parsePositiveInt(
        this.configService.get<string>('AUTO_ASSIGN_SWEEP_INTERVAL_MS'),
        120_000,
      ),
    };
  }

  onModuleInit() {
    const { enabled, intervalMs } = this.getSettings();

    if (!enabled) {
      this.logger.log(
        'Auto-assign sweep scheduler deshabilitado por configuracion.',
        'AutoAssignSweepSchedulerService',
      );
      return;
    }

    this.timer = setInterval(() => {
      void this.runTick();
    }, intervalMs);

    this.logger.log(
      `Auto-assign sweep scheduler iniciado. Intervalo: ${intervalMs}ms.`,
      'AutoAssignSweepSchedulerService',
    );
  }

  onModuleDestroy() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async runTick() {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    try {
      const summary = await this.autoAssignService.sweepUnassigned();
      if (summary.assigned > 0) {
        this.logger.log(
          `Auto-assign sweep: ${summary.assigned}/${summary.scanned} sesiones sin asignar fueron asignadas.`,
          'AutoAssignSweepSchedulerService',
        );
      }
    } catch (error: any) {
      this.logger.error(
        'Error ejecutando auto-assign sweep scheduler.',
        error?.message || error,
        'AutoAssignSweepSchedulerService',
      );
    } finally {
      this.isRunning = false;
    }
  }
}
