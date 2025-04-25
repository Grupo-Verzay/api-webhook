// modules/ai-agent/services/intention.service.ts
import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { LoggerService } from 'src/core/logger/logger.service';
import { IntentionItem } from 'src/types/open-ai';

@Injectable()
export class IntentionService {
    private openAiClient: OpenAI;

    constructor(
        private readonly logger: LoggerService,
    ) { }
    /**
     * Inicializa el cliente de OpenAI con una API Key proporcionada.
     *
     * @param {string} apikeyOpenAi
     */
    private initializeClient(apikeyOpenAi: string): void {
        if (!this.isValidApiKey(apikeyOpenAi)) {
            this.logger.error('API Key inválida o no proporcionada.', '', 'AiAgentService');
        }
        this.openAiClient = new OpenAI({ apiKey: apikeyOpenAi });
    }

    /**
     * Valida si una API Key parece válida.
     *
     * @param {string} apikeyOpenAi
     * @returns {boolean}
     */
    private isValidApiKey(apikeyOpenAi: string): boolean {
        return typeof apikeyOpenAi === 'string' && apikeyOpenAi.startsWith('sk-') && apikeyOpenAi.length >= 40;
    }


    /**
     * Determina si un texto tiene una intención que coincida con alguna acción disponible.
     * @param input Texto enviado por el usuario.
     * @param dataWorkflow Lista de intenciones posibles (flujos, seguimientos, notificaciones).
     */
    async detectIntent(input: string, dataWorkflow: IntentionItem[], apikeyOpenAi: string): Promise<IntentionItem[]> {
        this.logger.debug(`input =>>>${input}, dataWorkflow =>>>${JSON.stringify(dataWorkflow)}, apikeyOpenAi =>>>${JSON.stringify(apikeyOpenAi)}`, 'detectIntent');
        this.initializeClient(apikeyOpenAi);

        const inputEmbedding = await this.createEmbedding(input);

        const matches: { item: IntentionItem; score: number }[] = [];

        for (const item of dataWorkflow) {
            const itemEmbedding = await this.createEmbedding(item.frase);
            const similarity = this.cosineSimilarity(inputEmbedding, itemEmbedding);
            this.logger.debug(`Comparando con: ${item.name} → Similaridad: ${similarity.toFixed(4)}`);

            const umbral = item.umbral ?? 0.5;

            if (similarity >= umbral) {
                matches.push({ item, score: similarity });
            }
        }

        // Ordenar por el score más alto primero
        matches.sort((a, b) => b.score - a.score);

        this.logger.debug(`Total de coincidencias encontradas: ${matches.length}`, 'detectIntent');
        
        // Retornar sólo los items
        return matches.map((m) => m.item);
    }

    private async createEmbedding(text: string): Promise<number[]> {
        const res = await this.openAiClient.embeddings.create({
            model: 'text-embedding-3-small',
            input: text,
        });
        return res.data[0].embedding;
    }

    private cosineSimilarity(a: number[], b: number[]): number {
        const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
        const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
        const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
        return dot / (normA * normB);
    }
}