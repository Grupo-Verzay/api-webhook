import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LoggerService } from 'src/core/logger/logger.service';

type BillingCronSource = 'scheduler' | 'manual';

type BillingCronSettings = {
  enabled: boolean;
  intervalMs: number;
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
  hour: number;
  minute: number;
};

export type BillingCronRunResult = {
  success: boolean;
  triggered: boolean;
  source: BillingCronSource;
  message: string;
  endpointUrl: string;
  slotKey: string;
  skippedReason?: 'NOT_DUE' | 'ALREADY_RAN' | 'MISSING_ENDPOINT';
  statusCode?: number;
  responseBody?: unknown;
  error?: string;
};

@Injectable()
export class BillingCronService {
  private lastRunSlotKey: string | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  private parseBoolean(value: string | undefined, fallback = false) {
    if (!value) return fallback;

    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
  }

  private parsePositiveInt(value: string | undefined, fallback: number) {
    const parsed = Number.parseInt((value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private parseHour(value: string | undefined, fallback: number) {
    const parsed = Number.parseInt((value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 23
      ? parsed
      : fallback;
  }

  private parseMinute(value: string | undefined, fallback: number) {
    const parsed = Number.parseInt((value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 59
      ? parsed
      : fallback;
  }

  private resolveEndpointUrl(
    rawEndpointUrl: string | undefined,
    nextAuthUrl: string | undefined,
  ) {
    const direct = (rawEndpointUrl ?? '').trim();
    if (direct) {
      if (/\/api\/cron\/billing\/?$/i.test(direct)) {
        return direct.replace(/\/+$/, '');
      }

      if (/^https?:\/\//i.test(direct)) {
        return `${direct.replace(/\/+$/, '')}/api/cron/billing`;
      }
    }

    const baseUrl = (nextAuthUrl ?? '').trim();
    if (!baseUrl) return '';

    return `${baseUrl.replace(/\/+$/, '')}/api/cron/billing`;
  }

  getSettings(): BillingCronSettings {
    const enabled = this.parseBoolean(
      this.configService.get<string>('billingCron.enabled') ??
        this.configService.get<string>('BILLING_CRON_ENABLED'),
      false,
    );
    const intervalMs = this.parsePositiveInt(
      this.configService.get<string>('billingCron.intervalMs') ??
        this.configService.get<string>('BILLING_CRON_INTERVAL_MS'),
      60_000,
    );
    const hour = this.parseHour(
      this.configService.get<string>('billingCron.hour') ??
        this.configService.get<string>('BILLING_CRON_HOUR'),
      10,
    );
    const minute = this.parseMinute(
      this.configService.get<string>('billingCron.minute') ??
        this.configService.get<string>('BILLING_CRON_MINUTE'),
      0,
    );
    const timeZone =
      this.configService.get<string>('billingCron.timeZone') ??
      this.configService.get<string>('BILLING_CRON_TIME_ZONE') ??
      'America/Bogota';
    const secret = (
      this.configService.get<string>('billingCron.secret') ??
      this.configService.get<string>('BILLING_CRON_SECRET') ??
      process.env.CRON_SECRET ??
      ''
    ).trim();
    const endpointUrl = this.resolveEndpointUrl(
      this.configService.get<string>('billingCron.endpointUrl') ??
        this.configService.get<string>('BILLING_CRON_ENDPOINT_URL'),
      this.configService.get<string>('nextAuthUrl') ??
        this.configService.get<string>('NEXTAUTH_URL'),
    );
    const timeoutMs = this.parsePositiveInt(
      this.configService.get<string>('billingCron.timeoutMs') ??
        this.configService.get<string>('BILLING_CRON_TIMEOUT_MS'),
      // El job de billing recorre todos los clientes y les envía por WhatsApp (uno a
      // uno), así que 20s se quedaba corto y se cortaba a medias. 5 min da margen de
      // sobra (corre 1 vez/día). Configurable por BILLING_CRON_TIMEOUT_MS.
      300_000,
    );

    return {
      enabled,
      intervalMs,
      hour,
      minute,
      timeZone,
      endpointUrl,
      secret,
      timeoutMs,
    };
  }

  private getZonedDateTimeParts(
    date: Date,
    timeZone: string,
  ): ZonedDateTimeParts {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const map = new Map(parts.map((part) => [part.type, part.value]));

    return {
      year: Number(map.get('year') ?? '0'),
      month: Number(map.get('month') ?? '0'),
      day: Number(map.get('day') ?? '0'),
      hour: Number(map.get('hour') ?? '0'),
      minute: Number(map.get('minute') ?? '0'),
    };
  }

  private hasReachedSchedule(
    parts: ZonedDateTimeParts,
    settings: BillingCronSettings,
  ) {
    if (parts.hour > settings.hour) return true;
    if (parts.hour < settings.hour) return false;
    return parts.minute >= settings.minute;
  }

  private buildSlotKey(
    parts: ZonedDateTimeParts,
    settings: BillingCronSettings,
  ) {
    const dateKey = [
      String(parts.year),
      String(parts.month).padStart(2, '0'),
      String(parts.day).padStart(2, '0'),
    ].join('-');

    return `${dateKey}@${String(settings.hour).padStart(2, '0')}:${String(settings.minute).padStart(2, '0')}`;
  }

  private getErrorMessage(error: unknown, timeoutMs: number) {
    if (error instanceof Error) {
      return error.name === 'AbortError'
        ? `Timeout al invocar verzay-app (${timeoutMs}ms).`
        : error.message;
    }

    return String(error);
  }

  async execute(args?: {
    source?: BillingCronSource;
    force?: boolean;
    now?: Date;
  }): Promise<BillingCronRunResult> {
    const source = args?.source ?? 'scheduler';
    const force = args?.force ?? false;
    const now = args?.now ?? new Date();
    const settings = this.getSettings();
    const zonedParts = this.getZonedDateTimeParts(now, settings.timeZone);
    const slotKey = this.buildSlotKey(zonedParts, settings);

    if (!settings.endpointUrl) {
      const message = 'Billing cron sin endpoint configurado para verzay-app.';
      await this.logger.warn(message, 'BillingCronService');
      return {
        success: false,
        triggered: false,
        source,
        message,
        endpointUrl: '',
        slotKey,
        skippedReason: 'MISSING_ENDPOINT',
        error: 'MISSING_ENDPOINT',
      };
    }

    if (!force) {
      if (!this.hasReachedSchedule(zonedParts, settings)) {
        return {
          success: true,
          triggered: false,
          source,
          message: 'Aun no llega la hora configurada para billing.',
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
          message: 'El cron de billing ya se ejecuto para la ventana actual.',
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
            ? String(
                (responseBody as { message?: string }).message ??
                  `HTTP ${response.status}`,
              )
            : `HTTP ${response.status}`;

        await this.logger.error(
          `Billing cron fallo al invocar verzay-app. status=${response.status} slot=${slotKey} endpoint=${settings.endpointUrl}`,
          errorMessage,
          'BillingCronService',
        );

        return {
          success: false,
          triggered: true,
          source,
          message: 'Error invocando el cron de billing en verzay-app.',
          endpointUrl: settings.endpointUrl,
          slotKey,
          statusCode: response.status,
          responseBody,
          error: errorMessage,
        };
      }

      if (!force) {
        this.lastRunSlotKey = slotKey;
      }

      await this.logger.log(
        `Billing cron ejecutado correctamente. slot=${slotKey} status=${response.status} endpoint=${settings.endpointUrl}`,
        'BillingCronService',
      );

      return {
        success: true,
        triggered: true,
        source,
        message: 'Cron de billing ejecutado correctamente.',
        endpointUrl: settings.endpointUrl,
        slotKey,
        statusCode: response.status,
        responseBody,
      };
    } catch (error: unknown) {
      const errorMessage = this.getErrorMessage(error, settings.timeoutMs);

      await this.logger.error(
        `Error llamando el cron de billing. slot=${slotKey} endpoint=${settings.endpointUrl}`,
        errorMessage,
        'BillingCronService',
      );

      return {
        success: false,
        triggered: true,
        source,
        message: 'Error llamando el cron de billing en verzay-app.',
        endpointUrl: settings.endpointUrl,
        slotKey,
        error: errorMessage,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
