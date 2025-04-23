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
   * Envía un nodo de texto al cliente y registra la respuesta.
   */
  async sendTextNode(url: string, apikey: string, remoteJid: string, text: string) {
    try {
      const body = {
        number: remoteJid,
        delay: 1200,
        // options: { delay: 100, presence: 'composing' },
        text,
      };

      this.logger.log(`Enviando texto a ${remoteJid}: "${text}"`, 'NodeSenderService');

      const response = await firstValueFrom(
        this.http.post(url, body, {
          headers: { 'Content-Type': 'application/json', apikey },
        }),
      );

      this.logger.log(`Respuesta del texto a ${remoteJid}: ${JSON.stringify(response.data)}`, 'NodeSenderService');
    } catch (error) {
      this.logger.error(`Error enviando texto a ${remoteJid}`, error?.response?.data || error.message, 'NodeSenderService');
    }
  }

  /**
   * Envía un nodo multimedia (imagen, video o documento) y registra la respuesta.
   */
  async sendMediaNode(
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
   *  Extrae el nombre del documento basado en el mediaUrl
   */
  private extractFilenameFromUrl(url: string): string | null {
    const match = url.match(/([^/-]+-[^/-]+-[^/-]+\.(?:pdf|xlsx|docx))$/i);
    return match ? match[1] : null;
  }
}