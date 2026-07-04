import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { WebhookBodyDto, WebhookDataDto } from '../../dto/webhook-body';

/* ─── WhatsApp Cloud API payload types ─── */
interface MetaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text' | 'audio' | 'image' | 'video' | 'document' | 'sticker' | 'interactive' | 'button' | 'order' | 'unsupported';
  text?: { body: string };
  audio?: { id: string; mime_type: string };
  image?: { id: string; mime_type: string; caption?: string };
  video?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  button?: { payload: string; text: string };
}

interface MetaContact {
  profile: { name: string };
  wa_id: string;
}

interface MetaValue {
  messaging_product: string;
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: MetaContact[];
  messages?: MetaMessage[];
  calls?: MetaCall[];
  statuses?: any[];
}

interface MetaCall {
  id?: string;
  from?: string;
  to?: string;
  event?: string;
  status?: string;
  timestamp?: string;
  session?: {
    sdp?: string;
    sdp_type?: string;
  };
  [key: string]: any;
}

interface MetaChange {
  value: MetaValue;
  field: string;
}

/* ─── Facebook Messenger / Instagram DM payload types ─── */
interface MessengerAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'location' | 'fallback';
  payload?: { url?: string; sticker_id?: number };
}

interface MessengerMessage {
  mid: string;
  text?: string;
  attachments?: MessengerAttachment[];
}

interface MessengerEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: MessengerMessage;
}

interface MetaEntry {
  id: string;
  changes?: MetaChange[];
  messaging?: MessengerEvent[];
}

export interface MetaWebhookPayload {
  object: string;
  entry: MetaEntry[];
}

/* ─── Internal context passed to buildDto ─── */
interface DtoContext {
  instanceName: string;
  instanceId: string;
  serverUrl: string;
  accessToken: string;
  remoteJid: string;
  pushName: string;
}

/* ─── Service ─── */
@Injectable()
export class MetaWebhookNormalizerService {
  private readonly logger = new Logger(MetaWebhookNormalizerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Verifica si el token coincide con el env global o con alguna instancia en BD. */
  async verifyToken(token: string): Promise<boolean> {
    const envToken = (process.env.META_VERIFY_TOKEN ?? '').trim();
    if (envToken && token === envToken) return true;

    const found = await this.prisma.instancia.findFirst({
      where: { metaVerifyToken: token },
      select: { id: true },
    });
    return !!found;
  }

  async normalize(payload: MetaWebhookPayload): Promise<WebhookBodyDto[]> {
    const results: WebhookBodyDto[] = [];

    for (const entry of payload.entry ?? []) {
      if (payload.object === 'whatsapp_business_account') {
        const dtos = await this.normalizeWhatsApp(entry);
        results.push(...dtos);
      } else if (payload.object === 'page' || payload.object === 'instagram') {
        const channel = payload.object === 'page' ? 'facebook' : 'instagram';
        const dtos = await this.normalizeMessenger(entry, channel);
        results.push(...dtos);
      } else {
        this.logger.warn(`[Meta] Objeto de webhook desconocido: ${payload.object}`);
      }
    }

    return results;
  }

  /* ── WhatsApp Cloud API ── */
  private async normalizeWhatsApp(entry: MetaEntry): Promise<WebhookBodyDto[]> {
    const results: WebhookBodyDto[] = [];

    for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      if (change.field === 'calls') {
        await this.persistCallWebhook(value);
        continue;
      }

      if (change.field !== 'messages') continue;

      const messages = value.messages ?? [];
      if (messages.length === 0) continue;

      const instance = await this.prisma.instancia.findFirst({
        where: { metaPhoneNumberId: phoneNumberId },
        select: {
          instanceName: true,
          instanceId: true,
          metaAccessToken: true,
          metaPhoneNumberId: true,
        },
      });

      if (!instance) {
        this.logger.warn(`[Meta/WA] No hay instancia para phone_number_id: ${phoneNumberId}`);
        continue;
      }

      for (const msg of messages) {
        const contact = value.contacts?.find((c) => c.wa_id === msg.from);
        const pushName = contact?.profile?.name ?? msg.from;
        const remoteJid = `${msg.from}@s.whatsapp.net`;
        const dto = this.buildWhatsAppDto(msg, {
          instanceName: instance.instanceName,
          instanceId: instance.instanceId ?? '',
          serverUrl: instance.metaPhoneNumberId ?? phoneNumberId,
          accessToken: instance.metaAccessToken ?? '',
          remoteJid,
          pushName,
        });
        if (dto) results.push(dto);
      }
    }

    return results;
  }

