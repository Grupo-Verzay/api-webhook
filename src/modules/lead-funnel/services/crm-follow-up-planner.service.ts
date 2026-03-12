import { Injectable } from '@nestjs/common';
import { CrmFollowUpStatus, LeadStatus } from '@prisma/client';

import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { CRM_FOLLOW_UP_RULES } from '../constants/lead-status.constants';

@Injectable()
export class CrmFollowUpPlannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
  ) {}

  async syncFromLeadStatus(args: {
    sessionId: number;
    userId: string;
    leadStatus: LeadStatus;
    summary: string;
    sourceHash: string;
    sourceReportId?: number | null;
  }) {
    const session = await this.prisma.session.findUnique({
      where: { id: args.sessionId },
      select: {
        id: true,
        remoteJid: true,
        instanceId: true,
      },
    });

    if (!session) {
      return { ok: false as const, reason: 'SESSION_NOT_FOUND' };
    }

    if (args.leadStatus === LeadStatus.FINALIZADO || args.leadStatus === LeadStatus.DESCARTADO) {
      const cancelled = await this.prisma.crmFollowUp.updateMany({
        where: {
          sessionId: args.sessionId,
          status: CrmFollowUpStatus.PENDING,
        },
        data: {
          status: CrmFollowUpStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      });

      return {
        ok: true as const,
        action: 'CANCELLED_PENDING',
        count: cancelled.count,
      };
    }

    const rule = CRM_FOLLOW_UP_RULES[args.leadStatus];
    if (!rule?.enabled || !args.summary.trim()) {
      return { ok: true as const, action: 'SKIPPED_RULE' };
    }

    const existing = await this.prisma.crmFollowUp.findFirst({
      where: {
        sessionId: args.sessionId,
        ruleKey: rule.ruleKey,
        sourceHash: args.sourceHash,
      },
      select: { id: true, status: true },
    });

    if (existing) {
      return {
        ok: true as const,
        action: 'EXISTS',
        followUpId: existing.id,
        status: existing.status,
      };
    }

    await this.prisma.crmFollowUp.updateMany({
      where: {
        sessionId: args.sessionId,
        status: CrmFollowUpStatus.PENDING,
      },
      data: {
        status: CrmFollowUpStatus.CANCELLED,
        cancelledAt: new Date(),
      },
    });

    const scheduledFor = new Date(Date.now() + rule.delayMinutes * 60_000);

    const created = await this.prisma.crmFollowUp.create({
      data: {
        sessionId: args.sessionId,
        userId: args.userId,
        sourceReportId: args.sourceReportId ?? null,
        remoteJid: session.remoteJid,
        instanceId: session.instanceId,
        leadStatusSnapshot: args.leadStatus,
        summarySnapshot: args.summary,
        ruleKey: rule.ruleKey,
        sourceHash: args.sourceHash,
        scheduledFor,
        status: CrmFollowUpStatus.PENDING,
        cancelOnReply: true,
        maxAttempts: rule.maxAttempts,
      },
      select: {
        id: true,
        scheduledFor: true,
      },
    });

    this.logger.log(
      `[CrmFollowUpPlanner] created id=${created.id} sessionId=${args.sessionId} leadStatus=${args.leadStatus} scheduledFor=${created.scheduledFor.toISOString()}`,
      'CrmFollowUpPlannerService',
    );

    return {
      ok: true as const,
      action: 'CREATED',
      followUpId: created.id,
    };
  }
}
