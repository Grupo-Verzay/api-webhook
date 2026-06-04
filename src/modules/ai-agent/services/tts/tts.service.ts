import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import axios from 'axios';

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

      if (instructions && model === 'gpt-4o-mini-tts') {
        (params as any).instructions = instructions;
      }

      const response = await openai.audio.speech.create(params);
      const buffer = Buffer.from(await response.arrayBuffer());
      return buffer.toString('base64');
    } catch (err: any) {
      this.logger.error(`[TTS/OpenAI] Error: ${err?.message}`);
      return null;
    }
  }

  async generateVoiceElevenLabs(
    text: string,
    apiKey: string,
    voiceId: string,
  ): Promise<string | null> {
    try {
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.0, use_speaker_boost: true },
        },
        {
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          responseType: 'arraybuffer',
          timeout: 30000,
        },
      );
      return Buffer.from(response.data as ArrayBuffer).toString('base64');
    } catch (err: any) {
      const detail = err?.response?.data
        ? Buffer.from(err.response.data).toString('utf8')
        : err?.message ?? String(err);
      const status = err?.response?.status ?? 'no-status';
      throw new Error(`HTTP=${status} | ${detail}`);
    }
  }
}
