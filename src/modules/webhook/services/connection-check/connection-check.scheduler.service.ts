import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { ConnectionCheckService } from './connection-check.service';

const TIME_ZONE = 'America/Bogota';
const CHECK_SLOTS_HOURS = [9, 13, 17];
const INTERVAL_MS = 60_000;

@Injectable()
export class ConnectionCheckSchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastRunSlotKey: string | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly connectionCheckService: ConnectionCheckService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.runTick(), INTERVAL_MS);
    this.logger.log(
      `Connection check scheduler iniciado. Slots=${CHECK_SLOTS_HOURS.map((h) => `${h}:00`).join(', ')} tz=${TIME_ZONE}`,
      'ConnectionCheckSchedulerService',
    );
  }

  onModuleDestroy() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private getSlotKey(now: Date): string | null {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);

    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
    const hour = parseInt(get('hour'), 10);
    const minute = parseInt(get('minute'), 10);
    const dateStr = `${get('year')}-${get('month')}-${get('day')}`;

    if (!CHECK_SLOTS_HOURS.includes(hour) || minute !== 0) return null;
    return `${dateStr}::${hour}`;
  }

  private async runTick() {
    const now = new Date();
    const slotKey = this.getSlotKey(now);
    if (!slotKey) return;
    if (slotKey === this.lastRunSlotKey) return;
    if (this.isRunning) {
      this.logger.warn(
        'Connection check omitido — ejecución anterior en progreso.',
        'ConnectionCheckSchedulerService',
      );
      return;
    }

    this.isRunning = true;
    this.lastRunSlotKey = slotKey;

    try {
      this.logger.log(
        `[ConnectionCheck] Iniciando revisión programada slot=${slotKey}`,
        'ConnectionCheckSchedulerService',
      );
      const result = await this.connectionCheckService.run(now);
      this.logger.log(
        `[ConnectionCheck] Completado slot=${slotKey} checked=${result.checked} disconnected=${result.disconnected} notified=${result.notified}`,
        'ConnectionCheckSchedulerService',
      );
    } catch (error: any) {
      this.logger.error(
        `[ConnectionCheck] Error en slot=${slotKey}`,
        error?.message ?? String(error),
        'ConnectionCheckSchedulerService',
      );
    } finally {
      this.isRunning = false;
    }
  }
}
