import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { IWhatsAppSender } from '../../interfaces/whatsapp-sender.interface';
import { BaileysSessionManager } from './baileys-session.manager';

@Injectable()
export class BaileysSenderAdapter implements IWhatsAppSender {
  constructor(
    private readonly sessions: BaileysSessionManager,
    private readonly logger: LoggerService,
  ) {}

  async sendText(instanceName: string, remoteJid: string, text: string): Promise<boolean> {
    const socket = this.sessions.getSocket(instanceName);
    if (!socket) {
      this.logger.warn(`[Baileys] Sin socket activo para ${instanceName}`, 'BaileysSenderAdapter');
      return false;
    }
    try {
      await socket.sendMessage(remoteJid, { text });
      return true;
    } catch (err) {
      this.logger.error(`[Baileys] Error enviando texto a ${remoteJid}`, err?.message, 'BaileysSenderAdapter');
      return false;
    }
  }

  async sendMedia(instanceName: string, remoteJid: string, type: string, caption: string, mediaUrl: string): Promise<boolean> {
    const socket = this.sessions.getSocket(instanceName);
    if (!socket) {
      this.logger.warn(`[Baileys] Sin socket activo para ${instanceName}`, 'BaileysSenderAdapter');
      return false;
    }
    try {
      const typeMap: Record<string, string> = {
        image: 'image',
        video: 'video',
        document: 'document',
        audio: 'audio',
      };
      const msgType = typeMap[type.toLowerCase()] ?? 'document';
      const message: Record<string, any> = { [msgType]: { url: mediaUrl }, caption };
      await socket.sendMessage(remoteJid, message);
      return true;
    } catch (err) {
      this.logger.error(`[Baileys] Error enviando media a ${remoteJid}`, err?.message, 'BaileysSenderAdapter');
      return false;
    }
  }

  async sendAudio(instanceName: string, remoteJid: string, audioUrl: string): Promise<boolean> {
    const socket = this.sessions.getSocket(instanceName);
    if (!socket) {
      this.logger.warn(`[Baileys] Sin socket activo para ${instanceName}`, 'BaileysSenderAdapter');
      return false;
    }
    try {
      await socket.sendMessage(remoteJid, {
        audio: { url: audioUrl },
        ptt: true,
        mimetype: 'audio/ogg; codecs=opus',
      });
      return true;
    } catch (err) {
      this.logger.error(`[Baileys] Error enviando audio a ${remoteJid}`, err?.message, 'BaileysSenderAdapter');
      return false;
    }
  }
}
