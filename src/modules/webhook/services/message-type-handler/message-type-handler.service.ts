import { Injectable } from '@nestjs/common';
import { AiAgentService } from 'src/modules/ai-agent/ai-agent.service'; // Para usar OpenAI
import { WebhookDataDto } from '../../dto/webhook-body';

@Injectable()
export class MessageTypeHandlerService {
  constructor(private readonly aiAgentService: AiAgentService) { }

  /**
   * Extrae el contenido real del mensaje según su tipo.
   * @param {string} messageType - Tipo de mensaje recibido.
   * @param {any} data - Objeto data recibido en el webhook.
   * @returns {Promise<string>} - El contenido extraído (texto conversacional).
   */
  async extractContentByType(messageType: string, userApiKey: string, data: WebhookDataDto): Promise<string> {

    switch (messageType) {
      case 'conversation':
        return data?.message?.conversation ?? '';

      case 'audioMessage':
        const audioUrl = data?.message?.mediaUrl;
        if (audioUrl) {
          return await this.aiAgentService.transcribeAudio(audioUrl, userApiKey);
        }
        return '[AUDIO_MESSAGE_NOT_FOUND]';

      case 'imageMessage':
        const imageUrl = data?.message?.mediaUrl;
        if (imageUrl) {
          return await this.aiAgentService.describeImage(imageUrl, userApiKey);
        }
        return '[IMAGE_MESSAGE_NOT_FOUND]';

      default:
        return '[UNKNOWN_MESSAGE_TYPE]';
    }
  }
}
