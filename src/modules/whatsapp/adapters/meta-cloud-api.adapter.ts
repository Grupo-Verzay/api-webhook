import { Injectable, Logger } from '@nestjs/common';
import { IWhatsAppSender } from '../interfaces/whatsapp-sender.interface';

const META_API_VERSION = 'v21.0';
const META_GRAPH_URL = `https://graph.facebook.com/${META_API_VERSION}`;

type MetaChannel = 'whatsapp' | 'facebook' | 'instagram';

interface NormalizedJid {
  to: string;
  channel: MetaChannel;
}

@Injectable()
export class MetaCloudApiSenderAdapter implements IWhatsAppSender {
  private readonly logger = new Logger(MetaCloudApiSenderAdapter.name);

  private requireCredentials(serverUrl?: string, accessToken?: string): void {
    if (!serverUrl || !accessToken) {
      throw new Error('Meta Cloud API requiere serverUrl y accessToken.');
    }
  }

  /** Extrae el ID del destinatario y determina el canal según el sufijo del remoteJid. */
  private normalizeJid(remoteJid: string): NormalizedJid {
    if (remoteJid.endsWith('@messenger')) {
      return { to: remoteJid.replace('@messenger', ''), channel: 'facebook' };
    }
    if (remoteJid.endsWith('@instagram')) {
      return { to: remoteJid.replace('@instagram', ''), channel: 'instagram' };
    }
    // WhatsApp: strip suffix y deja solo dígitos
    return {
      to: remoteJid.replace(/@s\.whatsapp\.net$|@g\.us$|@lid$/, '').replace(/[^0-9]/g, ''),
      channel: 'whatsapp',
    };
  }

  /**
   * Envía la petición a Graph API.
   * - WhatsApp: POST /{phoneNumberId}/messages con messaging_product="whatsapp"
   * - Facebook/Instagram: POST /me/messages con recipient y messaging_type="RESPONSE"
   */
  private async post(
    serverUrl: string,
    accessToken: string,
    to: string,
    channel: MetaChannel,
    messageBody: object,
  ): Promise<boolean> {
    let url: string;
    let body: object;

    if (channel === 'whatsapp') {
      url = `${META_GRAPH_URL}/${serverUrl}/messages`;
      body = { messaging_product: 'whatsapp', to, ...messageBody };
    } else {
      url = `${META_GRAPH_URL}/me/messages`;
      body = {
        recipient: { id: to },
        messaging_type: 'RESPONSE',
        ...messageBody,
      };
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        this.logger.error(`[Meta/${channel}] API error ${res.status}: ${err}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger.error(`[Meta/${channel}] Request failed: ${e}`);
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
    const { to, channel } = this.normalizeJid(remoteJid);

    const messageBody = channel === 'whatsapp'
      ? { type: 'text', text: { preview_url: false, body: text } }
      : { message: { text } };

    return this.post(serverUrl!, apikey!, to, channel, messageBody);
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
    const { to, channel } = this.normalizeJid(remoteJid);

    if (channel !== 'whatsapp') {
      // Messenger/Instagram: enviar como attachment
      const attType = type === 'image' ? 'image' : type === 'video' ? 'video' : 'file';
      return this.post(serverUrl!, apikey!, to, channel, {
        message: {
          attachment: { type: attType, payload: { url: mediaUrl, is_reusable: true } },
        },
      });
    }

    const metaType = type === 'image' ? 'image'
      : type === 'video' ? 'video'
      : type === 'document' ? 'document'
      : 'image';

    return this.post(serverUrl!, apikey!, to, channel, {
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
    const { to, channel } = this.normalizeJid(remoteJid);

    const messageBody = channel === 'whatsapp'
      ? { type: 'audio', audio: { link: audioUrl } }
      : { message: { attachment: { type: 'audio', payload: { url: audioUrl, is_reusable: true } } } };

    return this.post(serverUrl!, apikey!, to, channel, messageBody);
  }
}
