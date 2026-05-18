import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';

export interface ChatSummary {
  remoteJid: string;
  pushName: string | null;
  phoneNumber: string | null;
  lastMessageBody: string | null;
  lastMessageType: string | null;
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
  phoneNumber?: string | null;
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
    const { instanceName, remoteJid, messageId, fromMe, body, type, timestamp, mediaUrl, pushName, phoneNumber } = params;

    // skip protocol/system messages silently
    if (type === 'protocolMessage' || type === 'unknown') return;

    try {
      await this.prisma.baileysContact.upsert({
        where: { instanceName_remoteJid: { instanceName, remoteJid } },
        create: {
          instanceName, remoteJid,
          pushName: pushName ?? null, phoneNumber: phoneNumber ?? null,
          lastBody: body, lastType: type, lastAt: timestamp, lastFromMe: fromMe,
        },
        update: {
          ...(pushName ? { pushName } : {}),
          ...(phoneNumber ? { phoneNumber } : {}),
          lastBody: body,
          lastType: type,
          lastAt: timestamp,
          lastFromMe: fromMe,
        },
      });

      // Si el JID es @lid y tenemos el número real, actualizamos remoteJidAlt en Session
      // para que la página de Leads muestre el número correcto
      if (phoneNumber && remoteJid.toLowerCase().endsWith('@lid')) {
        const phoneJid = `${phoneNumber.replace(/\D/g, '')}@s.whatsapp.net`;
        await this.prisma.session.updateMany({
          where: {
            remoteJid,
            instanceName,
            OR: [{ remoteJidAlt: null }, { remoteJidAlt: '' }],
          },
          data: { remoteJidAlt: phoneJid },
        }).catch(() => {});
      }

      await this.prisma.baileysMessage.upsert({
        where: { instanceName_messageId: { instanceName, messageId } },
        create: { instanceName, remoteJid, messageId, fromMe, body, type, timestamp, mediaUrl: mediaUrl ?? null },
        update: {},
      });
    } catch (err) {
      this.logger.error(`[BaileysStore] Error guardando mensaje ${messageId}`, err?.message, 'BaileysMessageStore');
    }
  }

  async getChats(instanceName: string, ownPhone?: string): Promise<ChatSummary[]> {
    const contacts = await this.prisma.baileysContact.findMany({
      where: {
        instanceName,
        ...(ownPhone ? { NOT: { remoteJid: `${ownPhone}@s.whatsapp.net` } } : {}),
      },
      orderBy: { lastAt: 'desc' },
    });

    return contacts.map((c) => ({
      remoteJid: c.remoteJid,
      pushName: c.pushName,
      phoneNumber: c.phoneNumber ?? null,
      lastMessageBody: c.lastBody ?? null,
      lastMessageType: c.lastType ?? null,
      lastMessageAt: c.lastAt ?? null,
      lastMessageFromMe: c.lastFromMe,
      unreadCount: 0,
    }));
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

  async getContactPhone(instanceName: string, remoteJid: string): Promise<string | null> {
    const contact = await this.prisma.baileysContact.findUnique({
      where: { instanceName_remoteJid: { instanceName, remoteJid } },
      select: { phoneNumber: true },
    });
    return contact?.phoneNumber ?? null;
  }

  async updateContactPhone(instanceName: string, lidJid: string, phoneDigits: string, pushName?: string | null): Promise<void> {
    try {
      await this.prisma.baileysContact.upsert({
        where: { instanceName_remoteJid: { instanceName, remoteJid: lidJid } },
        create: { instanceName, remoteJid: lidJid, phoneNumber: phoneDigits, pushName: pushName ?? null },
        update: { phoneNumber: phoneDigits, ...(pushName ? { pushName } : {}) },
      });

      const phoneJid = `${phoneDigits}@s.whatsapp.net`;
      await this.prisma.session.updateMany({
        where: {
          remoteJid: lidJid,
          instanceName,
          OR: [{ remoteJidAlt: null }, { remoteJidAlt: '' }, { remoteJidAlt: lidJid }],
        },
        data: { remoteJidAlt: phoneJid },
      }).catch(() => {});
    } catch (err) {
      this.logger.error(`[BaileysStore] Error updating contact phone for ${lidJid}`, err?.message, 'BaileysMessageStore');
    }
  }
}