  /* ── Facebook Messenger / Instagram DMs ── */
  private async persistCallWebhook(value: MetaValue): Promise<void> {
    const phoneNumberId = value.metadata?.phone_number_id;
    const calls = value.calls ?? [];
    if (!phoneNumberId || calls.length === 0) return;

    const instance = await this.prisma.instancia.findFirst({
      where: { metaPhoneNumberId: phoneNumberId },
      select: { instanceName: true, userId: true },
    });

    if (!instance?.userId) {
      this.logger.warn(`[Meta/WA Calls] No hay instancia para phone_number_id: ${phoneNumberId}`);
      return;
    }

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

    for (const call of calls) {
      const callId = String(call.id ?? '').trim();
      if (!callId) continue;

      const rawJson = JSON.stringify({
        metaCall: {
          ...call,
          phoneNumberId,
          displayPhoneNumber: value.metadata?.display_phone_number,
        },
      });

      await this.prisma.$executeRaw`
        INSERT INTO "chat_messages" (
          "userId", "instanceName", "instanceType", "remoteJid", "messageId",
          "fromMe", "messageType", "content", "raw", "messageTimestamp", "createdAt", "updatedAt"
        )
        VALUES (
          ${instance.userId}, ${instance.instanceName}, ${'meta'}, ${`meta-call:${callId}`},
          ${`meta_call_${callId}`}, ${false}, ${'meta_call'},
          ${call.event ?? call.status ?? 'call'}, ${rawJson}::jsonb, NOW(), NOW(), NOW()
        )
        ON CONFLICT ("userId", "instanceName", "remoteJid", "messageId", "fromMe")
        DO UPDATE SET
          "content" = EXCLUDED."content",
          "raw" = EXCLUDED."raw",
          "updatedAt" = NOW()
      `;
    }
  }

  private async normalizeMessenger(
    entry: MetaEntry,
    channel: 'facebook' | 'instagram',
  ): Promise<WebhookBodyDto[]> {
    const results: WebhookBodyDto[] = [];
    const pageId = entry.id;

    const events = entry.messaging ?? [];
    if (events.length === 0) return results;

    const instance = await this.prisma.instancia.findFirst({
      where: { metaPageId: pageId, metaChannel: channel },
      select: {
        instanceName: true,
        instanceId: true,
        metaAccessToken: true,
        metaPageId: true,
      },
    });

    if (!instance) {
      this.logger.warn(`[Meta/${channel}] No hay instancia para pageId: ${pageId}`);
      return results;
    }

    const jidSuffix = channel === 'facebook' ? '@messenger' : '@instagram';

    for (const event of events) {
      if (!event.message) continue;
      const msg = event.message;
      const senderId = event.sender.id;
      const remoteJid = `${senderId}${jidSuffix}`;

      const dto = this.buildMessengerDto(msg, event.timestamp, {
        instanceName: instance.instanceName,
        instanceId: instance.instanceId ?? '',
        serverUrl: instance.metaPageId ?? pageId,
        accessToken: instance.metaAccessToken ?? '',
        remoteJid,
        pushName: senderId,
      });
      if (dto) results.push(dto);
    }

    return results;
  }

