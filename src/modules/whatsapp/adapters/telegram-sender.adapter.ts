import { Injectable, Logger } from '@nestjs/common';
import { IWhatsAppSender } from '../interfaces/whatsapp-sender.interface';

const TELEGRAM_API_URL = 'https://api.telegram.org';

/**
 * Adaptador de envío para Telegram Bot API.
 *
 * Reutiliza la interfaz común `IWhatsAppSender`:
 * - `serverUrl` se ignora (se usa el sentinel "telegram" en el pipeline).
 * - `apikey` es el bot token (`123456:ABC-DEF...`).
 * - `remoteJid` tiene el formato `${chatId}@telegram`.
 */
@Injectable()
export class TelegramSenderAdapter implements IWhatsAppSender {
  private readonly logger = new Logger(TelegramSenderAdapter.name);

  private requireToken(apikey?: string): void {
    if (!apikey) {
      throw new Error('Telegram Bot API requiere el bot token (apikey).');
    }
  }

  /** Extrae el chat_id del remoteJid (`${chatId}@telegram`). */
  private chatId(remoteJid: string): string {
    return remoteJid.replace(/@telegram$/, '').trim();
  }

  private async post(
    botToken: string,
    method: string,
    body: object,
  ): Promise<boolean> {
    const url = `${TELEGRAM_API_URL}/bot${botToken}/${method}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        this.logger.error(`[Telegram] ${method} error ${res.status}: ${err}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger.error(`[Telegram] ${method} request failed: ${e}`);
      return false;
    }
  }

  async sendText(
    _instanceName: string,
    remoteJid: string,
    text: string,
    _serverUrl?: string,
    apikey?: string,
  ): Promise<boolean> {
    this.requireToken(apikey);
    // Sin parse_mode: el texto del agente usa formato estilo WhatsApp (*negrita*),
    // que no coincide con el Markdown de Telegram. Se envía como texto plano.
    return this.post(apikey!, 'sendMessage', {
      chat_id: this.chatId(remoteJid),
      text,
    });
  }

  async sendMedia(
    _instanceName: string,
    remoteJid: string,
    type: string,
    caption: string,
    mediaUrl: string,
    _serverUrl?: string,
    apikey?: string,
  ): Promise<boolean> {
    this.requireToken(apikey);
    const chat_id = this.chatId(remoteJid);

    const t = type.toLowerCase();
    if (t === 'image') {
      return this.post(apikey!, 'sendPhoto', { chat_id, photo: mediaUrl, caption });
    }
    if (t === 'video') {
      return this.post(apikey!, 'sendVideo', { chat_id, video: mediaUrl, caption });
    }
    if (t === 'audio') {
      return this.post(apikey!, 'sendAudio', { chat_id, audio: mediaUrl, caption });
    }
    // documento y cualquier otro tipo
    return this.post(apikey!, 'sendDocument', { chat_id, document: mediaUrl, caption });
  }

  async sendAudio(
    _instanceName: string,
    remoteJid: string,
    audioUrl: string,
    _serverUrl?: string,
    apikey?: string,
  ): Promise<boolean> {
    this.requireToken(apikey);
    // sendVoice espera una URL/archivo OGG. Para notas de voz del agente.
    return this.post(apikey!, 'sendVoice', {
      chat_id: this.chatId(remoteJid),
      voice: audioUrl,
    });
  }
}
