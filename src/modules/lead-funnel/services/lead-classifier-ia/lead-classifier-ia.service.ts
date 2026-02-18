import { Injectable, Logger } from '@nestjs/common';
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
    private readonly logger = new Logger(LeadClassifierIaService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly llmClientFactory: LlmClientFactory,
    ) { }

    /**
     * Extrae JSON aunque venga “ensuciado” con texto alrededor.
     * - Busca primer "{" y último "}" y parsea ese bloque.
     */
    private extractJson(raw: string): any | null {
        const s = (raw ?? '').trim();
        if (!s) return null;

        // 1) intento directo
        try {
            return JSON.parse(s);
        } catch (_) { }

        // 2) intento por recorte
        const start = s.indexOf('{');
        const end = s.lastIndexOf('}');
        if (start >= 0 && end > start) {
            const sliced = s.slice(start, end + 1);
            try {
                return JSON.parse(sliced);
            } catch (_) { }
        }

        return null;
    }

    /**
     * Obtiene cliente LLM exactamente igual que AiAgentService
     */
    private async getClientForUser(userId: string): Promise<BaseChatModel> {
        this.logger.debug(`[getClientForUser] start userId=${userId}`);

        let user: any;
        try {
            user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { defaultProviderId: true, defaultAiModelId: true },
            });
            this.logger.debug(`[getClientForUser] user defaults=${JSON.stringify(user)}`);
        } catch (err: any) {
            const msg = err?.message || String(err);
            this.logger.error(`[getClientForUser] prisma.user.findUnique error: ${msg}`, err?.stack || err);
            throw err;
        }

        if (!user?.defaultProviderId || !user?.defaultAiModelId) {
            throw new Error('Usuario sin provider/model por defecto');
        }

        let cfg: any;
        try {
            cfg = await this.prisma.userAiConfig.findFirst({
                where: { userId, isActive: true, providerId: user.defaultProviderId },
                select: { apiKey: true },
            });
            this.logger.debug(`[getClientForUser] userAiConfig found=${!!cfg?.apiKey}`);
        } catch (err: any) {
            const msg = err?.message || String(err);
            this.logger.error(`[getClientForUser] prisma.userAiConfig.findFirst error: ${msg}`, err?.stack || err);
            throw err;
        }

        if (!cfg?.apiKey) {
            throw new Error('Usuario sin API Key activa');
        }

        let provider: any;
        let model: any;

        try {
            provider = await this.prisma.aiProvider.findUnique({
                where: { id: user.defaultProviderId },
                select: { name: true },
            });
            this.logger.debug(`[getClientForUser] provider=${provider?.name ?? 'null'}`);
        } catch (err: any) {
            const msg = err?.message || String(err);
            this.logger.error(`[getClientForUser] prisma.aiProvider.findUnique error: ${msg}`, err?.stack || err);
            throw err;
        }

        try {
            model = await this.prisma.aiModel.findUnique({
                where: { id: user.defaultAiModelId },
                select: { name: true },
            });
            this.logger.debug(`[getClientForUser] model=${model?.name ?? 'null'}`);
        } catch (err: any) {
            const msg = err?.message || String(err);
            this.logger.error(`[getClientForUser] prisma.aiModel.findUnique error: ${msg}`, err?.stack || err);
            throw err;
        }

        if (!provider?.name || !model?.name) {
            throw new Error('Provider/model inválidos');
        }

        try {
            const client = this.llmClientFactory.getClient({
                provider: provider.name as any,
                apiKey: cfg.apiKey,
                model: model.name,
            }) as BaseChatModel;

            this.logger.debug(`[getClientForUser] client ready provider=${provider.name} model=${model.name}`);
            return client;
        } catch (err: any) {
            const msg = err?.message || String(err);
            this.logger.error(`[getClientForUser] llmClientFactory.getClient error: ${msg}`, err?.stack || err);
            throw err;
        }
    }

    /**
     * Clasificador principal
     */
    async classify(input: ClassifyMessageDto): Promise<ClassificationResultDto> {
        const text = normalizeText(input.text);
        const history = input.history ?? [];

        this.logger.debug(
            `[classify] start userId=${input.userId} instanceId=${input.instanceId} remoteJid=${input.remoteJid} sessionDbId=${input.sessionDbId}`,
        );
        this.logger.debug(`[classify] text="${text.slice(0, 180)}"`);
        this.logger.debug(`[classify] historyCount=${history.length}`);

        if (!text) {
            this.logger.debug('[classify] empty text -> REPORTE');
            return { kind: 'REPORTE', sintesis: 'Mensaje vacío.' };
        }

        let llm: BaseChatModel;
        try {
            llm = await this.getClientForUser(input.userId);
        } catch (err: any) {
            const msg = err?.message || String(err);
            this.logger.error(`[classify] getClientForUser error: ${msg}`, err?.stack || err);

            // fallback: no interrumpir el flujo global
            return { kind: 'REPORTE', sintesis: 'Conversación general.' };
        }

        const systemPrompt = buildLeadFunnelPrompt({ leadName: input.pushName ?? 'Cliente' });

        const historyText = history.slice(-5).join('\n');
        const finalInput = `
            MENSAJE_ACTUAL:
            ${text}

            ULTIMO_CONTEXTO:
            ${historyText}
            `.trim();

        const messages = [
            new SystemMessage({ content: [{ type: 'text', text: systemPrompt }] }),
            new HumanMessage({ content: [{ type: 'text', text: finalInput }] }),
        ];

        let response: any;
        try {
            response = await llm.invoke(messages);
            this.logger.debug(`[classify] LLM response received`);
        } catch (err: any) {
            const msg = err?.message || String(err);
            this.logger.error(`[classify] llm.invoke error: ${msg}`, err?.stack || err);

            return {
                kind: 'REPORTE',
                sintesis: text.substring(0, 200),
            };
        }

        const raw = response?.content?.toString()?.trim() ?? '';
        this.logger.debug(`[classify] rawLen=${raw.length}`);
        this.logger.debug(`[classify] rawPreview="${raw.slice(0, 220)}"`);

        if (!raw) {
            this.logger.debug('[classify] empty raw -> REPORTE');
            return { kind: 'REPORTE', sintesis: 'Conversación general.' };
        }

        // Parse robusto
        const parsed = this.extractJson(raw);

        if (!parsed) {
            this.logger.debug('[classify] JSON parse failed -> REPORTE fallback');
            return {
                kind: 'REPORTE',
                sintesis: text.substring(0, 200),
            };
        }

        // Validación mínima (evitar retornos basura)
        if (!parsed.kind || (parsed.kind !== 'REPORTE' && parsed.kind !== 'REGISTRO')) {
            this.logger.debug(`[classify] invalid kind="${parsed.kind}" -> REPORTE fallback`);
            return {
                kind: 'REPORTE',
                sintesis: text.substring(0, 200),
            };
        }

        this.logger.debug(`[classify] parsedOK kind=${parsed.kind} tipo=${parsed.tipo ?? '-'} estado=${parsed.estado ?? '-'}`);
        return parsed as ClassificationResultDto;
    }
}