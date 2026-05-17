import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LoggerService } from 'src/core/logger/logger.service';

type WeeklyReportSource = 'scheduler' | 'manual';

type WeeklyReportSettings = {
  enabled: boolean;
  intervalMs: number;
  dayOfWeek: number; // 0=Sun … 6=Sat
  hour: number;
  minute: number;
  timeZone: string;
  endpointUrl: string;
  secret: string;
  timeoutMs: number;
};

type ZonedDateTimeParts = {
  year: number;
  month: number;
  day: number;
  weekday: number; // 0=Sun … 6=Sat
  hour: number;
  minute: number;
};

export type WeeklyReportRunResult = {
  success: boolean;
  triggered: boolean;
  source: WeeklyReportSource;
  message: string;
  endpointUrl: string;
  slotKey: string;
  skippedReason?: 'NOT_DUE' | 'ALREADY_RAN' | 'MISSING_ENDPOINT';
  statusCode?: number;
  responseBody?: unknown;
  error?: string;
};

@Injectable()
export class WeeklyReportCronService {
  private lastRunSlotKey: string | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  private parseBoolean(value: string | undefined, fallback = false): boolean {
    if (!value) return fallback;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
  }

  private parsePositiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt((value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private parseHour(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt((value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 23 ? parsed : fallback;
  }

  private parseMinute(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt((value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 59 ? parsed : fallback;
  }

  private parseDayOfWeek(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt((value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 6 ? parsed : fallback;
  }

  private resolveEndpointUrl(raw: string | undefined, baseUrl: string | undefined): string {
    const direct = (raw ?? '').trim();
    if (direct) {
      if (/\/api\/cron\/weekly-report\/?$/i.test(direct)) {
        return direct.replace(/\/+$/, '');
      }
      if (/^https?:\/\//i.test(direct)) {
        return `${direct.replace(/\/+$/, '')}/api/cron/weekly-report`;
      }
    }
    const base = (baseUrl ?? '').trim();
    if (!base) return '';
    return `${base.replace(/\/+$/, '')}/api/cron/weekly-report`;
  }

  getSettings(): WeeklyReportSettings {
    return {
      enabled: this.parseBoolean(
        this.configService.get<string>('WEEKLY_REPORT_CRON_ENABLED'),
        false,
      ),
      intervalMs: this.parsePositiveInt(
        this.configService.get<string>('WEEKLY_REPORT_CRON_INTERVAL_MS'),
        60_000,
      ),
      dayOfWeek: this.parseDayOfWeek(
        this.configService.get<string>('WEEKLY_REPORT_CRON_DAY_OF_WEEK'),
        6, // Saturday
      ),
      hour: this.parseHour(
        this.configService.get<string>('WEEKLY_REPORT_CRON_HOUR'),
        18,
      ),
      minute: this.parseMinute(
        this.configService.get<string>('WEEKLY_REPORT_CRON_MINUTE'),
        0,
      ),
      timeZone:
        this.configService.get<string>('WEEKLY_REPORT_CRON_TIME_ZONE') ??
        'America/Bogota',
      secret: (
        this.configService.get<string>('WEEKLY_REPORT_CRON_SECRET') ??
        this.configService.get<string>('CRON_SECRET') ??
        ''
      ).trim(),
      endpointUrl: this.resolveEndpointUrl(
        this.configService.get<string>('WEEKLY_REPORT_CRON_ENDPOINT_URL'),
        this.configService.get<string>('NEXTJS_URL') ??
          this.configService.get<string>('NEXTAUTH_URL'),
      ),
      timeoutMs: this.parsePositiveInt(
        this.configService.get<string>('WEEKLY_REPORT_CRON_TIMEOUT_MS'),
        120_000,
      ),
    };
  }

  private getZonedDateTimeParts(date: Date, timeZone: string): ZonedDateTimeParts {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const map = new Map(parts.map((p) => [p.type, p.value]));

    const weekdayStr = (map.get('weekday') ?? 'Sun').toLowerCase();
    const weekdayMap: Record<string, number> = {
      sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
    };

    return {
      year: Number(map.get('year') ?? '0'),
      month: Number(map.get('month') ?? '0'),
      day: Number(map.get('day') ?? '0'),
      weekday: weekdayMap[weekdayStr] ?? 0,
      hour: Number(map.get('hour') ?? '0'),
      minute: Number(map.get('minute') ?? '0'),
    };
  }

  private isDue(parts: ZonedDateTimeParts, settings: WeeklyReportSettings): boolean {
    if (parts.weekday !== settings.dayOfWeek) return false;
    if (parts.hour !== settings.hour) return false;
    const minuteDiff = parts.minute - settings.minute;
    return minuteDiff >= 0 && minuteDiff < 5;
  }

  private buildSlotKey(parts: ZonedDateTimeParts, settings: WeeklyReportSettings): string {
    const dateKey = [
      String(parts.year),
      String(parts.month).padStart(2, '0'),
      String(parts.day).padStart(2, '0'),
    ].join('-');
    return `${dateKey}@dow${settings.dayOfWeek}_${String(settings.hour).padStart(2, '0')}:${String(settings.minute).padStart(2, '0')}`;
  }

  private getErrorMessage(error: unknown, timeoutMs: number): string {
    if (error instanceof Error) {
      return error.name === 'AbortError'
        ? `Timeout al invocar la app (${timeoutMs}ms).`
        : error.message;
    }
    return String(error);
  }

  async execute(args?: {
    source?: WeeklyReportSource;
    force?: boolean;
    now?: Date;
  }): Promise<WeeklyReportRunResult> {
    const source = args?.source ?? 'scheduler';
    const force = args?.force ?? false;
    const now = args?.now ?? new Date();
    const settings = this.getSettings();
    const parts = this.getZonedDateTimeParts(now, settings.timeZone);
    const slotKey = this.buildSlotKey(parts, settings);

    if (!settings.endpointUrl) {
      const message = 'Weekly report cron sin endpoint configurado.';
      await this.logger.warn(message, 'WeeklyReportCronService');
      return {
        success: false,
        triggered: false,
        source,
        message,
        endpointUrl: '',
        slotKey,
        skippedReason: 'MISSING_ENDPOINT',
      };
    }

    if (!force) {
      if (!this.isDue(parts, settings)) {
        return {
          success: true,
          triggered: false,
          source,
          message: 'Aun no llega el dia/hora configurado para el reporte semanal.',
          endpointUrl: settings.endpointUrl,
          slotKey,
          skippedReason: 'NOT_DUE',
        };
      }

      if (this.lastRunSlotKey === slotKey) {
        return {
          success: true,
          triggered: false,
          source,
          message: 'El reporte semanal ya se ejecuto para la ventana actual.',
          endpointUrl: settings.endpointUrl,
          slotKey,
          skippedReason: 'ALREADY_RAN',
        };
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (settings.secret) {
      headers.authorization = `Bearer ${settings.secret}`;
      headers['x-cron-secret'] = settings.secret;
    }

    if (!force) {
      this.lastRunSlotKey = slotKey;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);

    try {
      const response = await fetch(settings.endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source,
          force,
          scheduledAt: now.toISOString(),
          timeZone: settings.timeZone,
        }),
        signal: controller.signal,
      });

      const rawBody = await response.text();
      let responseBody: unknown = rawBody;
      try {
        responseBody = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        responseBody = rawBody;
      }

      if (!response.ok) {
        const errorMessage =
          typeof responseBody === 'object' &&
          responseBody &&
          'message' in responseBody
            ? String((responseBody as { message?: string }).message ?? `HTTP ${response.status}`)
            : `HTTP ${response.status}`;

        await this.logger.error(
          `Weekly report cron fallo. status=${response.status} slot=${slotKey}`,
          errorMessage,
          'WeeklyReportCronService',
        );

        return {
          success: false,
          triggered: true,
          source,
          message: 'Error invocando el reporte semanal.',
          endpointUrl: settings.endpointUrl,
          slotKey,
          statusCode: response.status,
          responseBody,
          error: errorMessage,
        };
      }

      await this.logger.log(
        `Weekly report cron ejecutado correctamente. slot=${slotKey} status=${response.status}`,
        'WeeklyReportCronService',
      );

      return {
        success: true,
        triggered: true,
        source,
        message: 'Reporte semanal ejecutado correctamente.',
        endpointUrl: settings.endpointUrl,
        slotKey,
        statusCode: response.status,
        responseBody,
      };
    } catch (error: unknown) {
      const errorMessage = this.getErrorMessage(error, settings.timeoutMs);

      await this.logger.error(
        `Error llamando el reporte semanal. slot=${slotKey}`,
        errorMessage,
        'WeeklyReportCronService',
      );

      return {
        success: false,
        triggered: true,
        source,
        message: 'Error llamando el reporte semanal.',
        endpointUrl: settings.endpointUrl,
        slotKey,
        error: errorMessage,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
