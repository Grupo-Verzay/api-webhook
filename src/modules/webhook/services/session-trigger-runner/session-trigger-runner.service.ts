import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';

@Injectable()
export class SessionTriggerRunnerService {
  private readonly timezoneOffset: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
    private readonly configService: ConfigService,
  ) {
    this.timezoneOffset =
      this.configService.get<string>('FOLLOW_UP_TIMEZONE_OFFSET') ?? '-05:00';
  }

  private getCurrentFormattedTime(): string {
    const now = new Date();
    // Adjust to configured timezone offset
    const offsetMinutes = this.parseOffsetToMinutes(this.timezoneOffset);
    const local = new Date(now.getTime() + offsetMinutes * 60 * 1000);

    const dd = String(local.getUTCDate()).padStart(2, '0');
    const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = local.getUTCFullYear();
    const hh = String(local.getUTCHours()).padStart(2, '0');
    const min = String(local.getUTCMinutes()).padStart(2, '0');

    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  }

  private parseOffsetToMinutes(offset: string): number {
    const match = offset.match(/^([+-])(\d{2}):(\d{2})$/);
    if (!match) return -300; // default UTC-5
    const sign = match[1] === '+' ? 1 : -1;
    return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
  }

  async processDueTriggers(): Promise<{ processed: number; failed: number }> {
    const currentTime = this.getCurrentFormattedTime();

    const dueTriggers = await this.prisma.sessionTrigger.findMany({
      where: { time: currentTime },
      include: { session: { select: { id: true, userId: true, remoteJid: true, instanceId: true } } },
    });

    const summary = { processed: 0, failed: 0 };

    for (const trigger of dueTriggers) {
      try {
        await this.prisma.session.update({
          where: { id: trigger.sessionId },
          data: { status: true },
        });

        await this.prisma.sessionTrigger.delete({ where: { id: trigger.id } });

        this.logger.log(
          `[SESSION_TRIGGER] Sesión reactivada. sessionId=${trigger.sessionId} remoteJid=${trigger.session?.remoteJid ?? '-'}`,
          'SessionTriggerRunnerService',
        );

        summary.processed++;
      } catch (error: any) {
        this.logger.error(
          `[SESSION_TRIGGER] Error reactivando sesión id=${trigger.sessionId}.`,
          error?.message ?? String(error),
          'SessionTriggerRunnerService',
        );
        summary.failed++;
      }
    }

    return summary;
  }
}
