import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { WhatsAppSenderFactory } from 'src/modules/whatsapp/whatsapp-sender.factory';
import { WorkflowService } from 'src/modules/workflow/services/workflow.service.ts/workflow.service';

@Injectable()
export class RemindersRunnerService {
  private readonly timezoneOffset: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
    private readonly configService: ConfigService,
    private readonly factory: WhatsAppSenderFactory,
    private readonly workflowService: WorkflowService,
  ) {
    this.timezoneOffset =
      this.configService.get<string>('FOLLOW_UP_TIMEZONE_OFFSET') ?? '-05:00';
  }

  private parseOffsetToMinutes(offset: string): number {
    const match = offset.match(/^([+-])(\d{2}):(\d{2})$/);
    if (!match) return -300;
    const sign = match[1] === '+' ? 1 : -1;
    return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
  }

  private getCurrentFormattedTime(): string {
    const now = new Date();
    const offsetMinutes = this.parseOffsetToMinutes(this.timezoneOffset);
    const local = new Date(now.getTime() + offsetMinutes * 60 * 1000);
    const dd = String(local.getUTCDate()).padStart(2, '0');
    const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = local.getUTCFullYear();
    const hh = String(local.getUTCHours()).padStart(2, '0');
    const min = String(local.getUTCMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  }

  private parseLocalTime(timeStr: string): Date | null {
    const match = timeStr
      .trim()
      .match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
    if (!match) return null;
    const [, day, month, year, hours, minutes] = match;
    return new Date(
      `${year}-${month}-${day}T${hours}:${minutes}:00${this.timezoneOffset}`,
    );
  }

  private formatAsLocalTime(utcDate: Date): string {
    const offsetMinutes = this.parseOffsetToMinutes(this.timezoneOffset);
    const local = new Date(utcDate.getTime() + offsetMinutes * 60 * 1000);
    const dd = String(local.getUTCDate()).padStart(2, '0');
    const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = local.getUTCFullYear();
    const hh = String(local.getUTCHours()).padStart(2, '0');
    const min = String(local.getUTCMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  }

  private computeNextOccurrence(
    timeStr: string,
    repeatType: string,
  ): Date | null {
    const current = this.parseLocalTime(timeStr);
    if (!current) return null;

    const offsetMinutes = this.parseOffsetToMinutes(this.timezoneOffset);
    // Represent the current time as local wall-clock (UTC fields = local values)
    const localCurrent = new Date(current.getTime() + offsetMinutes * 60 * 1000);
    const dayOfWeek = localCurrent.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat

    switch (repeatType) {
      case 'DAILY':
      case 'EVERYDAY':
        return new Date(current.getTime() + 24 * 60 * 60 * 1000);

      case 'WEEKLY':
        return new Date(current.getTime() + 7 * 24 * 60 * 60 * 1000);

      case 'MONTHLY': {
        const next = new Date(localCurrent);
        next.setUTCMonth(next.getUTCMonth() + 1);
        // Convert back to real UTC
        return new Date(next.getTime() - offsetMinutes * 60 * 1000);
      }

      case 'YEARLY': {
        const next = new Date(localCurrent);
        next.setUTCFullYear(next.getUTCFullYear() + 1);
        return new Date(next.getTime() - offsetMinutes * 60 * 1000);
      }

      case 'WEEKDAYS': {
        // Skip Saturday and Sunday
        let daysToAdd = 1;
        if (dayOfWeek === 5) daysToAdd = 3; // Friday → Monday
        else if (dayOfWeek === 6) daysToAdd = 2; // Saturday → Monday
        return new Date(current.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
      }

      default:
        return null; // NONE or unknown → caller will delete
    }
  }

  private async deleteOrAdvance(reminder: {
    id: string;
    time: string | null;
    repeatType: string | null;
    endsAt: Date | null;
  }): Promise<void> {
    const repeatType = reminder.repeatType ?? 'NONE';

    if (repeatType === 'NONE') {
      await this.prisma.reminders.delete({ where: { id: reminder.id } });
      return;
    }

    const next = this.computeNextOccurrence(reminder.time ?? '', repeatType);

    if (!next) {
      await this.prisma.reminders.delete({ where: { id: reminder.id } });
      return;
    }

    if (reminder.endsAt && next >= reminder.endsAt) {
      await this.prisma.reminders.delete({ where: { id: reminder.id } });
      return;
    }

    await this.prisma.reminders.update({
      where: { id: reminder.id },
      data: { time: this.formatAsLocalTime(next) },
    });
  }

  private buildLookbackCandidates(windowMinutes = 5): string[] {
    const candidates: string[] = [];
    for (let i = 0; i < windowMinutes; i++) {
      const t = new Date(Date.now() - i * 60 * 1000);
      const offsetMinutes = this.parseOffsetToMinutes(this.timezoneOffset);
      const local = new Date(t.getTime() + offsetMinutes * 60 * 1000);
      const dd = String(local.getUTCDate()).padStart(2, '0');
      const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
      const yyyy = local.getUTCFullYear();
      const hh = String(local.getUTCHours()).padStart(2, '0');
      const min = String(local.getUTCMinutes()).padStart(2, '0');
      candidates.push(`${dd}/${mm}/${yyyy} ${hh}:${min}`);
    }
    return candidates;
  }

  async processDueReminders(): Promise<{ processed: number; failed: number }> {
    const candidates = this.buildLookbackCandidates(5);

    const dueReminders = await this.prisma.reminders.findMany({
      where: { time: { in: candidates } },
    });

    const summary = { processed: 0, failed: 0 };

    for (const reminder of dueReminders) {
      try {
        const targets: string[] =
          reminder.isCampaign && reminder.remoteJid
            ? reminder.remoteJid
                .split(',')
                .map((r) => r.trim())
                .filter(Boolean)
            : [(reminder.remoteJid ?? '').trim()].filter(Boolean);

        const serverUrl = (reminder.serverUrl ?? '').trim();
        const instanceName = (reminder.instanceName ?? '').trim();
        const apikey = (reminder.apikey ?? '').trim();
        const rawMessage = (reminder.description ?? reminder.title ?? '').trim();

        // Resolver nombre del cliente para reemplazar @client_name
        let clientName = (reminder.pushName ?? '').trim();
        if (!clientName || clientName.toLowerCase() === 'desconocido') {
          const firstTarget = targets[0];
          if (firstTarget && reminder.userId) {
            const session = await this.prisma.session.findFirst({
              where: { remoteJid: firstTarget, userId: reminder.userId },
              select: { pushName: true },
            });
            const name = (session?.pushName ?? '').trim();
            if (name && name.toLowerCase() !== 'desconocido') clientName = name;
          }
        }
        const message = rawMessage.replace(/@client_name/g, clientName || 'Cliente');

        if (!targets.length || !instanceName) {
          this.logger.warn(
            `[REMINDERS] Reminder id=${reminder.id} sin datos completos. Avanzando/eliminando.`,
            'RemindersRunnerService',
          );
          await this.deleteOrAdvance(reminder);
          summary.processed++;
          continue;
        }

        const sender = await this.factory.getSender(instanceName);

        for (const remoteJid of targets) {
          if (message) {
            const ok = await sender.sendText(instanceName, remoteJid, message, serverUrl, apikey);
            if (!ok) {
              throw new Error(
                `Error enviando reminder id=${reminder.id} a ${remoteJid}`,
              );
            }
          }

          if (reminder.workflowId) {
            const workflow = await this.prisma.workflow.findUnique({
              where: { id: reminder.workflowId },
              select: { name: true },
            });

            if (workflow?.name) {
              await this.workflowService.executeWorkflow(
                workflow.name,
                serverUrl,
                apikey,
                instanceName,
                remoteJid,
                reminder.userId ?? '',
              );
            }
          }
        }

        await this.deleteOrAdvance(reminder);

        this.logger.log(
          `[REMINDERS] Reminder ejecutado. id=${reminder.id} title="${reminder.title}" targets=${targets.length}`,
          'RemindersRunnerService',
        );
        summary.processed++;
      } catch (error: any) {
        this.logger.error(
          `[REMINDERS] Error ejecutando reminder id=${reminder.id}.`,
          error?.message ?? String(error),
          'RemindersRunnerService',
        );
        summary.failed++;
      }
    }

    return summary;
  }
}
