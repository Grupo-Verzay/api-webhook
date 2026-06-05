import { Injectable, Logger } from '@nestjs/common';
import { IWhatsAppSender } from '../interfaces/whatsapp-sender.interface';

const META_API_VERSION = 'v21.0';
const META_GRAPH_URL = `https://graph.facebook.com/${META_API_VERSION}`;

@Injectable()
export class MetaCloudApiSenderAdapter implements IWhatsAppSender {
  private readonly logger = new Logger(MetaCloudApiSenderAdapter.name);

  private requireCredentials(phoneNumberId?: string, accessToken?: string): void {
    if (!phoneNumberId || !accessToken) {
      throw new Error('Meta Cloud API requiere phoneNumberId (serverUrl) y accessToken (apikey).');
    }
  }

  private normalizeJid(remoteJid: string): string {
    return remoteJid.replace(/@s\.whatsapp\.net$|@g\.us$|@lid$/, '').replace(/[^0-9]/g, '');
  }

  private async post(phoneNumberId: string, accessToken: string, body: object): Promise<boolean> {
    const url = `${META_GRAPH_URL}/${phoneNumberId}/messages`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
      });

      if (!res.ok) {
        const err = await res.text();
        this.logger.error(`Meta API error ${res.status}: ${err}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger.error(`Meta API request failed: ${e}`);
      return false;
    }
  }

  async sendText(
    _instanceName: string,
    remoteJid: string,
    text: string,
    serverUrl?: string,
    apikey?: string,
  ): Promise<boolean> {
    this.requireCredentials(serverUrl, apikey);
    const to = this.normalizeJid(remoteJid);
    return this.post(serverUrl!, apikey!, {
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    });
  }

  async sendMedia(
    _instanceName: string,
    remoteJid: string,
    type: string,
    caption: string,
    mediaUrl: string,
    serverUrl?: string,
    apikey?: string,
  ): Promise<boolean> {
    this.requireCredentials(serverUrl, apikey);
    const to = this.normalizeJid(remoteJid);

    const metaType = type === 'image' ? 'image'
      : type === 'video' ? 'video'
      : type === 'document' ? 'document'
      : 'image';

    return this.post(serverUrl!, apikey!, {
      to,
      type: metaType,
      [metaType]: { link: mediaUrl, caption },
    });
  }

  async sendAudio(
    _instanceName: string,
    remoteJid: string,
    audioUrl: string,
    serverUrl?: string,
    apikey?: string,
  ): Promise<boolean> {
    this.requireCredentials(serverUrl, apikey);
    const to = this.normalizeJid(remoteJid);
    return this.post(serverUrl!, apikey!, {
      to,
      type: 'audio',
      audio: { link: audioUrl },
    });
  }
}
