import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

export type OpenAiVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);

  /**
   * Convierte texto a audio usando OpenAI TTS y devuelve el buffer en base64.
   * El audio se genera en formato MP3 y Evolution API lo convierte a nota de voz nativa.
   */
  async generateVoiceBase64(
    text: string,
    apiKey: string,
    voice: OpenAiVoice = 'nova',
    model: 'tts-1' | 'tts-1-hd' = 'tts-1',
  ): Promise<string | null> {
    try {
      const openai = new OpenAI({ apiKey });

      const response = await openai.audio.speech.create({
        model,
        voice,
        input: text,
        response_format: 'mp3',
      });

      const buffer = Buffer.from(await response.arrayBuffer());
      return buffer.toString('base64');
    } catch (err: any) {
      this.logger.error(`[TTS] Error generando audio: ${err?.message}`);
      return null;
    }
  }
}
