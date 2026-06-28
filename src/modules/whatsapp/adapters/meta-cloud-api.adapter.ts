import { Injectable, Logger } from '@nestjs/common';
import { IWhatsAppSender } from '../interfaces/whatsapp-sender.interface';

const META_API_VERSION = 'v21.0';
const META_GRAPH_URL = `https://graph.facebook.com/${META_API_VERSION}`;

type MetaChannel = 'whatsapp' | 'facebook' | 'instagram';

interface NormalizedJid {
  to: string;
  channel: MetaChannel;
}

interface MetaSendResult {
  ok: boolean;
  /** Mensaje legible cuando ok=false. */
  error?: string;
  /** true si el fallo se debe a la ventana de 24h de Meta. */
  outsideWindow?: boolean;
}

export interface MetaTemplate {
  name: string;
  language: string;
  category: string;
  /** Texto del cuerpo (con placeholders {{1}}, {{2}}…). */
  bodyText: string;
  /** Cantidad de parámetros que requiere el cuerpo. */
  paramCount: number;
}

// Códigos de error de Meta que indican "fuera de la ventana de 24h".
const META_WINDOW_ERROR_CODES = new Set([131047, 131051, 470, 131026]);
const META_WINDOW_ERROR_SUBCODES = new Set([2018278]);

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
    opts?: { humanAgent?: boolean },
  ): Promise<MetaSendResult> {
    let url: string;
    let body: object;

    if (channel === 'whatsapp') {
      url = `${META_GRAPH_URL}/${serverUrl}/messages`;
      body = { messaging_product: 'whatsapp', to, ...messageBody };
    } else {
      url = `${META_GRAPH_URL}/me/messages`;
      // HUMAN_AGENT extiende la ventana a 7 días para respuestas de un agente humano.
      // RESPONSE es lo correcto para respuestas dentro de la ventana de 24h.
      body = opts?.humanAgent
        ? { recipient: { id: to }, messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT', ...messageBody }
        : { recipient: { id: to }, messaging_type: 'RESPONSE', ...messageBody };
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
        const errText = await res.text();
        const parsed = this.parseMetaError(errText);
        if (parsed.outsideWindow) {
          this.logger.warn(
            `[Meta/${channel}] Fuera de la ventana de 24h: ${parsed.error}. ` +
            `El cliente debe escribir primero${channel === 'whatsapp' ? ' o usar una plantilla aprobada' : ''}.`,
          );
        } else {
          this.logger.error(`[Meta/${channel}] API error ${res.status}: ${errText}`);
        }
        return { ok: false, error: parsed.error, outsideWindow: parsed.outsideWindow };
      }
      return { ok: true };
    } catch (e) {
      this.logger.error(`[Meta/${channel}] Request failed: ${e}`);
      return { ok: false, error: 'No se pudo contactar a la API de Meta.' };
    }
  }

  /** Interpreta el cuerpo de error de Meta y detecta el caso "fuera de ventana". */
  private parseMetaError(errText: string): { error: string; outsideWindow: boolean } {
    try {
      const json = JSON.parse(errText);
      const err = json?.error ?? {};
      const code = Number(err?.code);
      const subcode = Number(err?.error_subcode);
      const outsideWindow =
        META_WINDOW_ERROR_CODES.has(code) || META_WINDOW_ERROR_SUBCODES.has(subcode);
      const message = err?.message || err?.error_user_msg || 'Error de la API de Meta.';
      return { error: message, outsideWindow };
    } catch {
      return { error: 'Error de la API de Meta.', outsideWindow: false };
    }
  }

  async sendText(
    _instanceName: string,
    remoteJid: string,
    text: string,
    serverUrl?: string,
    apikey?: string,
  ): Promise<boolean> {
    const res = await this.sendTextDetailed(_instanceName, remoteJid, text, serverUrl, apikey);
    return res.ok;
  }

  /**
   * Envía texto y devuelve el resultado detallado (motivo de error / fuera de ventana).
   * @param opts.humanAgent en Messenger/Instagram usa la etiqueta HUMAN_AGENT
   *        (respuesta de agente humano; extiende la ventana a 7 días).
   */
  async sendTextDetailed(
    _instanceName: string,
    remoteJid: string,
    text: string,
    serverUrl?: string,
    apikey?: string,
    opts?: { humanAgent?: boolean },
  ): Promise<MetaSendResult> {
    this.requireCredentials(serverUrl, apikey);
    const { to, channel } = this.normalizeJid(remoteJid);

    const messageBody = channel === 'whatsapp'
      ? { type: 'text', text: { preview_url: false, body: text } }
      : { message: { text } };

    return this.post(serverUrl!, apikey!, to, channel, messageBody, opts);
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
      const res = await this.post(serverUrl!, apikey!, to, channel, {
        message: {
          attachment: { type: attType, payload: { url: mediaUrl, is_reusable: true } },
        },
      });
      return res.ok;
    }

    const metaType = type === 'image' ? 'image'
      : type === 'video' ? 'video'
      : type === 'document' ? 'document'
      : 'image';

    const res = await this.post(serverUrl!, apikey!, to, channel, {
      type: metaType,
      [metaType]: { link: mediaUrl, caption },
    });
    return res.ok;
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

    const res = await this.post(serverUrl!, apikey!, to, channel, messageBody);
    return res.ok;
  }

  /* ── Plantillas de WhatsApp Cloud ── */

  /** Lista las plantillas APROBADAS de la WABA. */
  async listApprovedTemplates(wabaId: string, accessToken: string): Promise<MetaTemplate[]> {
    if (!wabaId || !accessToken) return [];
    try {
      const url = `${META_GRAPH_URL}/${wabaId}/message_templates?status=APPROVED&limit=200`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) {
        this.logger.error(`[Meta/templates] error ${res.status}: ${await res.text()}`);
        return [];
      }
      const json = await res.json();
      const items: any[] = json?.data ?? [];
      return items.map((t) => {
        const body = (t.components ?? []).find((c: any) => c.type === 'BODY');
        const bodyText: string = body?.text ?? '';
        const matches = bodyText.match(/\{\{\s*\d+\s*\}\}/g) ?? [];
        return {
          name: t.name,
          language: t.language,
          category: t.category,
          bodyText,
          paramCount: matches.length,
        } as MetaTemplate;
      });
    } catch (e) {
      this.logger.error(`[Meta/templates] request failed: ${e}`);
      return [];
    }
  }

  /** Envía un mensaje de plantilla (permitido fuera de la ventana de 24h). */
  async sendTemplate(
    phoneNumberId: string,
    accessToken: string,
    remoteJid: string,
    templateName: string,
    languageCode: string,
    bodyParams: string[] = [],
  ): Promise<MetaSendResult> {
    this.requireCredentials(phoneNumberId, accessToken);
    const { to } = this.normalizeJid(remoteJid);

    const components =
      bodyParams.length > 0
        ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
        : [];

    return this.post(phoneNumberId, accessToken, to, 'whatsapp', {
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length ? { components } : {}),
      },
    });
  }
}
