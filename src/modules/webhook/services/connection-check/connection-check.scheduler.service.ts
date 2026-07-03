import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { ConnectionCheckService } from './connection-check.service';

const TIME_ZONE = 'America/Bogota';
// Slots en formato HH:MM.
const CHECK_SLOTS = ['09:00', '13:00', '17:00'];
const INTERVAL_MS = 60_000;
// Ventana (min) para recuperar un slot perdido: un reinicio dentro de este lapso
// tras el slot lo ejecuta; más allá, espera al siguiente. 120 < 240 (separación
// entre slots), así que nunca se solapa con el siguiente.
const SLOT_TOLERANCE_MIN = 120;

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
    // Chequeo de recuperación inmediato al arrancar: si el contenedor se reinició
    // después de un slot (ej. por un deploy), lo ejecuta en vez de esperar al
    // siguiente. Sin esto, un redeploy cerca de las 13:00/17:00 se comía ese aviso.
    void this.runTick();
  }

  onModuleDestroy() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Devuelve el slot VENCIDO más reciente de HOY (el último cuya hora ya pasó),
   * no solo si estamos en el minuto exacto. Así, combinado con la deduplicación
   * por `lastRunSlotKey`, un slot corre aunque el minuto exacto se pierda (por un
   * reinicio o un tick tardío): tolerancia + recuperación. Devuelve null antes del
   * primer slot del día.
   */
  private getDueSlotKey(now: Date): string | null {
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
    const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
    const nowMin = Number(get('hour')) * 60 + Number(get('minute'));

    // El slot vencido más reciente cuya hora esté DENTRO de la ventana de tolerancia
    // (para recuperar un slot perdido por reinicio, sin re-disparar uno muy viejo:
    // ej. un deploy a las 20:00 no debe reenviar el aviso de las 17:00).
    let due: string | null = null;
    for (const slot of CHECK_SLOTS) {
      const [h, m] = slot.split(':').map(Number);
      const slotMin = h * 60 + m;
      if (slotMin <= nowMin && nowMin - slotMin <= SLOT_TOLERANCE_MIN) due = slot;
    }
    if (!due) return null;
    return `${dateStr}::${due}`;
  }

  private async runTick() {
    const now = new Date();
    const slotKey = this.getDueSlotKey(now);
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
