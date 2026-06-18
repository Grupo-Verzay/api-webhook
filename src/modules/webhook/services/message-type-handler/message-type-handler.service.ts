import { Injectable, Logger } from '@nestjs/common';
import { AiAgentService } from 'src/modules/ai-agent/ai-agent.service'; // Para usar OpenAI
import { WebhookDataDto } from '../../dto/webhook-body';
// refactorizacion
import axios from 'axios';
import { Buffer } from 'buffer';

const PDF_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

@Injectable()
export class MessageTypeHandlerService {
  private readonly logger = new Logger(MessageTypeHandlerService.name);

  constructor(private readonly aiAgentService: AiAgentService) {}

  private async extractPdfText(base64: string): Promise<string | null> {
    try {
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.byteLength > PDF_MAX_BYTES) {
        this.logger.warn(`[PDF] Archivo demasiado grande (${Math.round(buffer.byteLength / 1024)}KB), omitiendo extracción`);
        return null;
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string; numpages: number }>;
      const result = await pdfParse(buffer);
      const text = result.text?.replace(/\s{3,}/g, '\n').trim();
      this.logger.log(`[PDF] Extraídas ${result.numpages} páginas, ${text?.length ?? 0} caracteres`);
      return text || null;
    } catch (err: any) {
      this.logger.error(`[PDF] Error extrayendo texto: ${err?.message}`);
      return null;
    }
  }

  /**
   * Extrae el contenido real del mensaje según su tipo.
   * @param {string} messageType - Tipo de mensaje recibido.
   * @param {any} data - Objeto data recibido en el webhook.
   * @returns {Promise<string>} - El contenido extraído (texto conversacional).
   */
  async extractContentByType(
    messageType: string,
    userApiKey: string,
    data: WebhookDataDto,
    defaultAiModel: string,
    defaultProvider: string,
  ): Promise<string> {
    switch (messageType) {
      case 'conversation':
        return data?.message?.conversation ?? '';

      case 'extendedTextMessage':
        return data?.message?.extendedTextMessage?.text ?? '';

      case 'templateButtonReplyMessage':
        return (
          data?.message?.templateButtonReplyMessage?.selectedDisplayText ??
          data?.message?.templateButtonReplyMessage?.selectedId ??
          ''
        );

      case 'interactiveResponseMessage':
        return (
          data?.message?.interactiveResponseMessage?.nativeFlowResponseMessage
            ?.paramsJson ?? ''
        );

      case 'audioMessage':
        const audioUrl = data?.message?.mediaUrl;
        const audioType = data?.message?.audioMessage?.mimetype ?? '';

        if (audioUrl) {
          return await this.aiAgentService.transcribeAudio(
            audioUrl,
            audioType,
            userApiKey,
            data,
            defaultAiModel,
            defaultProvider,
          );
        }
        return '[AUDIO_MESSAGE_NOT_FOUND]';

      case 'imageMessage':
        // Baileys inyecta mediaBase64 directamente (no hay mediaUrl como en Evolution API)
        const imageBase64Direct: string | undefined = (data?.message as any)?.mediaBase64;
        const imageMimetypeDirect: string | undefined = (data?.message as any)?.mediaMimetype;

        if (imageBase64Direct) {
          return await this.aiAgentService.describeImage(
            data,
            imageBase64Direct,
            imageMimetypeDirect ?? 'image/jpeg',
            userApiKey,
            defaultAiModel,
            defaultProvider,
          );
        }

        // Evolution API: descargar desde mediaUrl
        const imageUrl = data?.message?.mediaUrl;
        if (imageUrl) {
          try {
            const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(response.data);
            const base64Image = imageBuffer.toString('base64');
            const imageType = data.message?.imageMessage?.mimetype ?? 'image/jpeg';
            return await this.aiAgentService.describeImage(
              data,
              base64Image,
              imageType,
              userApiKey,
              defaultAiModel,
              defaultProvider,
            );
          } catch (error) {
            return '[IMAGE_DOWNLOAD_FAILED]';
          }
        }
        return '[IMAGE_MESSAGE_NOT_FOUND]';

      case 'documentMessage': {
        const docMimetype: string =
          (data?.message as any)?.mediaMimetype ??
          (data?.message as any)?.documentMessage?.mimetype ?? '';
        const docName: string =
          (data?.message as any)?.documentMessage?.fileName ??
          (data?.message as any)?.documentMessage?.title ?? 'documento';
        const caption: string = (data?.message as any)?.documentMessage?.caption ?? '';
        const header = caption
          ? `[DOCUMENTO: ${docName}]\n${caption}`
          : `[DOCUMENTO: ${docName}]`;

        const isPdf = docMimetype === 'application/pdf' || docName.toLowerCase().endsWith('.pdf');

        if (isPdf) {
          // Baileys: base64 directo
          const docBase64Direct: string | undefined = (data?.message as any)?.mediaBase64;
          if (docBase64Direct) {
            const text = await this.extractPdfText(docBase64Direct);
            return text ? `${header}\n\n${text}` : `${header}\n[No se pudo extraer texto del PDF]`;
          }

          // Evolution API: descargar desde mediaUrl
          const docUrl: string | undefined = data?.message?.mediaUrl;
          if (docUrl) {
            try {
              const response = await axios.get(docUrl, { responseType: 'arraybuffer' });
              const base64 = Buffer.from(response.data).toString('base64');
              const text = await this.extractPdfText(base64);
              return text ? `${header}\n\n${text}` : `${header}\n[No se pudo extraer texto del PDF]`;
            } catch {
              return `${header}\n[Error descargando el PDF]`;
            }
          }
        }

        // Documento no-PDF o sin descarga disponible: devolver nombre y caption
        return header || '[DOCUMENTO]';
      }

      default:
        return '[UNKNOWN_MESSAGE_TYPE]';
    }
  }
}
