import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';

export interface PersistChatMessageInput {
  userId: string;
  instanceName: string;
  instanceType?: string | null;
  remoteJid: string;
  remoteJidAlt?: string | null;
  senderPn?: string | null;
  messageId?: string | null;
  fromMe: boolean;
  pushName?: string | null;
  messageType?: string | null;
  content?: string | null;
  mediaUrl?: string | null;
  raw?: Prisma.InputJsonValue | null;
  messageTimestamp?: Date | number | string | null;
}

/**
 * Persiste mensajes en las tablas unificadas `chat_messages` / `chat_conversations`,
 * las mismas que gestiona el frontend (lib/chat-persistence.ts) y que lee el panel
 * de Chats vía getPersistedInboxChats / getPersistedMessages.
 *
 * Se usa para canales que no pasan por Evolution (Telegram, Meta), de modo que
 * sus conversaciones aparezcan en la bandeja unificada igual que WhatsApp/Baileys.
 *
 * NOTA: el remoteJid se guarda tal cual llega (incluye sufijos @telegram,
 * @messenger, @instagram, @s.whatsapp.net) para que empate con Session.remoteJid.
 */
@Injectable()
export class ChatStoreService {
  private readonly logger = new Logger(ChatStoreService.name);
  private ensurePromise: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private ensureTables(): Promise<void> {
    this.ensurePromise ??= (async () => {
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS "chat_messages" (
          "id" BIGSERIAL PRIMARY KEY,
          "userId" TEXT NOT NULL,
          "instanceName" TEXT NOT NULL,
          "instanceType" TEXT,
          "remoteJid" TEXT NOT NULL,
          "remoteJidAlt" TEXT,
          "senderPn" TEXT,
          "messageId" TEXT NOT NULL,
          "fromMe" BOOLEAN NOT NULL DEFAULT FALSE,
          "pushName" TEXT,
          "messageType" TEXT NOT NULL DEFAULT 'conversation',
          "content" TEXT,
          "mediaUrl" TEXT,
          "raw" JSONB,
          "messageTimestamp" TIMESTAMP(3) NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `;
      await this.prisma.$executeRaw`
        CREATE UNIQUE INDEX IF NOT EXISTS "chat_messages_user_instance_jid_msg_from_unique"
        ON "chat_messages" ("userId", "instanceName", "remoteJid", "messageId", "fromMe")
      `;
      // Marca de "eliminado por el cliente" (revoke). El mensaje se conserva con su
      // contenido; esta bandera solo permite al panel mostrar el badge "Eliminado".
      await this.prisma.$executeRaw`
        ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "deleted" BOOLEAN NOT NULL DEFAULT FALSE
      `;
      // Contador de intentos del worker de backfill de mediaUrl. Evita reintentar
      // indefinidamente medias que Evolution no logra resolver (media caducada,
      // instancia inexistente, etc.). Ver MediaBackfillService.
      await this.prisma.$executeRaw`
        ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "mediaBackfillAttempts" INTEGER NOT NULL DEFAULT 0
      `;
      // Índice parcial para el sweep del backfill: solo indexa las filas que aún no
      // tienen mediaUrl, que son las candidatas a backfill.
      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS "chat_messages_media_backfill_idx"
        ON "chat_messages" ("createdAt") WHERE "mediaUrl" IS NULL
      `;
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS "chat_conversations" (
          "id" BIGSERIAL PRIMARY KEY,
          "userId" TEXT NOT NULL,
          "instanceName" TEXT NOT NULL,
          "instanceType" TEXT,
          "remoteJid" TEXT NOT NULL,
          "remoteJidAlt" TEXT,
          "senderPn" TEXT,
          "pushName" TEXT,
          "lastMessageId" TEXT,
          "lastMessageFromMe" BOOLEAN,
          "lastMessageType" TEXT,
          "lastMessageContent" TEXT,
          "lastMessageMediaUrl" TEXT,
          "lastMessageRaw" JSONB,
          "lastMessageTimestamp" TIMESTAMP(3),
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `;
      await this.prisma.$executeRaw`
        CREATE UNIQUE INDEX IF NOT EXISTS "chat_conversations_user_instance_jid_unique"
        ON "chat_conversations" ("userId", "instanceName", "remoteJid")
      `;
      // El último mensaje de la conversación fue eliminado por el cliente (la lista
      // muestra "Mensaje eliminado"). Se resetea a FALSE al llegar un mensaje nuevo.
      await this.prisma.$executeRaw`
        ALTER TABLE "chat_conversations" ADD COLUMN IF NOT EXISTS "lastMessageDeleted" BOOLEAN NOT NULL DEFAULT FALSE
      `;
      // Mapeo lid -> remoteJid (número), aprendido de los mensajes entrantes, para
      // resolver el "from" de las llamadas (que llega como @lid) al chat correcto.
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS "chat_lid_map" (
          "userId" TEXT NOT NULL,
          "lid" TEXT NOT NULL,
          "remoteJid" TEXT NOT NULL,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY ("userId", "lid")
        )
      `;
    })().catch((err) => {
      this.ensurePromise = null;
      throw err;
    });

    return this.ensurePromise;
  }

  private toDate(value?: Date | number | string | null): Date {
    if (value instanceof Date) return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value < 2_000_000_000 ? value * 1000 : value);
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return new Date();
  }

  /**
   * ¿Es un evento de BORRADO de mensaje (revoke / "eliminar para todos")?
   * Se detecta igual que el frontend (lib/chat-persistence.ts). Estos eventos NO
   * deben persistirse ni tocar el mensaje original: queremos conservar en la
   * plataforma lo que el cliente escribió aunque después lo borre.
   */
  private isDeletedMessageEvent(input: PersistChatMessageInput): boolean {
    const raw = input.raw;
    const rawRecord = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : null;
    const message = rawRecord?.message && typeof rawRecord.message === 'object'
      ? (rawRecord.message as Record<string, any>)
      : null;
    const protocolType = message?.protocolMessage?.type ?? rawRecord?.protocolMessage?.type;

    return (
      input.messageType === 'protocolMessage' ||
      input.messageType === 'messageStubType' ||
      input.messageType === 'revokedMessage' ||
      protocolType === 0 ||
      protocolType === 'REVOKE' ||
      protocolType === 'MESSAGE_REVOKE'
    );
  }

  /**
   * Marca un mensaje ya guardado como eliminado por el cliente (revoke), SIN tocar
   * su contenido. El panel usa esta bandera para pintar el badge "Eliminado".
   * Nunca lanza. Empata por messageId + conversación (remoteJid o su alterno).
   */
  async markMessageDeleted(input: {
    userId: string;
    instanceName: string;
    remoteJid: string;
    remoteJidAlt?: string | null;
    messageId: string;
  }): Promise<void> {
    if (!input.userId || !input.instanceName || !input.messageId) return;
    try {
      await this.ensureTables();
      // Empatar SOLO por messageId dentro de la línea/cuenta: el id de WhatsApp es
      // único, y el remoteJid del evento de borrado a veces llega como @lid (ID de
      // privacidad) mientras el mensaje se guardó con el número real. Por eso NO se
      // filtra por remoteJid (si no, no empataría y no se marcaría).
      await this.prisma.$executeRaw`
        UPDATE "chat_messages"
        SET "deleted" = TRUE, "updatedAt" = NOW()
        WHERE "userId" = ${input.userId}
          AND "instanceName" = ${input.instanceName}
          AND "messageId" = ${input.messageId}
      `;
      // Si el eliminado era el último mensaje, marcar la conversación para la lista.
      await this.prisma.$executeRaw`
        UPDATE "chat_conversations"
        SET "lastMessageDeleted" = TRUE, "updatedAt" = NOW()
        WHERE "userId" = ${input.userId}
          AND "instanceName" = ${input.instanceName}
          AND "lastMessageId" = ${input.messageId}
      `;
    } catch (err: any) {
      this.logger.error(`[ChatStore] Error marcando mensaje eliminado: ${err?.message}`);
    }
  }

  /** Persiste un mensaje (entrante o saliente) en el store unificado. Nunca lanza. */
  async persistMessage(input: PersistChatMessageInput): Promise<void> {
    if (!input.userId || !input.instanceName || !input.remoteJid) return;
    // Nunca persistir un borrado: conserva intacto el mensaje original.
    if (this.isDeletedMessageEvent(input)) return;
    // No persistir mensajes de texto vacíos (p.ej. el placeholder que a veces deja
    // un borrado): evita que la lista quede con "-" como último mensaje.
    {
      const contentTrim = typeof input.content === 'string' ? input.content.trim() : '';
      const hasPayload =
        (!!contentTrim && contentTrim !== '-') ||
        !!input.mediaUrl ||
        !['conversation', 'extendedTextMessage', null, undefined].includes(input.messageType ?? undefined);
      if (!hasPayload) return;
    }

    try {
      await this.ensureTables();

      // Si el mensaje viene dirigido por @lid y ya sabemos a qué número
      // corresponde, guardamos la conversación bajo el NÚMERO y dejamos el
      // @lid como alias. Sin esto se creaba una conversación aparte por cada
      // @lid: en la bandeja aparecía el contacto duplicado, con el propio @lid
      // como nombre ("152252530581757") en vez del cliente. Es el mismo
      // criterio que ya aplica SessionService al registrar la sesión, para que
      // ambas tablas coincidan en la identidad canónica.
      if (this.isLid(input.remoteJid)) {
        let real = await this.resolveLid(input.userId, input.remoteJid);

        // Si el mapa aún no conoce este @lid, el propio messageId lo delata: si
        // ya guardamos ese mismo mensaje bajo un número, es EL MISMO mensaje y
        // va a la misma conversación. Este es el caso del mensaje que "se envía
        // doble": el panel lo guarda con el número al enviarlo y, un par de
        // segundos después, el eco de Evolution llega dirigido por @lid; como
        // el índice único incluye el remoteJid, entraba como fila nueva y la
        // burbuja aparecía repetida. El cliente recibía UN solo mensaje.
        if (!real && input.messageId?.trim()) {
          real = await this.resolveByMessageId(
            input.userId,
            input.instanceName,
            input.messageId.trim(),
          );
          // De paso aprendemos el par, para que el resto de mensajes de este
          // contacto ya no necesiten esta segunda vía.
          if (real) void this.rememberLid(input.userId, input.remoteJid, real);
        }

        if (real) {
          input = {
            ...input,
            remoteJid: real,
            remoteJidAlt: input.remoteJidAlt || this.normLid(input.remoteJid),
          };
        }
      }

      const messageId =
        input.messageId?.trim() ||
        `${input.fromMe ? 'out' : 'in'}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const ts = this.toDate(input.messageTimestamp);
      const messageType = input.messageType ?? 'conversation';
      // IMPORTANTE: $executeRaw NO serializa objetos JS a JSONB (quedan como `{}`),
      // perdiendo el marcador { sentByAi: true }. Se pasa el JSON como texto y se
      // castea con ::jsonb en el VALUES.
      const rawJson: string | null = input.raw ? JSON.stringify(input.raw) : null;

      await this.prisma.$executeRaw`
        INSERT INTO "chat_messages" (
          "userId", "instanceName", "instanceType", "remoteJid", "remoteJidAlt", "senderPn",
          "messageId", "fromMe", "pushName", "messageType", "content", "mediaUrl", "raw",
          "messageTimestamp", "createdAt", "updatedAt"
        )
        VALUES (
          ${input.userId}, ${input.instanceName}, ${input.instanceType ?? null}, ${input.remoteJid},
          ${input.remoteJidAlt ?? null}, ${input.senderPn ?? null}, ${messageId}, ${input.fromMe},
          ${input.pushName ?? null}, ${messageType}, ${input.content ?? null},
          ${input.mediaUrl ?? null}, ${rawJson}::jsonb, ${ts}, NOW(), NOW()
        )
        ON CONFLICT ("userId", "instanceName", "remoteJid", "messageId", "fromMe")
        DO UPDATE SET
          "messageType" = EXCLUDED."messageType",
          "content" = COALESCE(EXCLUDED."content", "chat_messages"."content"),
          "mediaUrl" = COALESCE(EXCLUDED."mediaUrl", "chat_messages"."mediaUrl"),
          "messageTimestamp" = EXCLUDED."messageTimestamp",
          "updatedAt" = NOW()
      `;

      await this.prisma.$executeRaw`
        INSERT INTO "chat_conversations" (
          "userId", "instanceName", "instanceType", "remoteJid", "remoteJidAlt", "senderPn",
          "pushName", "lastMessageId", "lastMessageFromMe", "lastMessageType",
          "lastMessageContent", "lastMessageMediaUrl", "lastMessageRaw",
          "lastMessageTimestamp", "createdAt", "updatedAt"
        )
        VALUES (
          ${input.userId}, ${input.instanceName}, ${input.instanceType ?? null}, ${input.remoteJid},
          ${input.remoteJidAlt ?? null}, ${input.senderPn ?? null}, ${input.pushName ?? null},
          ${messageId}, ${input.fromMe}, ${messageType},
          ${input.content ?? null}, ${input.mediaUrl ?? null}, ${rawJson}::jsonb,
          ${ts}, NOW(), NOW()
        )
        ON CONFLICT ("userId", "instanceName", "remoteJid")
        DO UPDATE SET
          "pushName" = COALESCE(EXCLUDED."pushName", "chat_conversations"."pushName"),
          "lastMessageId" = EXCLUDED."lastMessageId",
          "lastMessageFromMe" = EXCLUDED."lastMessageFromMe",
          "lastMessageType" = EXCLUDED."lastMessageType",
          "lastMessageContent" = EXCLUDED."lastMessageContent",
          -- Si llega un mensaje NUEVO (id distinto) se usa su mediaUrl tal cual
          -- (puede ser NULL si el nuevo último mensaje es texto). Si es el MISMO
          -- último mensaje reentregado, no se pierde una URL ya resuelta (p. ej.
          -- por el worker de backfill) cuando la reentrega llega sin ella.
          "lastMessageMediaUrl" = CASE
            WHEN EXCLUDED."lastMessageId" IS DISTINCT FROM "chat_conversations"."lastMessageId"
              THEN EXCLUDED."lastMessageMediaUrl"
            ELSE COALESCE(EXCLUDED."lastMessageMediaUrl", "chat_conversations"."lastMessageMediaUrl")
          END,
          "lastMessageRaw" = EXCLUDED."lastMessageRaw",
          "lastMessageTimestamp" = EXCLUDED."lastMessageTimestamp",
          -- Solo se limpia la marca de eliminado si llega un mensaje NUEVO (id
          -- distinto). Re-persistir el mismo último mensaje (reentrega de
          -- Evolution) NO debe borrarla, o la lista pierde el "Mensaje eliminado".
          "lastMessageDeleted" = CASE
            WHEN EXCLUDED."lastMessageId" IS DISTINCT FROM "chat_conversations"."lastMessageId"
              THEN FALSE
            ELSE "chat_conversations"."lastMessageDeleted"
          END,
          "updatedAt" = NOW()
        WHERE "chat_conversations"."lastMessageTimestamp" IS NULL
           OR "chat_conversations"."lastMessageTimestamp" <= EXCLUDED."lastMessageTimestamp"
      `;
    } catch (err: any) {
      this.logger.error(`[ChatStore] Error persistiendo mensaje: ${err?.message}`);
    }
  }

  /** Normaliza un lid quitando sufijo de dispositivo (:NN) y asegurando @lid. */
  /** ¿Este JID es un identificador de privacidad @lid y no un teléfono? */
  private isLid(value?: string | null): boolean {
    return typeof value === 'string' && value.includes('@lid');
  }

  private normLid(value: string): string {
    const digits = (value || '').split('@')[0].split(':')[0].trim();
    return digits ? `${digits}@lid` : '';
  }

  /** Aprende el mapeo lid -> número (remoteJid) desde un mensaje entrante. */
  async rememberLid(userId: string, lidRaw: string, remoteJid: string): Promise<void> {
    const lid = this.normLid(lidRaw);
    if (!userId || !lid || !remoteJid) return;
    if (remoteJid.includes('@lid')) return; // el destino debe ser el número, no otro lid
    try {
      await this.ensureTables();
      await this.prisma.$executeRaw`
        INSERT INTO "chat_lid_map" ("userId", "lid", "remoteJid", "updatedAt")
        VALUES (${userId}, ${lid}, ${remoteJid}, NOW())
        ON CONFLICT ("userId", "lid")
        DO UPDATE SET "remoteJid" = EXCLUDED."remoteJid", "updatedAt" = NOW()
      `;
    } catch (err: any) {
      this.logger.error(`[ChatStore] Error guardando lid: ${err?.message}`);
    }
  }

  /**
   * Crea una tarea interna de "devolver llamada perdida" para el asesor, en la
   * tabla `tasks` (mismo sistema que el panel de Tareas del frontend). Hace
   * dedupe: no crea otra si ya hay una pendiente para el mismo contacto en las
   * últimas 6 horas. Best-effort: nunca lanza.
   */
  async createMissedCallTask(input: {
    userId: string;
    remoteJid: string;
    contactName?: string | null;
  }): Promise<void> {
    const { userId, remoteJid } = input;
    if (!userId || !remoteJid) return;
    try {
      // Dedupe: ¿ya hay una tarea de llamada pendiente reciente para este contacto?
      const existing = await this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n
        FROM "tasks"
        WHERE "ownerId" = ${userId}
          AND "contactJid" = ${remoteJid}
          AND "type" = 'Llamada'
          AND "status" = 'pending'
          AND "createdAt" > NOW() - INTERVAL '6 hours'
      `;
      if (Number(existing[0]?.n ?? 0) > 0) return;

      // Enlazar con la sesión/lead si existe (opcional).
      const sessionRows = await this.prisma.$queryRaw<{ id: number }[]>`
        SELECT "id" FROM "Session"
        WHERE "userId" = ${userId} AND "remoteJid" = ${remoteJid}
        ORDER BY "updatedAt" DESC
        LIMIT 1
      `;
      const sessionId = sessionRows[0]?.id ?? null;

      const name = input.contactName?.trim() || null;
      const phone = remoteJid.split('@')[0];
      const title = `Devolver llamada perdida a ${name || `+${phone}`}`;

      await this.prisma.$executeRaw`
        INSERT INTO "tasks" (
          "ownerId", "assignedToId", "assignedToName", "sessionId", "contactName",
          "contactJid", "title", "type", "dueDate", "status", "createdById",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${userId}, ${userId}, ${null}, ${sessionId}, ${name},
          ${remoteJid}, ${title}, 'Llamada', NOW(), 'pending', ${userId},
          NOW(), NOW()
        )
      `;
      this.logger.log(`[CALL] tarea de devolución creada user=${userId} jid=${remoteJid}`);
    } catch (err: any) {
      this.logger.error(`[ChatStore] Error creando tarea de llamada perdida: ${err?.message}`);
    }
  }

  /**
   * ¿Hicimos una llamada SALIENTE a este número en los últimos minutos? Se usa
   * para no registrar como "perdida" el eco de una llamada que iniciamos
   * nosotros (p. ej. las del voicebot). Compara por dígitos del número.
   */
  async recentOutgoingCallExists(userId: string, phoneDigits: string): Promise<boolean> {
    if (!userId || !phoneDigits) return false;
    try {
      const rows = await this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n FROM "chat_messages"
        WHERE "userId" = ${userId}
          AND "messageType" = 'call' AND "fromMe" = true
          AND split_part("remoteJid", '@', 1) = ${phoneDigits}
          AND "messageTimestamp" > NOW() - INTERVAL '3 minutes'
      `;
      return Number(rows[0]?.n ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Busca si ese mismo mensaje ya está guardado bajo un JID de teléfono. Un
   * messageId es único por mensaje en WhatsApp, así que encontrarlo bajo un
   * número significa que es la misma conversación y no una nueva.
   */
  private async resolveByMessageId(
    userId: string,
    instanceName: string,
    messageId: string,
  ): Promise<string | null> {
    try {
      const rows = await this.prisma.$queryRaw<{ remoteJid: string }[]>`
        SELECT "remoteJid" FROM "chat_messages"
         WHERE "userId" = ${userId}
           AND "instanceName" = ${instanceName}
           AND "messageId" = ${messageId}
           AND "remoteJid" NOT LIKE '%@lid'
         LIMIT 1
      `;
      return rows[0]?.remoteJid ?? null;
    } catch {
      return null;
    }
  }

  /** Resuelve un lid a su número (remoteJid) si fue aprendido antes. */
  async resolveLid(userId: string, lidRaw: string): Promise<string | null> {
    const lid = this.normLid(lidRaw);
    if (!userId || !lid) return null;
    try {
      await this.ensureTables();
      const rows = await this.prisma.$queryRaw<{ remoteJid: string }[]>`
        SELECT "remoteJid" FROM "chat_lid_map" WHERE "userId" = ${userId} AND "lid" = ${lid} LIMIT 1
      `;
      return rows[0]?.remoteJid ?? null;
    } catch {
      return null;
    }
  }
}
