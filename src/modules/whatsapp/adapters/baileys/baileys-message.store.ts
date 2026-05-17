import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';

export interface ChatSummary {
  remoteJid: string;
  pushName: string | null;
  lastMessageBody: string | null;
  lastMessageAt: Date | null;
  lastMessageFromMe: boolean;
  unreadCount: number;
}

export interface SaveMessageParams {
  instanceName: string;
  remoteJid: string;
  messageId: string;
  fromMe: boolean;
  body: string | null;
  type: string;
  timestamp: Date;
  mediaUrl?: string | null;
  pushName?: string | null;
}

export function extractMessageBody(message: Record<string, any>): { body: string | null; type: string } {
  if (!message) return { body: null, type: 'unknown' };

  // Unwrap container types that nest another message inside
  if (message.deviceSentMessage?.message) return extractMessageBody(message.deviceSentMessage.message);
  if (message.ephemeralMessage?.message) return extractMessageBody(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return extractMessageBody(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message?.viewOnceMessage?.message)
    return extractMessageBody(message.viewOnceMessageV2.message.viewOnceMessage.message);
  if (message.documentWithCaptionMessage?.message) return extractMessageBody(message.documentWithCaptionMessage.message);
  if (message.editedMessage?.message) return extractMessageBody(message.editedMessage.message);

  if (message.conversation) return { body: message.conversation, type: 'conversation' };
  if (message.extendedTextMessage?.text) return { body: message.extendedTextMessage.text, type: 'extendedTextMessage' };
  if (message.imageMessage) return { body: message.imageMessage.caption ?? null, type: 'imageMessage' };
  if (message.videoMessage) return { body: message.videoMessage.caption ?? null, type: 'videoMessage' };
  if (message.documentMessage) return { body: message.documentMessage.caption ?? message.documentMessage.fileName ?? null, type: 'documentMessage' };
  if (message.audioMessage) return { body: null, type: 'audioMessage' };
  if (message.stickerMessage) return { body: null, type: 'stickerMessage' };
  if (message.reactionMessage) return { body: message.reactionMessage.text ?? null, type: 'reactionMessage' };
  if (message.buttonsMessage) return { body: message.buttonsMessage.contentText ?? null, type: 'buttonsMessage' };
  if (message.listMessage) return { body: message.listMessage.description ?? null, type: 'listMessage' };
  if (message.templateMessage) return { body: message.templateMessage.hydratedTemplate?.hydratedContentText ?? null, type: 'templateMessage' };
  if (message.contactMessage) return { body: message.contactMessage.displayName ?? null, type: 'contactMessage' };
  if (message.locationMessage) return { body: null, type: 'locationMessage' };
  if (message.protocolMessage) return { body: null, type: 'protocolMessage' };

  const firstKey = Object.keys(message)[0];
  return { body: null, type: firstKey ?? 'unknown' };
}

@Injectable()
export class BaileysMessageStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
  ) {}

  async saveMessage(params: SaveMessageParams): Promise<void> {
    const { instanceName, remoteJid, messageId, fromMe, body, type, timestamp, mediaUrl, pushName } = params;

    // skip protocol/system messages silently
    if (type === 'protocolMessage' || type === 'unknown') return;

    try {
      await this.prisma.baileysContact.upsert({
        where: { instanceName_remoteJid: { instanceName, remoteJid } },
        create: { instanceName, remoteJid, pushName: pushName ?? null },
        update: pushName ? { pushName } : {},
      });

      await this.prisma.baileysMessage.upsert({
        where: { instanceName_messageId: { instanceName, messageId } },
        create: { instanceName, remoteJid, messageId, fromMe, body, type, timestamp, mediaUrl: mediaUrl ?? null },
        update: {},
      });
    } catch (err) {
      this.logger.error(`[BaileysStore] Error guardando mensaje ${messageId}`, err?.message, 'BaileysMessageStore');
    }
  }

  async getChats(instanceName: string): Promise<ChatSummary[]> {
    const contacts = await this.prisma.baileysContact.findMany({
      where: { instanceName },
      include: {
        messages: {
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return contacts.map((c) => {
      const last = c.messages[0] ?? null;
      return {
        remoteJid: c.remoteJid,
        pushName: c.pushName,
        lastMessageBody: last?.body ?? null,
        lastMessageAt: last?.timestamp ?? null,
        lastMessageFromMe: last?.fromMe ?? false,
        unreadCount: 0,
      };
    });
  }

  async getMessages(
    instanceName: string,
    remoteJid: string,
    limit = 50,
    before?: Date,
  ) {
    return this.prisma.baileysMessage.findMany({
      where: {
        instanceName,
        remoteJid,
        ...(before ? { timestamp: { lt: before } } : {}),
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }
}
