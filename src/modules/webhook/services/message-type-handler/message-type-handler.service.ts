import { Injectable, Logger } from '@nestjs/common';
import { AiAgentService } from 'src/modules/ai-agent/ai-agent.service'; // Para usar OpenAI
import { WebhookDataDto } from '../../dto/webhook-body';
import { MediaStorageService } from 'src/modules/whatsapp/adapters/baileys/media-storage.service';
// refactorizacion
import axios from 'axios';
import { Buffer } from 'buffer';
import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const PDF_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
  'application/pdf': 'pdf',
};

@Injectable()
export class MessageTypeHandlerService {
  private readonly logger = new Logger(MessageTypeHandlerService.name);

  constructor(
    private readonly aiAgentService: AiAgentService,
    private readonly mediaStorage: MediaStorageService,
  ) {}

  /**
   * Descarga el media y, además, lo sube a almacenamiento para poder mostrarlo en
   * el panel. Deja la URL pública en `data.message.mediaUrl` (reemplaza el esquema
   * interno telegram-file:// / meta-media://). La subida es best-effort.
   */
  private async storeIncomingMedia(
    base64: string,
    mimetype: string,
    data: WebhookDataDto,
  ): Promise<void> {
    try {
      const buffer = Buffer.from(base64, 'base64');
      const ext = MIME_EXT[mimetype] || (mimetype.split('/')[1] ?? 'bin');
      const instanceName = data?.instanceId || 'channel';
      const jid = (data?.key?.remoteJid || 'chat').replace(/[@:]/g, '_');
      const key = `incoming/${instanceName}/${jid}/${data?.key?.id ?? Date.now()}.${ext}`;
      const url = await this.mediaStorage.uploadBuffer(buffer, key, mimetype || 'application/octet-stream');
      if (data.message) (data.message as any).mediaUrl = url;
    } catch (err: any) {
      this.logger.warn(`[Media] No se pudo almacenar el media entrante: ${err?.message}`);
    }
  }

  /** Parsea un esquema interno `xxx://<id>?token=<token>` → { id, token }. */
  private parseInternalMediaUrl(mediaUrl: string, scheme: string): { id: string; token: string } | null {
    const withoutScheme = mediaUrl.slice(scheme.length);
    const sep = withoutScheme.indexOf('?token=');
    if (sep === -1) return null;
    return {
      id: withoutScheme.slice(0, sep),
      token: withoutScheme.slice(sep + '?token='.length),
    };
  }

  /**
   * Resuelve `telegram-file://<file_id>?token=<botToken>` a la URL de descarga
   * real de Telegram vía getFile.
   */
  private async resolveTelegramFileUrl(mediaUrl: string): Promise<string | undefined> {
    const parsed = this.parseInternalMediaUrl(mediaUrl, 'telegram-file://');
    if (!parsed) {
      this.logger.warn(`[Telegram] mediaUrl malformada: ${mediaUrl.slice(0, 40)}...`);
      return undefined;
    }
    try {
      const info = await axios.get(`https://api.telegram.org/bot${parsed.token}/getFile`, {
        params: { file_id: parsed.id },
      });
      const filePath = info.data?.result?.file_path;
      if (!filePath) {
        this.logger.warn(`[Telegram] getFile sin file_path para ${parsed.id}`);
        return undefined;
      }
      return `https://api.telegram.org/file/bot${parsed.token}/${filePath}`;
    } catch (err: any) {
      this.logger.error(`[Telegram] Error en getFile: ${err?.message}`);
      return undefined;
    }
  }

  /**
   * Descarga un medio entrante y lo devuelve en base64, sin importar el canal:
   * - `telegram-file://` → getFile + descarga directa.
   * - `meta-media://`    → Graph API en 2 pasos con Bearer (WhatsApp Cloud).
   * - URL http(s)        → descarga directa (Evolution, Facebook/Instagram CDN).
   */
  private async fetchMediaAsBase64(
    mediaUrl?: string,
  ): Promise<{ base64: string; mimetype: string } | null> {
    if (!mediaUrl) return null;
    try {
      // Telegram
      if (mediaUrl.startsWith('telegram-file://')) {
        const real = await this.resolveTelegramFileUrl(mediaUrl);
        if (!real) return null;
        const res = await axios.get(real, { responseType: 'arraybuffer' });
        return {
          base64: Buffer.from(res.data).toString('base64'),
          mimetype: (res.headers['content-type'] as string) ?? '',
        };
      }

      // Meta WhatsApp Cloud: flujo Graph de 2 pasos, ambos con Bearer.
      if (mediaUrl.startsWith('meta-media://')) {
        const parsed = this.parseInternalMediaUrl(mediaUrl, 'meta-media://');
        if (!parsed) {
          this.logger.warn(`[Meta] mediaUrl malformada: ${mediaUrl.slice(0, 40)}...`);
          return null;
        }
        const auth = { Authorization: `Bearer ${parsed.token}` };
        const meta = await axios.get(`https://graph.facebook.com/v21.0/${parsed.id}`, { headers: auth });
        const downloadUrl: string | undefined = meta.data?.url;
        const mimeType: string = meta.data?.mime_type ?? '';
        if (!downloadUrl) {
          this.logger.warn(`[Meta] Sin url de descarga para media ${parsed.id}`);
          return null;
        }
        const bin = await axios.get(downloadUrl, { responseType: 'arraybuffer', headers: auth });
        return {
          base64: Buffer.from(bin.data).toString('base64'),
          mimetype: mimeType || ((bin.headers['content-type'] as string) ?? ''),
        };
      }

      // URL directa (Evolution, Facebook/Instagram)
      const res = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
      return {
        base64: Buffer.from(res.data).toString('base64'),
        mimetype: (res.headers['content-type'] as string) ?? '',
      };
    } catch (err: any) {
      this.logger.error(`[Media] Error descargando media: ${err?.message}`);
      return null;
    }
  }

