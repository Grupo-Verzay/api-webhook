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

  private parseScheduledTime(timeStr: string): Date | null {
    const trimmed = timeStr.trim();
    if (!trimmed) return null;

    // Formato nuevo: ISO 8601 UTC — "2026-05-15T17:30:00.000Z"
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const d = new Date(trimmed);
      return isNaN(d.getTime()) ? null : d;
    }

    // Formato legado: "dd/MM/yyyy HH:mm" guardado en timezone configurado
    const m = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
    if (!m) return null;
    const [, dd, mm, yyyy, hh, min] = m;
    return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00${this.timezoneOffset}`);
  }

  async processDueTriggers(): Promise<{ processed: number; failed: number }> {
    const allTriggers = await this.prisma.sessionTrigger.findMany({
      include: {
        session: {
          select: { id: true, userId: true, remoteJid: true, instanceId: true },
        },
      },
    });

    const now = Date.now();

    const dueTriggers = allTriggers.filter((t) => {
      const scheduled = this.parseScheduledTime(t.time);
      return scheduled !== null && scheduled.getTime() <= now;
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
