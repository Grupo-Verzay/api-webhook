import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { ConnectionCheckService } from './connection-check.service';

const TIME_ZONE = 'America/Bogota';
// Slots en formato HH:MM. NOTA: 17:45 es TEMPORAL para probar el fix; volver a 17:00 luego.
const CHECK_SLOTS = ['09:00', '13:00', '17:45'];
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
      `Connection check scheduler iniciado. Slots=${CHECK_SLOTS.join(', ')} tz=${TIME_ZONE}`,
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
    const hm = `${get('hour').padStart(2, '0')}:${get('minute').padStart(2, '0')}`;
    const dateStr = `${get('year')}-${get('month')}-${get('day')}`;

    if (!CHECK_SLOTS.includes(hm)) return null;
    return `${dateStr}::${hm}`;
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
