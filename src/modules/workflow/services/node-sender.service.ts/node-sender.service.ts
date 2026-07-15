import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { delay, firstValueFrom } from 'rxjs';
import { LoggerService } from 'src/core/logger/logger.service';

@Injectable()
export class NodeSenderService {
  constructor(
    private readonly http: HttpService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Send message type text
   *
   * @param {string} url - `${urlevo}/message/sendText/${instanceName}`.
   * @param {string} apikey - 32900F6F-2692-4B41-A037-57BEF8717B26.
   * @param {string} remoteJid - 573107964105@s.whatsapp.net.
   * @param {string} text - message.
   * @returns {void} - Nombre del flujo a ejecutar o null si no se debe ejecutar.
   */
  async sendTextNode(
    url: string,
    apikey: string,
    remoteJid: string,
    text: string,
  ) {
    try {
      const typingDelay = Math.min(Math.max(text.length * 30, 1500), 6000);
      const body = {
        number: remoteJid,
        delay: typingDelay,
        text,
      };

      this.logger.log(`Enviando texto a ${remoteJid} | chars=${text.length} | typingDelay=${typingDelay}ms`, 'NodeSenderService');

      const response = await firstValueFrom(
        this.http.post(url, body, {
          headers: { 'Content-Type': 'application/json', apikey },
        }),
      );

      // this.logger.log(`Respuesta ${remoteJid}: ${JSON.stringify(response.data)}`, 'NodeSenderService');
      return true;
    } catch (error) {
      this.logger.error(
        `Error enviando texto a ${remoteJid}`,
        error?.response?.data || error.message,
        'NodeSenderService',
      );
      return false;
    }
  }

  /**
   * Igual que sendTextNode pero devuelve el messageId del envío (key.id de
   * Evolution), para correlacionar luego una respuesta CITADA. null si falla.
   */
  async sendTextNodeReturnId(
    url: string,
    apikey: string,
    remoteJid: string,
    text: string,
  ): Promise<string | null> {
    try {
      const typingDelay = Math.min(Math.max(text.length * 30, 1500), 6000);
      const body = { number: remoteJid, delay: typingDelay, text };
      const response = await firstValueFrom(
        this.http.post(url, body, {
          headers: { 'Content-Type': 'application/json', apikey },
        }),
      );
      return response?.data?.key?.id ?? null;
    } catch (error) {
      this.logger.error(
        `Error enviando texto (returnId) a ${remoteJid}`,
        error?.response?.data || error.message,
        'NodeSenderService',
      );
      return null;
    }
  }

  /**
   * Envía un nodo multimedia (imagen, video o documento) y registra la respuesta.
   */
  // Devuelve { ok, id } con el messageId REAL de Evolution para poder persistir el
  // saliente (marcado como Agente IA) sin duplicar. `ok` conserva la semántica del
  // boolean previo (éxito = no lanzó), independiente de si vino id.
  async sendMediaNodeWithId(
    url: string,
    apikey: string,
    remoteJid: string,
    type: string,
    caption: string,
    mediaUrl: string,
  ): Promise<{ ok: boolean; id: string | null }> {
    try {
      const mimeMap = {
        image: 'image/png',
        video: 'video/mp4',
        document: 'application/pdf',
        audio: 'audio/mpeg',
        text: 'text/plain',
      };

      const mimetype =
        mimeMap[type.toLowerCase()] || 'application/octet-stream';
      const filename = this.extractFilenameFromUrl(mediaUrl);

      const body = {
        number: remoteJid,
        mediatype: type,
        mimetype,
        caption,
        media: mediaUrl,
        fileName: type === 'document' ? filename : '',
        delay: 1200,
      };

      const response = await firstValueFrom(
        this.http.post(url, body, {
          headers: { 'Content-Type': 'application/json', apikey },
        }),
      );

      return { ok: true, id: response?.data?.key?.id ?? null };
    } catch (error) {
      this.logger.error(
        `Error enviando ${type} a ${remoteJid}`,
        error?.response?.data || error.message,
        'NodeSenderService',
      );
      return { ok: false, id: null };
    }
  }

  /** Contrato previo (boolean): delega en sendMediaNodeWithId. */
  async sendMediaNode(
    url: string,
    apikey: string,
    remoteJid: string,
    type: string,
    caption: string,
    mediaUrl: string,
  ): Promise<boolean> {
    return (await this.sendMediaNodeWithId(url, apikey, remoteJid, type, caption, mediaUrl)).ok;
  }

  /**
   * Envía un audio de WhatsApp usando el endpoint sendWhatsAppAudio.
   *
   * @param {string} url - `${urlevo}/message/sendWhatsAppAudio/${instanceName}`.
   * @param {string} apikey - API Key de Evolution.
   * @param {string} remoteJid - 573107964105@s.whatsapp.net (o solo número, según lo que ya uses).
   * @param {string} audioUrl - URL o base64 del audio.
   */
  // Igual que sendAudioNode pero devolviendo { ok, id } con el messageId REAL para
  // persistir el saliente (Agente IA) sin duplicar.
  async sendAudioNodeWithId(
    url: string,
    apikey: string,
    remoteJid: string,
    audioUrl: string,
  ): Promise<{ ok: boolean; id: string | null }> {
    try {
      const body = {
        // Mantenemos el mismo formato que ya usas para "number"
        // (si hoy remoteJid funciona en sendText, lo dejamos igual para no romper nada)
        number: remoteJid,
        audio: audioUrl, // url o base64
        delay: 1200, // opcional, mismo criterio que en sendMediaNode
      };

      this.logger.log(
        `Enviando audio a ${remoteJid} (base64: ${audioUrl.substring(0, 20)}...)`,
        'NodeSenderService',
      );

      const response = await firstValueFrom(
        this.http.post(url, body, {
          headers: { 'Content-Type': 'application/json', apikey },
        }),
      );

      return { ok: true, id: response?.data?.key?.id ?? null };
    } catch (error) {
      this.logger.error(
        `Error enviando audio a ${remoteJid}`,
        error?.response?.data || error.message,
        'NodeSenderService',
      );
      return { ok: false, id: null };
    }
  }

  /** Contrato previo (boolean): delega en sendAudioNodeWithId. */
  async sendAudioNode(
    url: string,
    apikey: string,
    remoteJid: string,
    audioUrl: string,
  ): Promise<boolean> {
    return (await this.sendAudioNodeWithId(url, apikey, remoteJid, audioUrl)).ok;
  }

  /**
   *  Extrae el nombre del documento basado en el mediaUrl
   */
  private extractFilenameFromUrl(url: string): string | null {
    // Extrae el último segmento de la URL
    const filename = url.split('/').pop();
    if (!filename) return null;

    // Divide por guiones y elimina los primeros 3 segmentos (UUID)
    const parts = filename.split('-');
    if (parts.length <= 3) return filename; // Si no hay suficientes partes, devuelve el nombre completo

    return parts.slice(3).join('-');
  }
}
