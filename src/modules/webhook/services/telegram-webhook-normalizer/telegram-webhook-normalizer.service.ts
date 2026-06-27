import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { WebhookBodyDto, WebhookDataDto } from '../../dto/webhook-body';

/* ─── Telegram Bot API payload types (subset) ─── */
interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  title?: string;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramVoice {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVideo {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  document?: TelegramDocument;
  video?: TelegramVideo;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

/* ─── Service ─── */
@Injectable()
export class TelegramWebhookNormalizerService {
  private readonly logger = new Logger(TelegramWebhookNormalizerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Normaliza un update de Telegram a la lista de DTOs comunes.
   *
   * @param instanceName Nombre de instancia (viene en la URL del webhook).
   * @param update Cuerpo del update de Telegram.
   * @param secretToken Header `X-Telegram-Bot-Api-Secret-Token` (validación opcional).
   */
  async normalize(
    instanceName: string,
    update: TelegramUpdate,
    secretToken?: string,
  ): Promise<WebhookBodyDto[]> {
    const msg = update?.message ?? update?.edited_message;
    if (!msg) return [];

    const instance = await this.prisma.instancia.findFirst({
      where: { instanceName, instanceType: 'telegram' },
      select: {
        instanceName: true,
        instanceId: true,
        metaAccessToken: true,
        metaVerifyToken: true,
      },
    });

    if (!instance) {
      this.logger.warn(`[Telegram] No hay instancia para: ${instanceName}`);
      return [];
    }

    // Validación del secret token (si la instancia tiene uno configurado).
    if (instance.metaVerifyToken && secretToken !== instance.metaVerifyToken) {
      this.logger.warn(`[Telegram] Secret token inválido para ${instanceName}`);
      return [];
    }

    const botToken = instance.metaAccessToken ?? '';
    if (!botToken) {
      this.logger.warn(`[Telegram] Instancia ${instanceName} sin bot token`);
      return [];
    }

    const dto = this.buildDto(msg, {
      instanceName: instance.instanceName,
      instanceId: instance.instanceId ?? '',
      botToken,
    });

    return dto ? [dto] : [];
  }

  /** URL interna que MessageTypeHandlerService resuelve vía getFile. */
  private fileUrl(fileId: string, botToken: string): string {
    return `telegram-file://${fileId}?token=${botToken}`;
  }

  private buildDto(
    msg: TelegramMessage,
    ctx: { instanceName: string; instanceId: string; botToken: string },
  ): WebhookBodyDto | null {
    const caption = msg.caption ?? '';

    let messageType = 'conversation';
    const message: WebhookDataDto['message'] = {};

    if (msg.text) {
      messageType = 'conversation';
      message.conversation = msg.text;
    } else if (msg.photo?.length) {
      // Telegram envía varias resoluciones; la última es la de mayor tamaño.
      const largest = msg.photo[msg.photo.length - 1];
      messageType = 'imageMessage';
      message.mediaUrl = this.fileUrl(largest.file_id, ctx.botToken);
      message.conversation = caption;
    } else if (msg.voice) {
      messageType = 'audioMessage';
      message.mediaUrl = this.fileUrl(msg.voice.file_id, ctx.botToken);
      (message as any).audioMessage = { mimetype: msg.voice.mime_type ?? 'audio/ogg' };
    } else if (msg.audio) {
      messageType = 'audioMessage';
      message.mediaUrl = this.fileUrl(msg.audio.file_id, ctx.botToken);
      (message as any).audioMessage = { mimetype: msg.audio.mime_type ?? 'audio/mpeg' };
    } else if (msg.document) {
      messageType = 'documentMessage';
      message.mediaUrl = this.fileUrl(msg.document.file_id, ctx.botToken);
      (message as any).mediaMimetype = msg.document.mime_type ?? '';
      (message as any).documentMessage = {
        fileName: msg.document.file_name ?? 'documento',
        mimetype: msg.document.mime_type ?? '',
        caption,
      };
    } else if (msg.video) {
      // El video no se analiza (ningún canal lo procesa). Se entrega como nota de texto.
      messageType = 'conversation';
      message.conversation = caption
        ? `[Video recibido] ${caption}`
        : '[Video recibido]';
    } else {
      this.logger.warn(
        `[Telegram] Mensaje sin contenido soportado ignorado. chat=${msg.chat?.id}`,
      );
      return null;
    }

    const remoteJid = `${msg.chat.id}@telegram`;
    const from = msg.from;
    const pushName =
      [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim() ||
      from?.username ||
      msg.chat.first_name ||
      msg.chat.username ||
      String(msg.chat.id);

    const data: WebhookDataDto = {
      key: { remoteJid, fromMe: false, id: String(msg.message_id) },
      pushName,
      status: 'RECEIVED',
      message,
      messageType,
      messageTimestamp: msg.date || Math.floor(Date.now() / 1000),
      instanceId: ctx.instanceId,
      source: 'telegram',
    };

    const dto = new WebhookBodyDto();
    dto.event = 'messages.upsert';
    dto.instance = ctx.instanceName;
    // Sentinel "telegram": indica al pipeline de envío que use el TelegramSenderAdapter.
    dto.server_url = 'telegram';
    dto.apikey = ctx.botToken;
    dto.date_time = new Date().toISOString();
    dto.destination = remoteJid;
    dto.sender = remoteJid;
    dto.data = data;

    return dto;
  }
}