  /**
   * Extrae la pista de audio de un video (vía ffmpeg) y la devuelve como MP3 base64
   * para transcribir. Best-effort: si ffmpeg falla, devuelve null.
   */
  private async extractAudioFromVideo(
    videoBase64: string,
    ext = 'mp4',
  ): Promise<{ base64: string; mimetype: string } | null> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegPath = require('ffmpeg-static') as string | null;
    if (!ffmpegPath) {
      this.logger.warn('[Video] ffmpeg no disponible; se omite la transcripción.');
      return null;
    }

    const tmpIn = join(tmpdir(), `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);
    try {
      await writeFile(tmpIn, Buffer.from(videoBase64, 'base64'));
      const audioBuffer = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const errChunks: string[] = [];
        const proc = spawn(ffmpegPath, [
          '-i', tmpIn,
          '-vn',                 // sin video
          '-ac', '1',            // mono
          '-ar', '16000',        // 16 kHz (óptimo para Whisper)
          '-c:a', 'libmp3lame',
          '-f', 'mp3',
          'pipe:1',
        ]);
        proc.stdout.on('data', (d: Buffer) => chunks.push(d));
        proc.stderr.on('data', (d: Buffer) => errChunks.push(d.toString()));
        proc.on('error', reject);
        proc.on('close', (code) =>
          code === 0
            ? resolve(Buffer.concat(chunks))
            : reject(new Error(errChunks.join('').slice(-400))),
        );
      });
      if (!audioBuffer.length) return null;
      return { base64: audioBuffer.toString('base64'), mimetype: 'audio/mpeg' };
    } catch (err: any) {
      this.logger.error(`[Video] Error extrayendo audio: ${err?.message}`);
      return null;
    } finally {
      void unlink(tmpIn).catch(() => {});
    }
  }

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

      case 'audioMessage': {
        // Baileys entrega base64 directo; otros canales se descargan.
        const audioBase64Direct: string | undefined = (data?.message as any)?.mediaBase64;
        let audioBase64 = audioBase64Direct;
        let audioType =
          data?.message?.audioMessage?.mimetype ??
          (data?.message as any)?.mediaMimetype ?? '';

        if (!audioBase64) {
          const media = await this.fetchMediaAsBase64(data?.message?.mediaUrl);
          if (media) {
            audioBase64 = media.base64;
            audioType = audioType || media.mimetype;
            await this.storeIncomingMedia(media.base64, audioType || 'audio/ogg', data);
          }
        }

        if (audioBase64) {
          return await this.aiAgentService.transcribeAudioFromBase64(
            audioBase64,
            audioType,
            userApiKey,
            defaultAiModel,
            defaultProvider,
          );
        }
        return '[AUDIO_MESSAGE_NOT_FOUND]';
      }

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

        // Evolution / Telegram / Meta: descargar desde mediaUrl
        if (data?.message?.mediaUrl) {
          const media = await this.fetchMediaAsBase64(data.message.mediaUrl);
          if (!media) return '[IMAGE_DOWNLOAD_FAILED]';
          const imageType = data.message?.imageMessage?.mimetype || media.mimetype || 'image/jpeg';
          await this.storeIncomingMedia(media.base64, imageType, data);
          return await this.aiAgentService.describeImage(
            data,
            media.base64,
            imageType,
            userApiKey,
            defaultAiModel,
            defaultProvider,
          );
        }
        return '[IMAGE_MESSAGE_NOT_FOUND]';

      case 'videoMessage': {
        const caption = (data?.message?.conversation ?? '').trim();
        if (!data?.message?.mediaUrl) return caption || '[Video recibido]';

        const media = await this.fetchMediaAsBase64(data.message.mediaUrl);
        if (!media) return caption || '[Video recibido]';

        // Guardar el video para mostrarlo en el panel.
        const videoMime = data.message?.imageMessage?.mimetype || media.mimetype || 'video/mp4';
        await this.storeIncomingMedia(media.base64, videoMime, data);

        // Extraer el audio y transcribirlo (la IA "entiende" el video hablado).
        const ext = MIME_EXT[videoMime] || 'mp4';
        const audio = await this.extractAudioFromVideo(media.base64, ext);
        if (!audio) return caption || '[Video recibido]';

        const transcript = await this.aiAgentService.transcribeAudioFromBase64(
          audio.base64,
          audio.mimetype,
          userApiKey,
          defaultAiModel,
          defaultProvider,
        );
        const clean = transcript && !transcript.startsWith('[') ? transcript.trim() : '';
        if (caption && clean) return `${caption}\n\n[Transcripción del video]: ${clean}`;
        if (clean) return `[Transcripción del video]: ${clean}`;
        return caption || '[Video recibido]';
      }

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

          // Evolution / Telegram / Meta: descargar desde mediaUrl
          if (data?.message?.mediaUrl) {
            const media = await this.fetchMediaAsBase64(data.message.mediaUrl);
            if (!media) return `${header}\n[Error descargando el PDF]`;
            await this.storeIncomingMedia(media.base64, docMimetype || media.mimetype || 'application/pdf', data);
            const text = await this.extractPdfText(media.base64);
            return text ? `${header}\n\n${text}` : `${header}\n[No se pudo extraer texto del PDF]`;
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
