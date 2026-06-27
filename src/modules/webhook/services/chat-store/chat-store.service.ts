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

  /** Persiste un mensaje (entrante o saliente) en el store unificado. Nunca lanza. */
  async persistMessage(input: PersistChatMessageInput): Promise<void> {
    if (!input.userId || !input.instanceName || !input.remoteJid) return;

    try {
      await this.ensureTables();

      const messageId =
        input.messageId?.trim() ||
        `${input.fromMe ? 'out' : 'in'}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const ts = this.toDate(input.messageTimestamp);
      const messageType = input.messageType ?? 'conversation';
      const rawValue: Prisma.InputJsonValue | typeof Prisma.JsonNull =
        input.raw ?? Prisma.JsonNull;

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
          ${input.mediaUrl ?? null}, ${rawValue}, ${ts}, NOW(), NOW()
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
          ${input.content ?? null}, ${input.mediaUrl ?? null}, ${rawValue},
          ${ts}, NOW(), NOW()
        )
        ON CONFLICT ("userId", "instanceName", "remoteJid")
        DO UPDATE SET
          "pushName" = COALESCE(EXCLUDED."pushName", "chat_conversations"."pushName"),
          "lastMessageId" = EXCLUDED."lastMessageId",
          "lastMessageFromMe" = EXCLUDED."lastMessageFromMe",
          "lastMessageType" = EXCLUDED."lastMessageType",
          "lastMessageContent" = EXCLUDED."lastMessageContent",
          "lastMessageMediaUrl" = EXCLUDED."lastMessageMediaUrl",
          "lastMessageRaw" = EXCLUDED."lastMessageRaw",
          "lastMessageTimestamp" = EXCLUDED."lastMessageTimestamp",
          "updatedAt" = NOW()
        WHERE "chat_conversations"."lastMessageTimestamp" IS NULL
           OR "chat_conversations"."lastMessageTimestamp" <= EXCLUDED."lastMessageTimestamp"
      `;
    } catch (err: any) {
      this.logger.error(`[ChatStore] Error persistiendo mensaje: ${err?.message}`);
    }
  }
}
