import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

export type OpenAiVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
export type TtsModel = 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts';

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);

  async generateVoiceBase64(
    text: string,
    apiKey: string,
    voice: OpenAiVoice = 'nova',
    model: TtsModel = 'gpt-4o-mini-tts',
    instructions?: string,
  ): Promise<string | null> {
    try {
      const openai = new OpenAI({ apiKey });

      const params: Parameters<typeof openai.audio.speech.create>[0] = {
        model,
        voice,
        input: text,
        response_format: 'mp3',
      };

      // instructions solo aplica en gpt-4o-mini-tts
      if (instructions && model === 'gpt-4o-mini-tts') {
        (params as any).instructions = instructions;
      }

      const response = await openai.audio.speech.create(params);
      const buffer = Buffer.from(await response.arrayBuffer());
      return buffer.toString('base64');
    } catch (err: any) {
      this.logger.error(`[TTS] Error generando audio: ${err?.message}`);
      return null;
    }
  }
}
