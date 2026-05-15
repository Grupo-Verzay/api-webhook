import { Injectable } from '@nestjs/common';
import { NodeSenderService } from 'src/modules/workflow/services/node-sender.service.ts/node-sender.service';
import { IWhatsAppSender } from '../interfaces/whatsapp-sender.interface';

@Injectable()
export class EvolutionApiSenderAdapter implements IWhatsAppSender {
  constructor(private readonly nodeSender: NodeSenderService) {}

  private requireCredentials(serverUrl?: string, apikey?: string): void {
    if (!serverUrl || !apikey) {
      throw new Error('Evolution API requiere serverUrl y apikey.');
    }
  }

  async sendText(instanceName: string, remoteJid: string, text: string, serverUrl?: string, apikey?: string): Promise<boolean> {
    this.requireCredentials(serverUrl, apikey);
    return this.nodeSender.sendTextNode(
      `${serverUrl}/message/sendText/${instanceName}`,
      apikey,
      remoteJid,
      text,
    );
  }

  async sendMedia(instanceName: string, remoteJid: string, type: string, caption: string, mediaUrl: string, serverUrl?: string, apikey?: string): Promise<boolean> {
    this.requireCredentials(serverUrl, apikey);
    return this.nodeSender.sendMediaNode(
      `${serverUrl}/message/sendMedia/${instanceName}`,
      apikey,
      remoteJid,
      type,
      caption,
      mediaUrl,
    );
  }

  async sendAudio(instanceName: string, remoteJid: string, audioUrl: string, serverUrl?: string, apikey?: string): Promise<boolean> {
    this.requireCredentials(serverUrl, apikey);
    return this.nodeSender.sendAudioNode(
      `${serverUrl}/message/sendWhatsAppAudio/${instanceName}`,
      apikey,
      remoteJid,
      audioUrl,
    );
  }
}
