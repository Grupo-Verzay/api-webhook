import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { WebhookBodyDto, WebhookDataDto } from '../../dto/webhook-body';

/* ─── Meta Cloud API payload types ─── */
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
  statuses?: any[];
}

interface MetaChange {
  value: MetaValue;
  field: string;
}

interface MetaEntry {
  id: string;
  changes: MetaChange[];
}

export interface MetaWebhookPayload {
  object: string;
  entry: MetaEntry[];
}

/* ─── Service ─── */
@Injectable()
export class MetaWebhookNormalizerService {
  private readonly logger = new Logger(MetaWebhookNormalizerService.name);

  constructor(private readonly prisma: PrismaService) {}

  async normalize(payload: MetaWebhookPayload): Promise<WebhookBodyDto[]> {
    const results: WebhookBodyDto[] = [];

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        const messages = value.messages ?? [];
        if (messages.length === 0) continue;

        // Lookup instance by phone_number_id
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
          this.logger.warn(`No instance found for phone_number_id: ${phoneNumberId}`);
          continue;
        }

        for (const msg of messages) {
          const contact = value.contacts?.find((c) => c.wa_id === msg.from);
          const pushName = contact?.profile?.name ?? msg.from;
          const remoteJid = `${msg.from}@s.whatsapp.net`;
          const normalized = this.buildDto(msg, {
            instanceName: instance.instanceName,
            instanceId: instance.instanceId ?? '',
            phoneNumberId: instance.metaPhoneNumberId ?? phoneNumberId,
            accessToken: instance.metaAccessToken ?? '',
            remoteJid,
            pushName,
          });
          if (normalized) results.push(normalized);
        }
      }
    }

    return results;
  }

  private buildDto(
    msg: MetaMessage,
    ctx: {
      instanceName: string;
      instanceId: string;
      phoneNumberId: string;
      accessToken: string;
      remoteJid: string;
      pushName: string;
    },
  ): WebhookBodyDto | null {
    const now = new Date().toISOString();
    const ts = parseInt(msg.timestamp, 10) || Math.floor(Date.now() / 1000);

    const key = {
      remoteJid: ctx.remoteJid,
      fromMe: false,
      id: msg.id,
    };

    let messageType = 'conversation';
    const message: WebhookDataDto['message'] = {};

    switch (msg.type) {
      case 'text':
        messageType = 'conversation';
        message.conversation = msg.text?.body ?? '';
        break;

      case 'audio':
        messageType = 'audioMessage';
        // mediaUrl will be resolved via Graph API by the agent
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
        break;

      case 'interactive':
        messageType = 'interactiveResponseMessage';
        if (msg.interactive?.type === 'button_reply') {
          message.conversation = msg.interactive.button_reply?.title ?? '';
          message.interactiveResponseMessage = {
            body: msg.interactive.button_reply?.title ?? '',
          };
        } else if (msg.interactive?.type === 'list_reply') {
          message.conversation = msg.interactive.list_reply?.title ?? '';
          message.interactiveResponseMessage = {
            body: msg.interactive.list_reply?.title ?? '',
          };
        }
        break;

      case 'button':
        messageType = 'conversation';
        message.conversation = msg.button?.text ?? msg.button?.payload ?? '';
        break;

      default:
        this.logger.warn(`Unsupported Meta message type: ${msg.type}`);
        return null;
    }

    const data: WebhookDataDto = {
      key,
      pushName: ctx.pushName,
      status: 'RECEIVED',
      message,
      messageType,
      messageTimestamp: ts,
      instanceId: ctx.instanceId,
      source: 'meta',
    };

    const dto = new WebhookBodyDto();
    dto.event = 'messages.upsert';
    dto.instance = ctx.instanceName;
    // Reutilizamos server_url = phoneNumberId y apikey = accessToken
    dto.server_url = ctx.phoneNumberId;
    dto.apikey = ctx.accessToken;
    dto.date_time = now;
    dto.destination = ctx.remoteJid;
    dto.sender = ctx.remoteJid;
    dto.data = data;

    return dto;
  }
}
