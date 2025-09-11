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

  public getClient <P extends Provider>(config: ModelConfig<P>):BaseChatModel {
    const {provider,model,apiKey} = config
    const clientKey = `${provider}:${model}`;
    // if (this.clients.has(clientKey)) {
    //   return this.clients.get(clientKey)!;
    // }

   const client = (() => {
      switch (provider) {
        case 'openai':
          return new ChatOpenAI({ apiKey, model });
        case 'google':
          return new ChatGoogleGenerativeAI({ apiKey,model });
        default:
          throw new Error(`Unsupported LLM provider: ${provider}`);
      }
    })();    
    // this.clients.set(clientKey, client);
    client.bindTools([])
    return client;
  }
}

