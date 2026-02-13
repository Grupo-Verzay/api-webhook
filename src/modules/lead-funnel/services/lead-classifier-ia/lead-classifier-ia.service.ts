import { Injectable } from '@nestjs/common';
import { ClassifyMessageDto } from '../../dto/classify-message.dto';
import { ClassificationResultDto } from '../../dto/classification-result.dto';
import { buildLeadFunnelPrompt } from '../../prompts/lead-funnel.prompt';
import { normalizeText } from '../../utils/normalize-text';

import { LlmClientFactory } from 'src/modules/ai-agent/services/llmClientFactory/llmClientFactory.service';
import { PrismaService } from 'src/database/prisma.service';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';

@Injectable()
export class LeadClassifierIaService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly llmClientFactory: LlmClientFactory,
    ) { }

    /**
     * Obtiene cliente LLM exactamente igual que AiAgentService
     */
    private async getClientForUser(userId: string): Promise<BaseChatModel> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                defaultProviderId: true,
                defaultAiModelId: true,
            },
        });

        if (!user?.defaultProviderId || !user?.defaultAiModelId) {
            throw new Error('Usuario sin provider/model por defecto');
        }

        const cfg = await this.prisma.userAiConfig.findFirst({
            where: { userId, isActive: true, providerId: user.defaultProviderId },
            select: { apiKey: true },
        });

        if (!cfg?.apiKey) {
            throw new Error('Usuario sin API Key activa');
        }

        const provider = await this.prisma.aiProvider.findUnique({
            where: { id: user.defaultProviderId },
            select: { name: true },
        });

        const model = await this.prisma.aiModel.findUnique({
            where: { id: user.defaultAiModelId },
            select: { name: true },
        });

        if (!provider?.name || !model?.name) {
            throw new Error('Provider/model inválidos');
        }

        return this.llmClientFactory.getClient({
            provider: provider.name as any,
            apiKey: cfg.apiKey,
            model: model.name,
        }) as BaseChatModel;
    }

    /**
     * Clasificador principal
     */
    async classify(input: ClassifyMessageDto): Promise<ClassificationResultDto> {
        const text = normalizeText(input.text);
        const history = input.history ?? [];

        if (!text) {
            return { kind: 'REPORTE', sintesis: 'Mensaje vacío.' };
        }

        const llm = await this.getClientForUser(input.userId);

        const systemPrompt = buildLeadFunnelPrompt();

        const historyText = history.slice(-5).join('\n');

        const finalInput = `
MENSAJE_ACTUAL:
${text}

ULTIMO_CONTEXTO:
${historyText}
    `.trim();

        const messages = [
            new SystemMessage({
                content: [{ type: 'text', text: systemPrompt }],
            }),
            new HumanMessage({
                content: [{ type: 'text', text: finalInput }],
            }),
        ];

        const response = await llm.invoke(messages);

        const raw = response?.content?.toString()?.trim();

        if (!raw) {
            return { kind: 'REPORTE', sintesis: 'Conversación general.' };
        }

        try {
            const parsed = JSON.parse(raw);
            return parsed as ClassificationResultDto;
        } catch (err) {
            // fallback seguro
            return {
                kind: 'REPORTE',
                sintesis: text.substring(0, 200),
            };
        }
    }
}