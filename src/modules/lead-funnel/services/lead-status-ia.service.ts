import { Injectable } from '@nestjs/common';
import { LeadStatus } from '@prisma/client';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createHash } from 'crypto';

import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { LlmClientFactory } from 'src/modules/ai-agent/services/llmClientFactory/llmClientFactory.service';
import { resolveLeadStatusPrompt } from '../prompts/crm-prompt-template.prompt';
import { LEAD_STATUS_VALUES } from '../constants/lead-status.constants';
import { normalizeText } from '../utils/normalize-text';

type LeadStatusRefreshResult =
  | {
      applied: true;
      sessionId: number;
      leadStatus: LeadStatus;
      reason: string;
      sourceHash: string;
      sourceReportId: number | null;
      summary: string;
    }
  | {
      applied: false;
      sessionId: number;
      reason: string;
      sourceHash?: string;
      sourceReportId?: number | null;
      summary?: string;
      leadStatus?: LeadStatus | null;
    };

@Injectable()
export class LeadStatusIaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llmClientFactory: LlmClientFactory,
    private readonly logger: LoggerService,
  ) {}

  private extractJson(raw: string): any | null {
    const source = (raw ?? '').trim();
    if (!source) return null;

    try {
      return JSON.parse(source);
    } catch (_) {}

    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(source.slice(start, end + 1));
      } catch (_) {}
    }

    return null;
  }

  private hashSummary(summary: string) {
    return createHash('sha1').update(summary).digest('hex');
  }

  private buildFallback(
    summary: string,
    current: LeadStatus | null,
  ): { leadStatus: LeadStatus; reason: string } {
    const normalized = summary.toLowerCase();

    if (
      /(no me interesa|no estoy interesado|no deseo|dejalo asi|ya no|no escribir|no gracias|descartar)/i.test(
        normalized,
      )
    ) {
      return {
        leadStatus: LeadStatus.DESCARTADO,
        reason: 'La sintesis muestra desinteres o rechazo claro.',
      };
    }

    if (
      /(ya compre|ya pague|cerrado|cerramos|implementado|finalizado|terminado|listo|completado)/i.test(
        normalized,
      )
    ) {
      return {
        leadStatus: LeadStatus.FINALIZADO,
        reason: 'La sintesis sugiere cierre o proceso completado.',
      };
    }

    if (
      /(quiero avanzar|hagamoslo|agendemos|cuando empezamos|como pago|te pago|quiero contratar|quiero comprar|confirmo)/i.test(
        normalized,
      )
    ) {
      return {
        leadStatus: LeadStatus.CALIENTE,
        reason: 'La sintesis contiene senales fuertes de cierre.',
      };
    }

    if (
      /(precio|cotizacion|catalogo|informacion|disponibilidad|horarios|presupuesto|comparando|me interesa)/i.test(
        normalized,
      )
    ) {
      return {
        leadStatus: LeadStatus.TIBIO,
        reason: 'La sintesis muestra interes real pero aun sin cierre.',
      };
    }

    if (current) {
      return {
        leadStatus: current,
        reason:
          'Se mantiene el estado previo por falta de nuevas senales claras.',
      };
    }

    return {
      leadStatus: LeadStatus.FRIO,
      reason: 'La sintesis es exploratoria o temprana.',
    };
  }

  private async getClientForUser(userId: string): Promise<BaseChatModel> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { defaultProviderId: true, defaultAiModelId: true },
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

    const [provider, model] = await Promise.all([
      this.prisma.aiProvider.findUnique({
        where: { id: user.defaultProviderId },
        select: { name: true },
      }),
      this.prisma.aiModel.findUnique({
        where: { id: user.defaultAiModelId },
        select: { name: true },
      }),
    ]);

    if (!provider?.name || !model?.name) {
      throw new Error('Provider/model invalidos');
    }

    return this.llmClientFactory.getClient({
      provider: provider.name as any,
      apiKey: cfg.apiKey,
      model: model.name,
    });
  }

  async refreshFromLatestReporte(args: {
    sessionId: number;
    userId: string;
  }): Promise<LeadStatusRefreshResult> {
    const session = await this.prisma.session.findUnique({
      where: { id: args.sessionId },
      select: {
        id: true,
        leadStatus: true,
        leadStatusSourceHash: true,
        registros: {
          where: { tipo: 'REPORTE' },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: {
            id: true,
            resumen: true,
          },
        },
      },
    });

    if (!session) {
      return {
        applied: false,
        sessionId: args.sessionId,
        reason: 'SESSION_NOT_FOUND',
      };
    }

    const latestReport = session.registros[0] ?? null;
    const summary = normalizeText(latestReport?.resumen ?? '').slice(0, 1800);
    if (summary.length < 24) {
      return {
        applied: false,
        sessionId: args.sessionId,
        reason: 'SUMMARY_TOO_SHORT',
        sourceReportId: latestReport?.id ?? null,
        summary,
        leadStatus: session.leadStatus,
      };
    }

    const sourceHash = this.hashSummary(summary);
    if (session.leadStatusSourceHash === sourceHash) {
      return {
        applied: false,
        sessionId: args.sessionId,
        reason: 'UNCHANGED_SOURCE',
        sourceHash,
        sourceReportId: latestReport?.id ?? null,
        summary,
        leadStatus: session.leadStatus,
      };
    }

    let resolved = this.buildFallback(summary, session.leadStatus);

    try {
      const llm = await this.getClientForUser(args.userId);
      const response = await llm.invoke([
        new SystemMessage({
          content: [
            {
              type: 'text',
              text: await resolveLeadStatusPrompt({
                prisma: this.prisma,
                userId: args.userId,
              }),
            },
          ],
        }),
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: `SINTESIS_ACTUAL:\n${summary}`,
            },
          ],
        }),
      ]);

      const parsed = this.extractJson(response?.content?.toString?.() ?? '');
      const candidate = String(parsed?.leadStatus ?? '')
        .trim()
        .toUpperCase();
      const reason = String(parsed?.reason ?? '').trim();

      if ((LEAD_STATUS_VALUES as string[]).includes(candidate)) {
        resolved = {
          leadStatus: candidate as LeadStatus,
          reason:
            reason || 'Clasificacion IA aplicada sobre la sintesis actual.',
        };
      }
    } catch (error: any) {
      this.logger.warn(
        `[LeadStatusIaService] fallback heuristico sessionId=${args.sessionId}: ${error?.message || error}`,
        'LeadStatusIaService',
      );
    }

    await this.prisma.session.update({
      where: { id: args.sessionId },
      data: {
        leadStatus: resolved.leadStatus,
        leadStatusReason: resolved.reason.slice(0, 500),
        leadStatusSourceHash: sourceHash,
        leadStatusUpdatedAt: new Date(),
        ...(resolved.leadStatus === LeadStatus.DESCARTADO && {
          agentDisabled: true,
        }),
      },
    });

    return {
      applied: true,
      sessionId: args.sessionId,
      leadStatus: resolved.leadStatus,
      reason: resolved.reason,
      sourceHash,
      sourceReportId: latestReport?.id ?? null,
      summary,
    };
  }
}
