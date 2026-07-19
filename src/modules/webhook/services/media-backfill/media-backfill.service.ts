import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';

type MediaBackfillSettings = {
  enabled: boolean;
  intervalMs: number;
  windowHours: number;
  maxAttempts: number;
  batchSize: number;
};

type CandidateRow = {
  id: bigint;
  userId: string;
  instanceName: string;
  messageId: string;
};

type InstanceCreds = {
  serverUrl: string;
  apikey: string;
};

/**
 * Worker de backfill de `mediaUrl` para mensajes entrantes de Evolution.
 *
 * Algunos mensajes multimedia se persisten sin `mediaUrl` (la URL de S3 aún no
 * estaba lista cuando llegó el webhook). Este worker recorre periódicamente los
 * mensajes recientes sin `mediaUrl`, consulta Evolution (`/chat/findMessages`)
 * para recuperar la URL de la media (medias3.ia-app.com) y la rellena.
 *
 * OPT-IN: solo corre si MEDIA_BACKFILL_ENABLED=true. Cada candidato incrementa
 * su contador de intentos; tras MAX_ATTEMPTS se descarta para no reintentar
 * indefinidamente (media caducada, instancia inexistente, etc.).
 */
@Injectable()
export class MediaBackfillService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
  ) {}

  getSettings(): MediaBackfillSettings {
    return {
      enabled: this.config.get<string>('MEDIA_BACKFILL_ENABLED') === 'true',
      intervalMs: Number(
        this.config.get<string>('MEDIA_BACKFILL_INTERVAL_MS') ?? 300000, // 5 min
      ),
      windowHours: Number(
        this.config.get<string>('MEDIA_BACKFILL_WINDOW_HOURS') ?? 24,
      ),
      maxAttempts: Number(
        this.config.get<string>('MEDIA_BACKFILL_MAX_ATTEMPTS') ?? 5,
      ),
      batchSize: Number(
        this.config.get<string>('MEDIA_BACKFILL_BATCH_SIZE') ?? 50,
      ),
    };
  }

  /** Antepone https:// si el serverUrl no trae protocolo y limpia trailing slash. */
  private normalizeBase(url: string): string {
    const trimmed = url.trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  /** Resuelve serverUrl + apikey de la instancia (por userId). */
  private async resolveCreds(userId: string): Promise<InstanceCreds | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { apiKey: true },
    });
    const rawUrl = user?.apiKey?.url?.trim();
    const apikey = user?.apiKey?.key?.trim();
    if (!rawUrl || !apikey) return null;
    return { serverUrl: this.normalizeBase(rawUrl), apikey };
  }

  async execute(): Promise<{ scanned: number; filled: number; discarded: number }> {
    const { windowHours, maxAttempts, batchSize } = this.getSettings();
    // Cutoff calculado en JS (binding inequívoco de Date) en vez de make_interval con
    // parámetro numérico, que puede fallar por ambigüedad de tipo integer/double.
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const candidates = await this.prisma.$queryRaw<CandidateRow[]>`
      SELECT "id", "userId", "instanceName", "messageId"
      FROM "chat_messages"
      WHERE "fromMe" = false
        AND "instanceType" = 'evolution'
        AND "mediaUrl" IS NULL
        AND "messageType" IN ('imageMessage', 'audioMessage', 'videoMessage', 'documentMessage')
        AND "mediaBackfillAttempts" < ${maxAttempts}
        AND "createdAt" > ${cutoff}
      ORDER BY "createdAt" DESC
      LIMIT ${batchSize}
    `;

    let filled = 0;
    let discarded = 0;

    // Cache de credenciales por userId dentro de la corrida (evita repetir queries).
    const credsCache = new Map<string, InstanceCreds | null>();

    for (const candidate of candidates) {
      try {
        let creds = credsCache.get(candidate.userId);
        if (creds === undefined) {
          creds = await this.resolveCreds(candidate.userId);
          credsCache.set(candidate.userId, creds);
        }

        if (!creds) {
          // Sin credenciales no se puede resolver: solo incrementa el intento.
          await this.incrementAttempts(candidate.id);
          continue;
        }

        const url = await this.fetchMediaUrl(
          creds,
          candidate.instanceName,
          candidate.messageId,
        );

        if (url) {
          await this.prisma.$executeRaw`
            UPDATE "chat_messages"
            SET "mediaUrl" = COALESCE("mediaUrl", ${url}), "updatedAt" = NOW()
            WHERE "id" = ${candidate.id} AND "mediaUrl" IS NULL
          `;
          // Actualiza el preview de la lista solo si este mensaje es el último
          // de su conversación.
          await this.prisma.$executeRaw`
            UPDATE "chat_conversations"
            SET "lastMessageMediaUrl" = COALESCE("lastMessageMediaUrl", ${url}), "updatedAt" = NOW()
            WHERE "userId" = ${candidate.userId}
              AND "instanceName" = ${candidate.instanceName}
              AND "lastMessageId" = ${candidate.messageId}
          `;
          filled += 1;
        }

        // SIEMPRE se incrementa el contador de intentos.
        await this.incrementAttempts(candidate.id);
      } catch (error: unknown) {
        const status =
          axios.isAxiosError(error) && error.response
            ? error.response.status
            : undefined;
        if (status === 404) {
          // Instancia inexistente: descartar el candidato (no reintentar más).
          discarded += 1;
          try {
            await this.prisma.$executeRaw`
              UPDATE "chat_messages"
              SET "mediaBackfillAttempts" = ${maxAttempts}
              WHERE "id" = ${candidate.id}
            `;
          } catch (markError: unknown) {
            await this.logger.error(
              `Error descartando candidato id=${candidate.id} en media backfill.`,
              this.getErrorMessage(markError),
              'MediaBackfillService',
            );
          }
        } else {
          await this.logger.warn(
            `Fallo backfill de media para id=${candidate.id} messageId=${candidate.messageId}: ${this.getErrorMessage(error)}`,
            'MediaBackfillService',
          );
          // Otros errores: solo el incremento normal.
          try {
            await this.incrementAttempts(candidate.id);
          } catch {
            // best-effort: si falla el incremento se reintentará en la próxima corrida.
          }
        }
      }
    }

    return { scanned: candidates.length, filled, discarded };
  }

  /** Consulta Evolution findMessages y extrae la URL de S3 si es válida. */
  private async fetchMediaUrl(
    creds: InstanceCreds,
    instanceName: string,
    messageId: string,
  ): Promise<string | null> {
    const endpoint = `${creds.serverUrl}/chat/findMessages/${encodeURIComponent(instanceName)}`;
    const response = await axios.post(
      endpoint,
      { where: { key: { id: messageId } } },
      { headers: { apikey: creds.apikey }, timeout: 15000 },
    );

    const record = response.data?.messages?.records?.[0];
    const url: unknown = record?.mediaUrl ?? record?.message?.mediaUrl;
    if (typeof url === 'string' && /^https?:\/\//.test(url)) return url;
    return null;
  }

  private async incrementAttempts(id: bigint): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "chat_messages"
      SET "mediaBackfillAttempts" = "mediaBackfillAttempts" + 1
      WHERE "id" = ${id}
    `;
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
