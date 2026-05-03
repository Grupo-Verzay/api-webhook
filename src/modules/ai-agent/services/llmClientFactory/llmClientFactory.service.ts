// src/llm/llm-client.factory.ts
import { Injectable } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ModelConfig, Provider } from 'src/types/langchain';

export type LlmProvider = 'openai' | 'google' | 'anthropic';

@Injectable()
export class LlmClientFactory {
  private readonly clients: Map<string, BaseChatModel> = new Map();

  public getClient<P extends Provider>(config: ModelConfig<P> & { temperature?: number }): BaseChatModel {
    const { provider, model, apiKey, temperature = 0 } = config;

    switch (provider) {
      case 'openai': {
        // o-series and gpt-5+ reasoning models only accept temperature=1 (their default)
        const supportsTemperature = !/^(o\d|gpt-5)/i.test(model);
        return new ChatOpenAI({ apiKey, model, ...(supportsTemperature ? { temperature } : {}) });
      }

      case 'google': {
        const resolvedModel = model === 'gemini-2.5-flash' ? 'gemini-2.0-flash' : model;
        return new ChatGoogleGenerativeAI({ apiKey, model: resolvedModel, temperature });
      }

      default:
        throw new Error(`Unsupported LLM provider: ${provider}`);
    }
  }
}
