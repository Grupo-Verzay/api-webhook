// src/modules/webhook/services/antiflood/antiflood.service.ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';

interface MessageTracker {
  timestamps: number[];
  /** Timestamp (ms) hasta el cual el contacto está bloqueado por cooldown */
  blockedUntil?: number;
  /** Últimos N textos recibidos (para detección de contenido repetido) */
  recentContent: string[];
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

  // 🔧 Detección de contenido repetido: 3 mensajes idénticos en los últimos 5
  private readonly maxContentHistory = 5;
  private readonly maxIdenticalMessages = 3;

  // 🔧 Detección de repetición interna en un solo mensaje (≥60% palabras iguales, mín 5 palabras)
  private readonly internalRepetitionThreshold = 0.6;
  private readonly internalRepetitionMinWords = 5;

  // 🔧 Tolerancia a ráfagas humanas
  // Los LLMs tardan >3s en responder; una ráfaga humana tiene deltas <3s.
  // Si la mediana de deltas entre mensajes es menor a este valor, se trata
  // como escritura humana natural y se omiten los checks de flood.
  private readonly humanBurstMinDeltaMs = 3_000;
  // Ventana de tiempo para agrupar mensajes en una misma "ráfaga":
  // mensajes con menos de 3s de separación se colapsan a un solo evento.
  private readonly humanBurstWindowMs = 3_000;

  // 🔧 Lista blanca: estos números de teléfono omiten todos los checks de antiflood
  private readonly WHITELIST_PHONES = new Set<string>([
    '573233246305',
    '573233612620',
    '573115616975',
    '573216031493',
    '573186571866',
  ]);

  // 🔧 Palabras ofensivas (español + inglés básico)
  private readonly BAD_WORDS = new Set<string>([
    'hijueputa', 'hijueputas', 'hp', 'mierda', 'mierdas',
    'puta', 'puto', 'putas', 'putos', 'putamente',
    'coño', 'coños', 'pendejo', 'pendeja', 'pendejos', 'pendejas',
    'idiota', 'idiotas', 'imbecil', 'imbécil', 'imbeciles', 'imbéciles',
    'estupido', 'estúpido', 'estupida', 'estúpida', 'estupidos', 'estúpidos',
    'malparido', 'malparida', 'malparidos', 'malparidas',
    'gonorrea', 'gonorreas', 'verga', 'vergas',
    'marica', 'marico', 'maricas', 'maricos', 'maricon', 'maricón',
    'cabron', 'cabrón', 'cabrona', 'cabrona', 'cabrones',
    'bastardo', 'bastarda', 'bastardos', 'bastardas',
    'desgraciado', 'desgraciada', 'desgraciados', 'desgraciadas',
    'huevon', 'güevon', 'huevona', 'güevona', 'huevones',
    'culero', 'culera', 'culeros',
    'fuck', 'shit', 'bitch', 'asshole', 'cunt',
  ]);

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
        const entry = this.messageMap.get(key) ?? { timestamps: [], recentContent: [] };
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
    const entry = this.messageMap.get(key) ?? { timestamps: [], recentContent: [] };
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

    // Si la mediana de deltas es menor al mínimo de un bot, es una ráfaga humana.
    // Los LLMs tardan >3s en responder; el humano escribe varios mensajes cortos en <3s.
    if (ref < this.humanBurstMinDeltaMs) {
      this.logger.debug(
        `[SYNC_CHECK] Ráfaga humana detectada (mediana=${Math.round(ref)}ms < ${this.humanBurstMinDeltaMs}ms) → skip`,
        'AntifloodService',
      );
      return false;
    }

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
    // Colapsar ráfagas humanas: mensajes con <humanBurstWindowMs de separación
    // cuentan como un solo evento para evitar falsos positivos de escritura rápida.
    const recentRaw = entry.timestamps.filter((t) => now - t <= this.windowMs);
    const recent = this.collapseBursts(recentRaw);

