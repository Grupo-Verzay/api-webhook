import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { delay, firstValueFrom } from 'rxjs';
import { LoggerService } from 'src/core/logger/logger.service';

@Injectable()
export class NodeSenderService {
  constructor(
    private readonly http: HttpService,
    private readonly logger: LoggerService,
  ) { }

  /**
   * Send message type text
   *
   * @param {string} url - `${urlevo}/message/sendText/${instanceName}`.
   * @param {string} apikey - 32900F6F-2692-4B41-A037-57BEF8717B26.
   * @param {string} remoteJid - 573107964105@s.whatsapp.net.
   * @param {string} text - message.
   * @returns {void} - Nombre del flujo a ejecutar o null si no se debe ejecutar.
   */
  async sendTextNode(url: string, apikey: string, remoteJid: string, text: string) {
    try {
      const body = {
        number: remoteJid,
        delay: 400,
        // options: { delay: 100, presence: 'composing' },
        text,
      };

      // this.logger.log(`Enviando texto a ${remoteJid}: "${text}"`, 'NodeSenderService');
      this.logger.log(`Enviando texto a ${remoteJid}`, 'NodeSenderService');

      const response = await firstValueFrom(
        this.http.post(url, body, {
          headers: { 'Content-Type': 'application/json', apikey },
        }),
      );

      // this.logger.log(`Respuesta ${remoteJid}: ${JSON.stringify(response.data)}`, 'NodeSenderService');
    } catch (error) {
      this.logger.error(`Error enviando texto a ${remoteJid}`, error?.response?.data || error.message, 'NodeSenderService');
    }
  }

  // async sendTextNode(url: string, apikey: string, remoteJid: string, text: string) {
  //   try {
  //     const bloques = text
  //       .split('\n\n')
  //       .map((b) => b.trim())
  //       .filter((b) => b.length > 0);

  //     if (bloques.length === 0) {
  //       this.logger.warn(`El mensaje está vacío después de procesar bloques para ${remoteJid}`, 'NodeSenderService');
  //       return;
  //     }

  //     for (const [index, bloque] of bloques.entries()) {
  //       const body = {
  //         number: remoteJid,
  //         delay: 1200,
  //         text: bloque,
  //       };

  //       this.logger.log(`📤 Enviando bloque ${index + 1}/${bloques.length} a ${remoteJid}: "${bloque}"`, 'NodeSenderService');

  //       const response = await firstValueFrom(
  //         this.http.post(url, body, {
  //           headers: { 'Content-Type': 'application/json', apikey },
  //         }),
  //       );

  //       this.logger.log(`✅ Respuesta bloque ${index + 1}: ${JSON.stringify(response.data)}`, 'NodeSenderService');

  //       await new Promise((res) => setTimeout(res, 1200)); // delay entre mensajes
  //     }
  //   } catch (error) {
  //     this.logger.error(`❌ Error enviando texto a ${remoteJid}`, error?.response?.data || error.message, 'NodeSenderService');
  //   }
  // }

  /**
   * Envía un nodo multimedia (imagen, video o documento) y registra la respuesta.
   */
  async   sendMediaNode(
    url: string,
    apikey: string,
    remoteJid: string,
    type: string,
    caption: string,
    mediaUrl: string,
  ) {
    try {
      const mimeMap = {
        image: 'image/png',
        video: 'video/mp4',
        document: 'application/pdf',
        audio: 'audio/mpeg',
        text: 'text/plain',
      };

      const mimetype = mimeMap[type.toLowerCase()] || 'application/octet-stream';
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

      // this.logger.log(
      //   `Enviando ${type} a ${remoteJid} con mimetype: ${mimetype}, caption: "${caption}" y mediaURL: ${mediaUrl}`,
      //   'NodeSenderService',
      // );

      const response = await firstValueFrom(
        this.http.post(url, body, {
          headers: { 'Content-Type': 'application/json', apikey },
        }),
      );

      // this.logger.log(
      //   `Respuesta del ${type} a ${remoteJid}: ${JSON.stringify(response.data)}`,
      //   'NodeSenderService',
      // );
    } catch (error) {
      this.logger.error(
        `Error enviando ${type} a ${remoteJid}`,
        error?.response?.data || error.message,
        'NodeSenderService',
      );
    }
  }

    /**
   * Envía un audio de WhatsApp usando el endpoint sendWhatsAppAudio.
   *
   * @param {string} url - `${urlevo}/message/sendWhatsAppAudio/${instanceName}`.
   * @param {string} apikey - API Key de Evolution.
   * @param {string} remoteJid - 573107964105@s.whatsapp.net (o solo número, según lo que ya uses).
   * @param {string} audioUrl - URL o base64 del audio.
   */
  async sendAudioNode(
    url: string,
    apikey: string,
    remoteJid: string,
    audioUrl: string,
  ) {
    try {
      const body = {
        // Mantenemos el mismo formato que ya usas para "number"
        // (si hoy remoteJid funciona en sendText, lo dejamos igual para no romper nada)
        number: remoteJid,
        audio: audioUrl,   // url o base64
        delay: 1200,       // opcional, mismo criterio que en sendMediaNode
      };

      this.logger.log(
        `Enviando audio a ${remoteJid} (media: ${audioUrl})`,
        'NodeSenderService',
      );

      const response = await firstValueFrom(
        this.http.post(url, body, {
          headers: { 'Content-Type': 'application/json', apikey },
        }),
      );

      // Si quieres loggear la respuesta, descomenta:
      // this.logger.log(
      //   `Respuesta del audio a ${remoteJid}: ${JSON.stringify(response.data)}`,
      //   'NodeSenderService',
      // );
    } catch (error) {
      this.logger.error(
        `Error enviando audio a ${remoteJid}`,
        error?.response?.data || error.message,
        'NodeSenderService',
      );
    }
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