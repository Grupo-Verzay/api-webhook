import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { SystemNotificationDispatcherService } from 'src/modules/whatsapp/services/system-notification-dispatcher.service';

const ADMIN_USER_ID = process.env.ADMIN_USER_ID ?? 'cm842kthc0000qd2l66nbnytv';
const TIMEOUT_MS = 10_000;
const MAX_DAILY_NOTIFICATIONS = 3;
const TIME_ZONE = 'America/Bogota';
const DISABLED_SENTINEL = '0000000000';

const DISCONNECTION_MSG =
  '📵 El WhatsApp esta *desvinculado* del Agente.\n\n' +
  '*Solucion*: entre a su cuenta\n\n' +
  '👉 agente.ia-app.com/profile\n\n' +
  '*Conectar* → en WhatsApp Business: Dispositivos vinculados.\n\n' +
  '*Vincular un dispositivo* y escanee el *QR* 📳';

type DailyEntry = { dayKey: string; count: number };

function normalizeBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

@Injectable()
export class ConnectionCheckService {
  private readonly dailyNotified = new Map<string, DailyEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
    private readonly notificationDispatcher: SystemNotificationDispatcherService,
  ) {}

  private getDayKey(now: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now);
  }

  private canNotify(instanceKey: string, dayKey: string): boolean {
    const entry = this.dailyNotified.get(instanceKey);
    if (!entry || entry.dayKey !== dayKey) return true;
    return entry.count < MAX_DAILY_NOTIFICATIONS;
  }

  private markNotified(instanceKey: string, dayKey: string): void {
    const entry = this.dailyNotified.get(instanceKey);
    if (!entry || entry.dayKey !== dayKey) {
      this.dailyNotified.set(instanceKey, { dayKey, count: 1 });
    } else {
      entry.count += 1;
    }
  }

  private async isInstanceConnected(
    serverUrl: string,
    instanceName: string,
    instanceId: string,
  ): Promise<boolean> {
    try {
      const base = normalizeBase(serverUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(
        `${base}/instance/connect/${encodeURIComponent(instanceName)}`,
        {
          method: 'GET',
          headers: { apikey: instanceId },
          signal: controller.signal,
        },
      ).finally(() => clearTimeout(timeout));

      if (!response.ok) return false;
      const data = await response.json();
      return data?.instance?.state === 'open';
    } catch {
      return false;
    }
  }

  async run(now = new Date()): Promise<{ checked: number; disconnected: number; notified: number }> {
    const dayKey = this.getDayKey(now);

    const users = await this.prisma.user.findMany({
      where: {
        status: true,
        instancias: { some: { instanceType: 'Whatsapp' } },
      },
      select: {
        id: true,
        ownerId: true,
        demoResellerId: true,
        notificationNumber: true,
        apiKey: { select: { url: true } },
        instancias: {
          where: { instanceType: 'Whatsapp' },
          select: { instanceName: true, instanceId: true },
          take: 1,
        },
      },
    });

    let checked = 0;
    let disconnected = 0;
    let notified = 0;

    for (const user of users) {
      const instance = user.instancias[0];
      const serverUrl = user.apiKey?.url?.trim();
      const phone = user.notificationNumber;

      if (!instance || !serverUrl || !phone || phone === DISABLED_SENTINEL) continue;

      const instanceKey = `${user.id}::${instance.instanceName}`;
      checked++;

      const connected = await this.isInstanceConnected(serverUrl, instance.instanceName, instance.instanceId);
      if (connected) continue;

      disconnected++;

      if (!this.canNotify(instanceKey, dayKey)) {
        this.logger.log(
          `[ConnectionCheck] ${instance.instanceName} desconectada; limite diario alcanzado.`,
        );
        continue;
      }

      const ownerKey = user.ownerId ?? user.demoResellerId ?? ADMIN_USER_ID;

      try {
        const line = await this.notificationDispatcher.resolveLine(ownerKey);
        if (!line) {
          this.logger.warn('[ConnectionCheck] Sin linea configurada para notificar desconexion.');
          continue;
        }

        const ok = await this.notificationDispatcher.sendText({
          line,
          remoteJid: phone,
          text: DISCONNECTION_MSG,
        });
        if (!ok) throw new Error('No se pudo enviar la notificacion por la linea configurada.');

        this.markNotified(instanceKey, dayKey);
        notified++;
        const count = this.dailyNotified.get(instanceKey)?.count ?? 1;
        this.logger.log(
          `[ConnectionCheck] Notificacion enviada -> ${instance.instanceName} (userId=${user.id}) aviso=${count}/${MAX_DAILY_NOTIFICATIONS} via=${line.instanceName}`,
        );
      } catch (error: any) {
        this.logger.error(
          `[ConnectionCheck] Error enviando notificacion para ${instance.instanceName}`,
          error?.message,
        );
      }
    }

    this.logger.log(
      `[ConnectionCheck] checked=${checked} disconnected=${disconnected} notified=${notified}`,
    );
    return { checked, disconnected, notified };
  }
}
