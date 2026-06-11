import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { CreditRenewalService } from './credit-renewal.service';

/** Checks for due credit renewals every hour. */
const INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class CreditRenewalSchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly logger: LoggerService,
    private readonly creditRenewalService: CreditRenewalService,
  ) {}

  async onModuleInit() {
    this.timer = setInterval(() => void this.runTick(), INTERVAL_MS);
    void this.runTick();
    this.logger.log('[CreditRenewalScheduler] Iniciado. Intervalo=1h');
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runTick() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.creditRenewalService.execute();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error('[CreditRenewalScheduler] Error en tick', msg);
    } finally {
      this.isRunning = false;
    }
  }
}
