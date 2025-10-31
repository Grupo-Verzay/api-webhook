import { Injectable } from '@nestjs/common';
import { AiAgentService } from 'src/modules/ai-agent/ai-agent.service'; // Para usar OpenAI
import { WebhookDataDto } from '../../dto/webhook-body';
// refactorizacion
import axios from 'axios';
import { Buffer } from 'buffer';

@Injectable()
export class MessageTypeHandlerService {
  constructor(private readonly aiAgentService: AiAgentService) { }

  /**
   * Extrae el contenido real del mensaje según su tipo.
   * @param {string} messageType - Tipo de mensaje recibido.
   * @param {any} data - Objeto data recibido en el webhook.
   * @returns {Promise<string>} - El contenido extraído (texto conversacional).
   */
  async extractContentByType(messageType: string, userApiKey: string, data: WebhookDataDto,defaultAiModel:string,defaultProvider:string): Promise<string> {

    switch (messageType) {
      case 'conversation':
        return data?.message?.conversation ?? '';

      case 'audioMessage':
        const audioUrl = data?.message?.mediaUrl;
        const audioType = data?.message?.audioMessage?.mimetype ?? ''
        
        if (audioUrl) {
          return await this.aiAgentService.transcribeAudio(audioUrl,audioType, userApiKey,data,defaultAiModel,defaultProvider);
        }
        return '[AUDIO_MESSAGE_NOT_FOUND]';

      case 'imageMessage':
        const imageUrl = data?.message?.mediaUrl;
        if (imageUrl) {
          try {
            // 1. Descargar la imagen como un 'ArrayBuffer' (datos binarios)
            const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });

            // 2. Convertir el ArrayBuffer a un Buffer de Node.js
            const imageBuffer = Buffer.from(response.data);

            // 3. Convertir el Buffer de la imagen a una cadena Base64
            const base64Image = imageBuffer.toString('base64');
            const imageType = data.message?.imageMessage?.mimetype ?? 'image/jpeg'
            // Ahora puedes usar la cadena `base64Image` con LangChain
            return await this.aiAgentService.describeImage(data, base64Image, imageType, userApiKey,defaultAiModel,defaultProvider);


          } catch (error) {
            return '[IMAGE_DOWNLOAD_FAILED]';
          }
        }
        return '[IMAGE_MESSAGE_NOT_FOUND]';

      default:
        return '[UNKNOWN_MESSAGE_TYPE]';
    }
  }
}
