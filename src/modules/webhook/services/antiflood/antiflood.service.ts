// src/modules/webhook/services/antiflood/antiflood.service.ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';

interface MessageTracker {
  timestamps: number[];
  /** Timestamp (ms) hasta el cual el contacto está bloqueado por cooldown */
  blockedUntil?: number;
}

@Injectable()
export class AntifloodService implements OnModuleInit, OnModuleDestroy {
  private readonly messageMap = new Map<string, MessageTracker>();

  // 🔧 Patrón sincronizado
  private readonly maxHistory = 20;
  private readonly toleranceMs = 2000;
  private readonly minRequired = 3;
  private readonly minSimilarCount = 4;

  // 🔧 Ventana de alta frecuencia (AI-to-AI): 6 msgs en 60s
  private readonly windowMs = 60_000;
  private readonly maxMsgInWindow = 6;

  // 🔧 Ventana de media frecuencia: 5 msgs en 2 min (loops lentos AI-to-AI)
  private readonly mediumWindowMs = 120_000;
  private readonly maxMsgInMediumWindow = 5;

  // 🔧 Cooldown tras detección: 30 min para dar tiempo a intervención manual
  private readonly cooldownMs = 30 * 60_000;

  // 🔧 Cleanup de entradas inactivas
  private readonly staleThresholdMs = 5 * 60_000;
  private readonly cleanupIntervalMs = 10 * 60_000;

  private cleanupTimer!: NodeJS.Timeout;

