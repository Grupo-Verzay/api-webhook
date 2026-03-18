import { Injectable } from '@nestjs/common';
import { CrmFollowUp, CrmFollowUpStatus } from '@prisma/client';

import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { AiAgentService } from 'src/modules/ai-agent/ai-agent.service';
import { ChatHistoryService } from 'src/modules/chat-history/chat-history.service';
import { buildChatHistorySessionId } from 'src/modules/chat-history/chat-history-session.helper';
import { NodeSenderService } from 'src/modules/workflow/services/node-sender.service.ts/node-sender.service';
import { buildWhatsAppJidCandidates } from 'src/utils/whatsapp-jid.util';
import {
  computeNextCrmFollowUpDate,
  isWithinCrmFollowUpWindow,
  sanitizeWeekdays,
} from '../utils/crm-follow-up-schedule';
import { CrmFollowUpRuleService } from './crm-follow-up-rule.service';

@Injectable()
export class CrmFollowUpRunnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
    private readonly aiAgentService: AiAgentService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly nodeSenderService: NodeSenderService,
    private readonly crmFollowUpRuleService: CrmFollowUpRuleService,
  ) {}

  private buildRemoteJidCandidates(remoteJid: string) {
    return buildWhatsAppJidCandidates((remoteJid ?? '').trim());
  }

  private normalizeServerUrl(serverUrl: string) {
    const trimmed = (serverUrl ?? '').trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  private async markSent(followUpId: string, message: string, remoteJid?: string) {
    await this.prisma.crmFollowUp.update({
      where: { id: followUpId },
      data: {
        status: CrmFollowUpStatus.SENT,
        attemptCount: { increment: 1 },
        generatedMessage: message,
        errorReason: null,
        sentAt: new Date(),
        lastProcessedAt: new Date(),
        remoteJid: remoteJid?.trim() || undefined,
      },
    });
  }

  private async markFailure(
    followUp: Pick<CrmFollowUp, 'id' | 'attemptCount' | 'maxAttempts'>,
    error: string,
    remoteJid?: string,
  ) {
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
        remoteJid: remoteJid?.trim() || undefined,
      },
    });
  }

  private async rescheduleForWindow(args: {
    followUpId: string;
    baseDate: Date;
    timeZone?: string | null;
    allowedWeekdays?: number[] | null;
    sendStartTime?: string | null;
    sendEndTime?: string | null;
  }) {
    const nextDate = computeNextCrmFollowUpDate({
      baseDate: args.baseDate,
      timeZone: args.timeZone,
      allowedWeekdays: args.allowedWeekdays,
      sendStartTime: args.sendStartTime,
      sendEndTime: args.sendEndTime,
    });

    await this.prisma.crmFollowUp.update({
      where: { id: args.followUpId },
      data: {
        status: CrmFollowUpStatus.PENDING,
        scheduledFor: nextDate,
        lastProcessedAt: new Date(),
      },
    });
  }

  async cancelPendingOnReply(args: {
    remoteJid: string;
    instanceId: string;
  }) {
    const candidates = this.buildRemoteJidCandidates(args.remoteJid);
    const result = await this.prisma.crmFollowUp.updateMany({
      where: {
        remoteJid: { in: candidates },
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
    const remoteJidCandidates = scope?.remoteJid
      ? this.buildRemoteJidCandidates(scope.remoteJid)
      : [];

    const pending = await this.prisma.crmFollowUp.findMany({
      where: {
        status: CrmFollowUpStatus.PENDING,
        scheduledFor: {
          lte: new Date(),
        },
        ...(scope?.userId ? { userId: scope.userId } : {}),
        ...(scope?.instanceId ? { instanceId: scope.instanceId } : {}),
        ...(remoteJidCandidates.length ? { remoteJid: { in: remoteJidCandidates } } : {}),
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
              remoteJidAlt: true,
              instanceId: true,
              pushName: true,
            },
          },
          user: {
            select: {
              enabledCrmFollowUps: true,
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

      if (!followUp.user.enabledCrmFollowUps) {
        await this.prisma.crmFollowUp.update({
          where: { id: followUp.id },
          data: {
            status: CrmFollowUpStatus.CANCELLED,
            cancelledAt: new Date(),
            lastProcessedAt: new Date(),
          },
        });
        summary.skipped += 1;
        continue;
      }

      const currentRule = await this.crmFollowUpRuleService.getRuleForUser(
        followUp.userId,
        followUp.leadStatusSnapshot,
      );

      if (!currentRule?.enabled) {
        await this.prisma.crmFollowUp.update({
          where: { id: followUp.id },
          data: {
            status: CrmFollowUpStatus.CANCELLED,
            cancelledAt: new Date(),
            lastProcessedAt: new Date(),
          },
        });
        summary.skipped += 1;
        continue;
      }

      const allowedWeekdays = sanitizeWeekdays(
        followUp.allowedWeekdaysSnapshot?.length
          ? followUp.allowedWeekdaysSnapshot
          : currentRule.allowedWeekdays,
      );
      const sendStartTime =
        followUp.sendStartTimeSnapshot ?? currentRule.sendStartTime;
      const sendEndTime =
        followUp.sendEndTimeSnapshot ?? currentRule.sendEndTime;

      if (
        !isWithinCrmFollowUpWindow({
          date: new Date(),
          timeZone: currentRule.timezone,
          allowedWeekdays,
          sendStartTime,
          sendEndTime,
        })
      ) {
        await this.rescheduleForWindow({
          followUpId: followUp.id,
          baseDate: new Date(),
          timeZone: currentRule.timezone,
          allowedWeekdays,
          sendStartTime,
          sendEndTime,
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
          sessionId: buildChatHistorySessionId(followUp.instanceId, followUp.session.remoteJid),
          goal: (followUp.goalSnapshot ?? currentRule.goal).trim(),
          customPrompt: (followUp.promptSnapshot ?? currentRule.prompt).trim(),
          attempt: (followUp.attemptCount ?? 0) + 1,
          pushName: followUp.session.pushName ?? '',
          registroResumen: followUp.summarySnapshot ?? '',
          fallbackMessage: (
            followUp.fallbackMessageSnapshot ?? currentRule.fallbackMessage
          ).trim(),
        });

        const safeMessage = finalMessage.trim();
        if (!safeMessage) {
          throw new Error('La IA no produjo un mensaje util para el CRM follow-up.');
        }

        const ok = await this.nodeSenderService.sendTextNode(
          `${serverUrl}/message/sendText/${followUp.instanceId}`,
          apiKey,
          followUp.session.remoteJid,
          safeMessage,
        );

        if (!ok) {
          throw new Error('Error enviando CRM follow-up por Evolution.');
        }

        await this.chatHistoryService.saveMessage(
          buildChatHistorySessionId(followUp.instanceId, followUp.session.remoteJid),
          safeMessage,
          'ia',
        );

        await this.markSent(followUp.id, safeMessage, followUp.session.remoteJid);
        summary.sent += 1;
      } catch (error: any) {
        this.logger.error(
          `[CrmFollowUpRunner] error id=${followUp.id}`,
          error?.message || error,
          'CrmFollowUpRunnerService',
        );
        await this.markFailure(
          candidate,
          error?.message || String(error),
          followUp.session.remoteJid,
        );
        summary.failed += 1;
      }
    }

    return summary;
  }
}
