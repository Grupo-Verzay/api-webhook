import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { LoggerService } from 'src/core/logger/logger.service';
import { PromptService } from '../prompt/prompt.service';

@Injectable()
export class AiAgentService {
  private openAiClient: OpenAI;
  private readonly openAiApiKey: string;
  private readonly openAiChatUrl = 'https://api.openai.com/v1/chat/completions';
  private readonly openAiWhisperUrl = 'https://api.openai.com/v1/audio/transcriptions';

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly logger: LoggerService,
    private readonly promptService: PromptService,
  ) {
    this.openAiApiKey = this.configService.get<string>('OPENAI_API_KEY') || '';

    this.openAiClient = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });

    if (!this.openAiApiKey) {
      this.logger.error('❌ API Key de OpenAI no encontrada. Verifica tu archivo .env', '', 'AiAgentService');
    }
  }

  private getHeaders() {
    if (!this.openAiApiKey) {
      throw new Error('No se puede hacer petición: API Key de OpenAI no configurada.');
    }

    return {
      Authorization: `Bearer ${this.openAiApiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async processInput(content: string, userId: string): Promise<string> {
    try {
      const systemPrompt = await this.promptService.getPromptUserId(userId);

      const response = await firstValueFrom(
        this.httpService.post(
          this.openAiChatUrl,
          {
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'system', content: systemPrompt},
              { role: 'user', content },
            ],
            temperature: 0.7,
          },
          {
            headers: this.getHeaders(),
          },
        ),
      );

      return response.data.choices?.[0]?.message?.content?.trim() ?? '[ERROR_OPENAI_EMPTY_RESPONSE]';
    } catch (error) {
      this.logger.error('❌ Error procesando input con OpenAI', error?.response?.data || error.message, 'AiAgentService');
      return '[ERROR_PROCESSING_OPENAI_INPUT]';
    }
  }


  // async downloadAudioFile(fileUrl: string, destination: string): Promise<void> {
  //   const writer = fs.createWriteStream(destination);

  //   const response = await axios.get(fileUrl, { responseType: 'stream' });

  //   response.data.pipe(writer);

  //   await new Promise<void>((resolve, reject) => {
  //     writer.on('finish', resolve);
  //     writer.on('error', reject);
  //   });
  // }
  async downloadAudioFile(url, outputPath) {
    const writer = fs.createWriteStream(outputPath);
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream'
    });

    response.data.pipe(writer);

    return new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async transcribeAudio(audioUrl: string): Promise<string> {
    try {
      this.logger.debug(`Audio URL: ${JSON.stringify(audioUrl)}`, 'WebhookService');

      // 1. Descargar el audio temporalmente
      const tempFilePath = path.join(__dirname, 'temp_audio_file.oga');
      await this.downloadAudioFile(audioUrl, tempFilePath);

      // 2. Enviar el audio a OpenAI Whisper
      const transcription = await this.openAiClient.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath),
        model: 'whisper-1',
        language: 'es',
      });

      // 3. Borrar el archivo temporal si quieres limpiar
      fs.unlinkSync(tempFilePath);

      return transcription.text;
    } catch (error) {
      this.logger.error('❌ Error transcribiendo audio con OpenAI', error?.response?.data || error.message, 'AiAgentService');
      return '[ERROR_TRANSCRIBING_AUDIO]';
    }
  }

  async describeImage(imageUrl: string): Promise<string> {
    try {
      const prompt = `Describe esta imagen de forma clara: ${imageUrl}`;

      const response = await firstValueFrom(
        this.httpService.post(
          this.openAiChatUrl,
          {
            model: 'gpt-4-vision-preview',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
          },
          {
            headers: this.getHeaders(),
          },
        ),
      );

      return response.data.choices?.[0]?.message?.content?.trim() ?? '[ERROR_DESCRIBING_IMAGE]';
    } catch (error) {
      this.logger.error('❌ Error describiendo imagen con OpenAI', error?.response?.data || error.message, 'AiAgentService');
      return '[ERROR_DESCRIBING_IMAGE]';
    }
  }
}