  /**
   * Acceso tipado al modelo AntifloodBlock.
   * El cast se puede eliminar después de correr: npx prisma migrate dev
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get antifloodBlock(): any {
    return (this.prisma as any).antifloodBlock;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
  ) {}

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    this.logger.debug(
      `[INIT] Cargando bloqueos activos desde BD...`,
      'AntifloodService',
    );

    try {
      const now = new Date();
      const active = await this.antifloodBlock.findMany({
        where: { blockedUntil: { gt: now } },
      });

      this.logger.debug(
        `[INIT] Registros encontrados en BD: ${active.length}`,
        'AntifloodService',
      );

      for (const block of active) {
        const key = this.buildKey(block.remoteJid, block.instanceName);
        const entry = this.messageMap.get(key) ?? { timestamps: [] };
        entry.blockedUntil = block.blockedUntil.getTime();
        this.messageMap.set(key, entry);

        const remainingMs = block.blockedUntil.getTime() - Date.now();
        this.logger.debug(
          `[INIT] Bloqueo restaurado → key="${key}" | blockedUntil=${block.blockedUntil.toISOString()} | restante=${Math.round(remainingMs / 1000)}s`,
          'AntifloodService',
        );
      }

      if (active.length > 0) {
        this.logger.log(
          `[INIT] ${active.length} bloqueo(s) activo(s) restaurado(s) desde BD.`,
          'AntifloodService',
        );
      } else {
        this.logger.debug(
          `[INIT] Sin bloqueos activos en BD. Iniciando sin restricciones.`,
          'AntifloodService',
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `[INIT] No se pudo cargar bloqueos desde BD (¿migración pendiente?). El servicio arranca sin bloqueos persistidos. Error: ${err?.message}`,
        'AntifloodService',
      );
    }

    this.cleanupTimer = setInterval(
      () => this.cleanupStaleEntries(),
      this.cleanupIntervalMs,
    );

    this.logger.debug(
      `[INIT] Cleanup timer iniciado cada ${this.cleanupIntervalMs / 60_000} min.`,
      'AntifloodService',
    );
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
    this.logger.debug(`[DESTROY] Cleanup timer detenido.`, 'AntifloodService');
  }

  // ─── Clave compuesta ─────────────────────────────────────────────────────

  private buildKey(remoteJid: string, instanceName: string): string {
    return `${instanceName}:${remoteJid}`;
  }

  // ─── API pública ─────────────────────────────────────────────────────────

  registerMessageTimestamp(remoteJid: string, instanceName: string): void {
    const key = this.buildKey(remoteJid, instanceName);
    const now = Date.now();
    const entry = this.messageMap.get(key) ?? { timestamps: [] };
    entry.timestamps.push(now);

    if (entry.timestamps.length > this.maxHistory) {
      entry.timestamps.shift();
    }

    this.messageMap.set(key, entry);

    this.logger.debug(
      `[TIMESTAMP] key="${key}" | total timestamps: ${entry.timestamps.length}/${this.maxHistory} | cooldown activo: ${this.isInCooldown(entry)}`,
      'AntifloodService',
    );
  }

  isSynchronizedPattern(remoteJid: string, instanceName: string): boolean {
    const key = this.buildKey(remoteJid, instanceName);
    const entry = this.messageMap.get(key);

    this.logger.debug(
      `[SYNC_CHECK] key="${key}" | entry existe: ${!!entry}`,
      'AntifloodService',
    );

    if (!entry) return false;

    if (this.isInCooldown(entry)) {
      const remaining = Math.round(
        ((entry.blockedUntil ?? 0) - Date.now()) / 1000,
      );
      this.logger.debug(
        `[SYNC_CHECK] Cooldown activo → bloqueado. Restante: ${remaining}s`,
        'AntifloodService',
      );
      return true;
    }

    if (entry.timestamps.length < this.minRequired) {
      this.logger.debug(
        `[SYNC_CHECK] Timestamps insuficientes: ${entry.timestamps.length}/${this.minRequired} requeridos → skip`,
        'AntifloodService',
      );
      return false;
    }

    const deltas = entry.timestamps
      .map((t, i, arr) => (i === 0 ? 0 : t - arr[i - 1]))
      .filter((d) => d > 0);

    if (deltas.length < this.minRequired - 1) {
      this.logger.debug(
        `[SYNC_CHECK] Deltas insuficientes: ${deltas.length}/${this.minRequired - 1} → skip`,
        'AntifloodService',
      );
      return false;
    }

    const ref = this.median(deltas);
    const similares = deltas.filter(
      (d) => Math.abs(d - ref) <= this.toleranceMs,
    );

    this.logger.debug(
      `[SYNC_CHECK] deltas=${deltas.length} | mediana=${Math.round(ref)}ms | similares=${similares.length}/${this.minSimilarCount} requeridos | tolerancia=±${this.toleranceMs}ms`,
      'AntifloodService',
    );

    if (similares.length >= this.minSimilarCount) {
      this.logger.warn(
        `🚨 Patrón sincronizado detectado para ${remoteJid} (${similares.length}/${deltas.length} deltas ≈ ${Math.round(ref)}ms)`,
        'AntifloodService',
      );
      return true;
    }

    this.logger.debug(
      `[SYNC_CHECK] Sin patrón detectado → resultado: false`,
      'AntifloodService',
    );
    return false;
  }

  isHighFrequencyContact(remoteJid: string, instanceName: string): boolean {
    const key = this.buildKey(remoteJid, instanceName);
    const entry = this.messageMap.get(key);

    this.logger.debug(
      `[FREQ_CHECK] key="${key}" | entry existe: ${!!entry}`,
      'AntifloodService',
    );

    if (!entry) return false;

    if (this.isInCooldown(entry)) {
      const remaining = Math.round(
        ((entry.blockedUntil ?? 0) - Date.now()) / 1000,
      );
      this.logger.debug(
        `[FREQ_CHECK] Cooldown activo → bloqueado. Restante: ${remaining}s`,
        'AntifloodService',
      );
      return true;
    }

    const now = Date.now();
    const recent = entry.timestamps.filter((t) => now - t <= this.windowMs);

    this.logger.debug(
      `[FREQ_CHECK] Msgs en ventana ${this.windowMs / 1000}s: ${recent.length}/${this.maxMsgInWindow} máx`,
      'AntifloodService',
    );

    if (recent.length >= this.maxMsgInWindow) {
      this.logger.warn(
        `🚨 Alta frecuencia AI-to-AI detectada para ${remoteJid} (${recent.length} msgs en ${this.windowMs / 1000}s)`,
        'AntifloodService',
      );
      return true;
    }

    this.logger.debug(
      `[FREQ_CHECK] Frecuencia normal → resultado: false`,
      'AntifloodService',
    );
    return false;
  }

  isMediumFrequencyBurst(remoteJid: string, instanceName: string): boolean {
    const key = this.buildKey(remoteJid, instanceName);
    const entry = this.messageMap.get(key);

    if (!entry) return false;

    if (this.isInCooldown(entry)) {
      const remaining = Math.round(
        ((entry.blockedUntil ?? 0) - Date.now()) / 1000,
      );
      this.logger.debug(
        `[MEDIUM_CHECK] Cooldown activo → bloqueado. Restante: ${remaining}s`,
        'AntifloodService',
      );
      return true;
    }

    const now = Date.now();
    const recent = entry.timestamps.filter(
      (t) => now - t <= this.mediumWindowMs,
    );

    this.logger.debug(
      `[MEDIUM_CHECK] Msgs en ventana ${this.mediumWindowMs / 1000}s: ${recent.length}/${this.maxMsgInMediumWindow} máx`,
      'AntifloodService',
    );

    if (recent.length >= this.maxMsgInMediumWindow) {
      this.logger.warn(
        `🚨 Burst de media frecuencia detectado para ${remoteJid} (${recent.length} msgs en ${this.mediumWindowMs / 1000}s) → posible loop AI-to-AI lento`,
        'AntifloodService',
      );
      return true;
    }

    return false;
  }

  markBlocked(remoteJid: string, instanceName: string): void {
    const key = this.buildKey(remoteJid, instanceName);
    const entry = this.messageMap.get(key) ?? { timestamps: [] };
    const blockedUntilMs = Date.now() + this.cooldownMs;
    entry.blockedUntil = blockedUntilMs;
    this.messageMap.set(key, entry);

    this.logger.debug(
      `[MARK_BLOCKED] key="${key}" | blockedUntil=${new Date(blockedUntilMs).toISOString()} | cooldown=${this.cooldownMs / 60_000} min`,
      'AntifloodService',
    );

    this.logger.log(
      `[MARK_BLOCKED] ${remoteJid} bloqueado por ${this.cooldownMs / 60_000} min (instancia: ${instanceName}).`,
      'AntifloodService',
    );

    this.logger.debug(
      `[MARK_BLOCKED] Persistiendo bloqueo en BD (fire-and-forget)...`,
      'AntifloodService',
    );

    Promise.resolve()
      .then(() =>
        this.antifloodBlock.upsert({
          where: { remoteJid_instanceName: { remoteJid, instanceName } },
          create: {
            remoteJid,
            instanceName,
            blockedUntil: new Date(blockedUntilMs),
          },
          update: { blockedUntil: new Date(blockedUntilMs) },
        }),
      )
      .then(() =>
        this.logger.debug(
          `[MARK_BLOCKED] Bloqueo persistido en BD correctamente para key="${key}".`,
          'AntifloodService',
        ),
      )
      .catch((err: any) =>
        this.logger.error(
          `[MARK_BLOCKED] Error persistiendo bloqueo en BD para ${remoteJid}. ${err?.message}`,
          'AntifloodService',
        ),
      );
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  private isInCooldown(entry: MessageTracker): boolean {
    return !!entry.blockedUntil && Date.now() < entry.blockedUntil;
  }

  private median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  private cleanupStaleEntries(): void {
    const now = Date.now();
    let removed = 0;

    this.logger.debug(
      `[CLEANUP] Iniciando limpieza. Entradas en memoria: ${this.messageMap.size}`,
      'AntifloodService',
    );

    for (const [key, entry] of this.messageMap.entries()) {
      const lastTs = entry.timestamps[entry.timestamps.length - 1] ?? 0;
      const ageMs = now - lastTs;
      const inCooldown = this.isInCooldown(entry);

      this.logger.debug(
        `[CLEANUP] key="${key}" | últimoMsg hace ${Math.round(ageMs / 1000)}s | cooldown: ${inCooldown} | ¿eliminar?: ${!inCooldown && ageMs > this.staleThresholdMs}`,
        'AntifloodService',
      );

      if (!inCooldown && ageMs > this.staleThresholdMs) {
        this.messageMap.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.log(
        `[CLEANUP] ${removed} entrada(s) eliminada(s). Activas restantes: ${this.messageMap.size}`,
        'AntifloodService',
      );
    } else {
      this.logger.debug(
        `[CLEANUP] Sin entradas para eliminar. Activas: ${this.messageMap.size}`,
        'AntifloodService',
      );
    }

    this.logger.debug(
      `[CLEANUP] Limpiando registros expirados en BD (fire-and-forget)...`,
      'AntifloodService',
    );

    Promise.resolve()
      .then(() =>
        this.antifloodBlock.deleteMany({
          where: { blockedUntil: { lte: new Date() } },
        }),
      )
      .then((result: { count: number }) =>
        this.logger.debug(
          `[CLEANUP] BD: ${result.count} registro(s) expirado(s) eliminado(s).`,
          'AntifloodService',
        ),
      )
      .catch((err: any) =>
        this.logger.debug(
          `[CLEANUP] BD no disponible aún (migración pendiente). ${err?.message}`,
          'AntifloodService',
        ),
      );
  }
}
