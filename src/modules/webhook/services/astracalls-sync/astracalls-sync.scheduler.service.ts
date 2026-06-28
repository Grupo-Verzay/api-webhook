import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LoggerService } from 'src/core/logger/logger.service';

/**
 * Dispara periódicamente el endpoint del frontend que sincroniza el historial de
 * llamadas de AstraCalls hacia los Chats (registra las llamadas entrantes
 * perdidas como burbuja). Reutiliza NEXTAUTH_URL + CRON_SECRET (ya configurados
 * para los demás crons), así que no requiere variables nuevas.
 */
@Injectable()
export class AstraCallsSyncSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly logger: LoggerService,
    private readonly configService: ConfigService,
  ) {}

  private getBaseUrl(): string {
    // Reutiliza la misma base que el cron de billing (ya apunta a producción).
    // NEXTAUTH_URL suele ser localhost, así que va al final como fallback.
    const raw =
      this.configService.get<string>('ASTRACALLS_SYNC_ENDPOINT_URL') ||
      this.configService.get<string>('BILLING_CRON_ENDPOINT_URL') ||
      this.configService.get<string>('NEXTAUTH_URL') ||
      this.configService.get<string>('NEXTJS_URL') ||
      '';
    return raw.trim().replace(/\/+$/, '');
  }

  private getSecret(): string {
    return (
      this.configService.get<string>('CRON_SECRET') ??
      process.env.CRON_SECRET ??
      ''
    ).trim();
  }

  private getIntervalMs(): number {
    const raw = Number(
      this.configService.get<string>('ASTRACALLS_SYNC_INTERVAL_MS'),
    );
    return Number.isFinite(raw) && raw > 0 ? raw : 120000; // 2 min por defecto
  }

  async onModuleInit() {
    const base = this.getBaseUrl();
    const secret = this.getSecret();
    if (!base || !secret) {
      await this.logger.log(
        'AstraCalls sync scheduler deshabilitado (falta NEXTAUTH_URL o CRON_SECRET).',
        'AstraCallsSyncSchedulerService',
      );
      return;
    }
    const intervalMs = this.getIntervalMs();
    this.timer = setInterval(() => void this.runTick(), intervalMs);
    await this.logger.log(
      `AstraCalls sync scheduler iniciado. Intervalo=${intervalMs}ms endpoint=${base}/api/cron/astracalls-sync`,
      'AstraCallsSyncSchedulerService',
    );
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
      const url = `${this.getBaseUrl()}/api/cron/astracalls-sync`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'x-cron-secret': this.getSecret() },
        cache: 'no-store',
      });
      const body: { success?: boolean; logged?: number; sessions?: number } =
        await res.json().catch(() => ({}));
      if (res.ok && body?.success) {
        if ((body.logged ?? 0) > 0) {
          await this.logger.log(
            `AstraCalls sync: ${body.logged} llamada(s) entrante(s) registrada(s) (sessions=${body.sessions ?? 0}).`,
            'AstraCallsSyncSchedulerService',
          );
        }
      } else {
        await this.logger.warn(
          `AstraCalls sync status=${res.status} body=${JSON.stringify(body).slice(0, 200)}`,
          'AstraCallsSyncSchedulerService',
        );
      }
    } catch (e: unknown) {
      await this.logger.error(
        'Error en AstraCalls sync scheduler.',
        e instanceof Error ? e.message : String(e),
        'AstraCallsSyncSchedulerService',
      );
    } finally {
      this.isRunning = false;
    }
  }
}