    this.logger.debug(
      `[FREQ_CHECK] Msgs en ventana ${this.windowMs / 1000}s: ${recentRaw.length} brutos → ${recent.length} eventos / ${this.maxMsgInWindow} máx`,
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
    const recentRaw = entry.timestamps.filter(
      (t) => now - t <= this.mediumWindowMs,
    );
    const recent = this.collapseBursts(recentRaw);

    this.logger.debug(
      `[MEDIUM_CHECK] Msgs en ventana ${this.mediumWindowMs / 1000}s: ${recentRaw.length} brutos → ${recent.length} eventos / ${this.maxMsgInMediumWindow} máx`,
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
    const entry = this.messageMap.get(key) ?? { timestamps: [], recentContent: [] };
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

  // ─── Lista blanca ─────────────────────────────────────────────────────────

  /**
   * Devuelve true si el número de teléfono extraído del JID está en la lista blanca.
   * Los números en lista blanca omiten todos los checks de antiflood y contenido.
   */
  isWhitelisted(remoteJid: string): boolean {
    const phone = remoteJid.split('@')[0];
    const result = this.WHITELIST_PHONES.has(phone);
    if (result) {
      this.logger.debug(
        `[WHITELIST] ${remoteJid} → número en lista blanca, omitiendo checks.`,
        'AntifloodService',
      );
    }
    return result;
  }

  // ─── Detección de contenido ───────────────────────────────────────────────

  /**
   * Registra el texto del mensaje entrante para rastrear contenido repetido.
   * Debe llamarse junto con registerMessageTimestamp.
   */
  registerMessageContent(remoteJid: string, instanceName: string, text: string): void {
    const key = this.buildKey(remoteJid, instanceName);
    const entry = this.messageMap.get(key) ?? { timestamps: [], recentContent: [] };
    const normalized = text.trim().toLowerCase();
    entry.recentContent.push(normalized);
    if (entry.recentContent.length > this.maxContentHistory) {
      entry.recentContent.shift();
    }
    this.messageMap.set(key, entry);
    this.logger.debug(
      `[CONTENT] key="${key}" | contenido registrado (${entry.recentContent.length}/${this.maxContentHistory})`,
      'AntifloodService',
    );
  }

  /**
   * Detecta si el contacto está enviando el mismo mensaje repetidamente.
   * Umbral: maxIdenticalMessages coincidencias exactas en los últimos maxContentHistory mensajes.
   */
  isRepeatedContentSpam(text: string, remoteJid: string, instanceName: string): boolean {
    if (!text || text.length < 3) return false;
    const key = this.buildKey(remoteJid, instanceName);
    const entry = this.messageMap.get(key);
    if (!entry || entry.recentContent.length < this.maxIdenticalMessages) return false;

    const normalized = text.trim().toLowerCase();
    const identicalCount = entry.recentContent.filter((c) => c === normalized).length;

    this.logger.debug(
      `[CONTENT_REPEAT] key="${key}" | idénticos=${identicalCount}/${this.maxIdenticalMessages} requeridos`,
      'AntifloodService',
    );

    if (identicalCount >= this.maxIdenticalMessages) {
      this.logger.warn(
        `🚨 Contenido repetido detectado para ${remoteJid} (${identicalCount} mensajes idénticos en los últimos ${entry.recentContent.length})`,
        'AntifloodService',
      );
      return true;
    }
    return false;
  }

  /**
   * Detecta si un solo mensaje tiene repetición interna excesiva de palabras
   * (ej: "hola hola hola hola hola" → spam de palabra).
   */
  hasInternalRepetition(text: string): boolean {
    if (!text) return false;
    const words = text.trim().toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    if (words.length < this.internalRepetitionMinWords) return false;

    const freq = new Map<string, number>();
    for (const word of words) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
    const maxFreq = Math.max(...freq.values());
    const ratio = maxFreq / words.length;

    this.logger.debug(
      `[INTERNAL_REPEAT] palabras=${words.length} | maxFreq=${maxFreq} | ratio=${ratio.toFixed(2)} | umbral=${this.internalRepetitionThreshold}`,
      'AntifloodService',
    );

    if (ratio >= this.internalRepetitionThreshold) {
      this.logger.warn(
        `🚨 Repetición interna detectada (ratio=${ratio.toFixed(2)}, umbral=${this.internalRepetitionThreshold})`,
        'AntifloodService',
      );
      return true;
    }
    return false;
  }

  /**
   * Detecta si el mensaje contiene palabras ofensivas de la lista.
   */
  isBadWordMessage(text: string): boolean {
    if (!text) return false;
    const words = text.toLowerCase().split(/[\s,!?¿¡.;:()\-_]+/);
    const found = words.find((w) => w.length > 0 && this.BAD_WORDS.has(w));
    if (found) {
      this.logger.warn(
        `🚨 Palabra ofensiva detectada: "${found}"`,
        'AntifloodService',
      );
      return true;
    }
    return false;
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  /**
   * Colapsa una lista de timestamps ordenados agrupando los que llegan dentro
   * de humanBurstWindowMs entre sí. Devuelve un timestamp representativo por
   * cada "ráfaga", de modo que 4 mensajes enviados en 2s cuentan como 1 evento.
   */
  private collapseBursts(timestamps: number[]): number[] {
    if (timestamps.length === 0) return [];
    const collapsed: number[] = [timestamps[0]];
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] - timestamps[i - 1] > this.humanBurstWindowMs) {
        collapsed.push(timestamps[i]);
      }
    }
    return collapsed;
  }

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