  /* ── DTO builders ── */
  private buildWhatsAppDto(msg: MetaMessage, ctx: DtoContext): WebhookBodyDto | null {
    const now = new Date().toISOString();
    const ts = parseInt(msg.timestamp, 10) || Math.floor(Date.now() / 1000);

    let messageType = 'conversation';
    const message: WebhookDataDto['message'] = {};

    switch (msg.type) {
      case 'text':
        messageType = 'conversation';
        message.conversation = msg.text?.body ?? '';
        break;
      case 'audio':
        messageType = 'audioMessage';
        message.mediaUrl = msg.audio?.id
          ? `meta-media://${msg.audio.id}?token=${ctx.accessToken}`
          : '';
        break;
      case 'image':
        messageType = 'imageMessage';
        message.mediaUrl = msg.image?.id
          ? `meta-media://${msg.image.id}?token=${ctx.accessToken}`
          : '';
        message.conversation = msg.image?.caption ?? '';
        break;
      case 'video':
        messageType = 'videoMessage';
        message.mediaUrl = msg.video?.id
          ? `meta-media://${msg.video.id}?token=${ctx.accessToken}`
          : '';
        message.conversation = msg.video?.caption ?? '';
        break;
      case 'document':
        messageType = 'documentMessage';
        message.mediaUrl = msg.document?.id
          ? `meta-media://${msg.document.id}?token=${ctx.accessToken}`
          : '';
        message.conversation = msg.document?.caption ?? msg.document?.filename ?? '';
        // Campos que usa MessageTypeHandlerService para extraer texto del PDF.
        (message as any).mediaMimetype = msg.document?.mime_type ?? '';
        (message as any).documentMessage = {
          fileName: msg.document?.filename ?? 'documento',
          mimetype: msg.document?.mime_type ?? '',
          caption: msg.document?.caption ?? '',
        };
        break;
      case 'interactive':
        messageType = 'interactiveResponseMessage';
        if (msg.interactive?.type === 'button_reply') {
          message.conversation = msg.interactive.button_reply?.title ?? '';
          message.interactiveResponseMessage = { body: msg.interactive.button_reply?.title ?? '' };
        } else if (msg.interactive?.type === 'list_reply') {
          message.conversation = msg.interactive.list_reply?.title ?? '';
          message.interactiveResponseMessage = { body: msg.interactive.list_reply?.title ?? '' };
        }
        break;
      case 'button':
        messageType = 'conversation';
        message.conversation = msg.button?.text ?? msg.button?.payload ?? '';
        break;
      default:
        this.logger.warn(`[Meta/WA] Tipo de mensaje no soportado: ${msg.type}`);
        return null;
    }

    return this.assembleDto(ctx, {
      id: msg.id,
      ts,
      now,
      messageType,
      message,
      source: 'meta',
    });
  }

  private buildMessengerDto(
    msg: MessengerMessage,
    timestamp: number,
    ctx: DtoContext,
  ): WebhookBodyDto | null {
    const now = new Date().toISOString();
    let messageType = 'conversation';
    const message: WebhookDataDto['message'] = {};

    if (msg.text) {
      messageType = 'conversation';
      message.conversation = msg.text;
    } else if (msg.attachments?.length) {
      const att = msg.attachments[0];
      if (att.type === 'image') {
        messageType = 'imageMessage';
        message.mediaUrl = att.payload?.url ?? '';
      } else if (att.type === 'audio') {
        messageType = 'audioMessage';
        message.mediaUrl = att.payload?.url ?? '';
      } else if (att.type === 'video') {
        messageType = 'videoMessage';
        message.mediaUrl = att.payload?.url ?? '';
      } else if (att.type === 'file') {
        messageType = 'documentMessage';
        message.mediaUrl = att.payload?.url ?? '';
      } else {
        this.logger.warn(`[Meta/Messenger] Adjunto no soportado: ${att.type}`);
        return null;
      }
    } else {
      return null;
    }

    return this.assembleDto(ctx, {
      id: msg.mid,
      ts: Math.floor(timestamp / 1000),
      now,
      messageType,
      message,
      source: 'meta',
    });
  }

  private assembleDto(
    ctx: DtoContext,
    payload: {
      id: string;
      ts: number;
      now: string;
      messageType: string;
      message: WebhookDataDto['message'];
      source: string;
    },
  ): WebhookBodyDto {
    const data: WebhookDataDto = {
      key: { remoteJid: ctx.remoteJid, fromMe: false, id: payload.id },
      pushName: ctx.pushName,
      status: 'RECEIVED',
      message: payload.message,
      messageType: payload.messageType,
      messageTimestamp: payload.ts,
      instanceId: ctx.instanceId,
      source: payload.source,
    };

    const dto = new WebhookBodyDto();
    dto.event = 'messages.upsert';
    dto.instance = ctx.instanceName;
    dto.server_url = ctx.serverUrl;
    dto.apikey = ctx.accessToken;
    dto.date_time = payload.now;
    dto.destination = ctx.remoteJid;
    dto.sender = ctx.remoteJid;
    dto.data = data;

    return dto;
  }
}
