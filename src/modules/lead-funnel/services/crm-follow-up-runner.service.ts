import { Injectable } from '@nestjs/common';
import { CrmFollowUp, CrmFollowUpStatus } from '@prisma/client';

import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { AiAgentService } from 'src/modules/ai-agent/ai-agent.service';
import { ChatHistoryService } from 'src/modules/chat-history/chat-history.service';
import { buildChatHistorySessionId } from 'src/modules/chat-history/chat-history-session.helper';
import { NodeSenderService } from 'src/modules/workflow/services/node-sender.service.ts/node-sender.service';
import { CRM_FOLLOW_UP_RULES } from '../constants/lead-status.constants';

@Injectable()
export class CrmFollowUpRunnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
    private readonly aiAgentService: AiAgentService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly nodeSenderService: NodeSenderService,
  ) {}

  private normalizeServerUrl(serverUrl: string) {
    const trimmed = (serverUrl ?? '').trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  private async markSent(followUpId: string, message: string) {
    await this.prisma.crmFollowUp.update({
      where: { id: followUpId },
      data: {
        status: CrmFollowUpStatus.SENT,
        attemptCount: { increment: 1 },
        generatedMessage: message,
        errorReason: null,
        sentAt: new Date(),
        lastProcessedAt: new Date(),
      },
    });
  }

  private async markFailure(followUp: Pick<CrmFollowUp, 'id' | 'attemptCount' | 'maxAttempts'>, error: string) {
    const nextAttempt = (followUp.attemptCount ?? 0) + 1;
    const exhausted = nextAttempt >= Math.max(followUp.maxAttempts ?? 1, 1);

    await this.prisma.crmFollowUp.update({
      where: { id: followUp.id },
      data: {
        status: exhausted ? CrmFollowUpStatus.FAILED : CrmFollowUpStatus.PENDING,
        attemptCount: nextAttempt,
        errorReason: error.slice(0, 500),
        lastProcessedAt: new Date(),
        scheduledFor: exhausted ? undefined : new Date(Date.now() + 15 * 60_000),
      },
    });
  }

  async cancelPendingOnReply(args: {
    remoteJid: string;
    instanceId: string;
  }) {
    const result = await this.prisma.crmFollowUp.updateMany({
      where: {
        remoteJid: args.remoteJid,
        instanceId: args.instanceId,
        status: CrmFollowUpStatus.PENDING,
        cancelOnReply: true,
      },
      data: {
        status: CrmFollowUpStatus.CANCELLED,
        cancelledAt: new Date(),
      },
    });

    return { count: result.count };
  }

  async processDueFollowUps(limit = 25, scope?: { userId?: string; instanceId?: string; remoteJid?: string }) {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 25;

    const pending = await this.prisma.crmFollowUp.findMany({
      where: {
        status: CrmFollowUpStatus.PENDING,
        scheduledFor: {
          lte: new Date(),
        },
        ...(scope?.userId ? { userId: scope.userId } : {}),
        ...(scope?.instanceId ? { instanceId: scope.instanceId } : {}),
        ...(scope?.remoteJid ? { remoteJid: scope.remoteJid } : {}),
      },
      orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
      take: safeLimit,
    });

    const summary = {
      scanned: pending.length,
      due: pending.length,
      sent: 0,
      failed: 0,
      skipped: 0,
    };

    for (const candidate of pending) {
      const lock = await this.prisma.crmFollowUp.updateMany({
        where: {
          id: candidate.id,
          status: CrmFollowUpStatus.PENDING,
        },
        data: {
          status: CrmFollowUpStatus.PROCESSING,
        },
      });

      if (lock.count === 0) {
        summary.skipped += 1;
        continue;
      }

      const followUp = await this.prisma.crmFollowUp.findUnique({
        where: { id: candidate.id },
        include: {
          session: {
            select: {
              id: true,
              remoteJid: true,
              instanceId: true,
              pushName: true,
            },
          },
          user: {
            select: {
              apiKey: {
                select: {
                  url: true,
                  key: true,
                },
              },
            },
          },
        },
      });

      if (!followUp?.session) {
        await this.markFailure(candidate, 'Sesion no encontrada para CRM follow-up.');
        summary.failed += 1;
        continue;
      }

      const rule = CRM_FOLLOW_UP_RULES[followUp.leadStatusSnapshot];
      if (!rule?.enabled) {
        await this.prisma.crmFollowUp.update({
          where: { id: followUp.id },
          data: {
            status: CrmFollowUpStatus.SKIPPED,
            lastProcessedAt: new Date(),
          },
        });
        summary.skipped += 1;
        continue;
      }

      const serverUrl = this.normalizeServerUrl(followUp.user.apiKey?.url ?? '');
      const apiKey = (followUp.user.apiKey?.key ?? '').trim();
      if (!serverUrl || !apiKey) {
        await this.markFailure(candidate, 'Usuario sin API de Evolution configurada.');
        summary.failed += 1;
        continue;
      }

      try {
        const finalMessage = await this.aiAgentService.generateFollowUpMessage({
          userId: followUp.userId,
          sessionId: buildChatHistorySessionId(followUp.instanceId, followUp.remoteJid),
          goal: rule.goal,
          customPrompt: rule.prompt,
          attempt: (followUp.attemptCount ?? 0) + 1,
          pushName: followUp.session.pushName ?? '',
          registroResumen: followUp.summarySnapshot ?? '',
          fallbackMessage: rule.fallbackMessage,
        });

        const safeMessage = finalMessage.trim();
        if (!safeMessage) {
          throw new Error('La IA no produjo un mensaje util para el CRM follow-up.');
        }

        const ok = await this.nodeSenderService.sendTextNode(
          `${serverUrl}/message/sendText/${followUp.instanceId}`,
          apiKey,
          followUp.remoteJid,
          safeMessage,
        );

        if (!ok) {
          throw new Error('Error enviando CRM follow-up por Evolution.');
        }

        await this.chatHistoryService.saveMessage(
          buildChatHistorySessionId(followUp.instanceId, followUp.remoteJid),
          safeMessage,
          'ia',
        );

        await this.markSent(followUp.id, safeMessage);
        summary.sent += 1;
      } catch (error: any) {
        this.logger.error(
          `[CrmFollowUpRunner] error id=${followUp.id}`,
          error?.message || error,
          'CrmFollowUpRunnerService',
        );
        await this.markFailure(candidate, error?.message || String(error));
        summary.failed += 1;
      }
    }

    return summary;
  }
}
