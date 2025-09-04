// src/llm/llm-client.factory.ts
import { Injectable } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';

export type LlmProvider = 'openai' | 'google' | 'anthropic';

@Injectable()
export class LlmClientFactory {
  private readonly clients: Map<string, BaseChatModel> = new Map();

  public getClient(provider: LlmProvider, apiKey: string, modelName: string): BaseChatModel {
    const clientKey = `${provider}:${modelName}`;
    if (this.clients.has(clientKey)) {
      return this.clients.get(clientKey)!;
    }

    let client: BaseChatModel;
    switch (provider) {
      case 'openai':
        client = new ChatOpenAI({ apiKey, model: modelName });
        break;
      case 'google':
        client = new ChatGoogleGenerativeAI({ apiKey, model: modelName });
        break;
      default:
        throw new Error(`Unsupported LLM provider: ${provider}`);
    }

    this.clients.set(clientKey, client);
    return client;
  }
}