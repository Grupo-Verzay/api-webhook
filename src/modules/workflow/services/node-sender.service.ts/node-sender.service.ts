import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { LoggerService } from 'src/core/logger/logger.service';

@Injectable()
export class NodeSenderService {
  constructor(
    private readonly http: HttpService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Envía un nodo de texto al cliente y registra la respuesta.
   */
  async sendTextNode(url: string, apikey: string, remoteJid: string, text: string) {
    try {
      const body = {
        number: remoteJid,
        options: { delay: 100, presence: 'composing' },
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
      const body = {
        number: remoteJid,
        mediatype: type,
        mimetype: type,
        caption,
        media: mediaUrl,
      };

      this.logger.log(`Enviando ${type} a ${remoteJid} con caption: "${caption}" y mediaURL ${mediaUrl}`, 'NodeSenderService');

      const response = await firstValueFrom(
        this.http.post(url, body, {
          headers: { 'Content-Type': 'application/json', apikey },
        }),
      );

      this.logger.log(`Respuesta del ${type} a ${remoteJid}: ${JSON.stringify(response.data)}`, 'NodeSenderService');
    } catch (error) {
      this.logger.error(`Error enviando ${type} a ${remoteJid}`, error?.response?.data || error.message, 'NodeSenderService');
    }
  }
}