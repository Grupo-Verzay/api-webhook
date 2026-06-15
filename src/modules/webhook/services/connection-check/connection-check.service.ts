import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { NodeSenderService } from 'src/modules/workflow/services/node-sender.service.ts/node-sender.service';

const ADMIN_USER_ID = process.env.ADMIN_USER_ID ?? 'cm842kthc0000qd2l66nbnytv';
const TIMEOUT_MS = 10_000;
const MAX_DAILY_NOTIFICATIONS = 3;
const TIME_ZONE = 'America/Bogota';
const DISABLED_SENTINEL = '0000000000';

const DISCONNECTION_MSG =
  `📵 El WhatsApp esta *desvinculado* del Agente.\n\n*Solución*: entre a su cuenta\n\n👉 agente.ia-app.com/profile\n\n*Conectar* → en WhatsApp Business: Dispositivos vinculados.\n\n*Vincular un dispositivo* y escanee el *QR*  📳`;

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
    private readonly nodeSenderService: NodeSenderService,
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

    const adminUser = await this.prisma.user.findUnique({
      where: { id: ADMIN_USER_ID },
      include: {
        apiKey: { select: { url: true } },
        instancias: {
          where: { instanceType: 'Whatsapp' },
          select: { instanceName: true, instanceId: true },
          take: 1,
        },
      },
    });

    const adminInstance = adminUser?.instancias[0];
    const adminApiUrl = adminUser?.apiKey?.url?.trim();

    if (!adminInstance || !adminApiUrl) {
      this.logger.warn('[ConnectionCheck] Sin instancia admin disponible para enviar notificaciones.');
      return { checked: 0, disconnected: 0, notified: 0 };
    }

    const adminBase = normalizeBase(adminApiUrl);
    const adminSendUrl = `${adminBase}/message/sendText/${encodeURIComponent(adminInstance.instanceName)}`;

    const users = await this.prisma.user.findMany({
      where: {
        status: true,
        instancias: { some: { instanceType: 'Whatsapp' } },
      },
      select: {
        id: true,
        ownerId: true,
        notificationNumber: true,
        apiKey: { select: { url: true } },
        instancias: {
          where: { instanceType: 'Whatsapp' },
          select: { instanceName: true, instanceId: true },
          take: 1,
        },
      },
    });

    // Precarga instancias de resellers en bulk para evitar N+1
    const ownerIds = [...new Set(users.map(u => u.ownerId).filter(Boolean))] as string[];
    const resellerSenderMap = new Map<string, { sendUrl: string; senderApikey: string }>();

    if (ownerIds.length > 0) {
      const owners = await this.prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: {
          id: true,
          apiKey: { select: { url: true } },
          instancias: {
            where: { instanceType: 'Whatsapp' },
            select: { instanceName: true, instanceId: true },
            take: 1,
          },
        },
      });
      for (const owner of owners) {
        const inst = owner.instancias[0];
        const srv = owner.apiKey?.url?.trim();
        if (inst && srv) {
          const base = normalizeBase(srv);
          resellerSenderMap.set(owner.id, {
            sendUrl: `${base}/message/sendText/${encodeURIComponent(inst.instanceName)}`,
            senderApikey: inst.instanceId,
          });
        }
      }
    }

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
          `[ConnectionCheck] ${instance.instanceName} desconectada — límite diario alcanzado.`,
        );
        continue;
      }

      // Usar instancia del reseller si el usuario le pertenece; si no, usar admin
      const resellerSender = user.ownerId ? resellerSenderMap.get(user.ownerId) : undefined;
      const senderUrl = resellerSender?.sendUrl ?? adminSendUrl;
      const senderApikey = resellerSender?.senderApikey ?? adminInstance.instanceId;

      try {
        await this.nodeSenderService.sendTextNode(
          senderUrl,
          senderApikey,
          phone,
          DISCONNECTION_MSG,
        );
        this.markNotified(instanceKey, dayKey);
        notified++;
        const count = this.dailyNotified.get(instanceKey)?.count ?? 1;
        const via = resellerSender ? `reseller=${user.ownerId}` : 'admin';
        this.logger.log(
          `[ConnectionCheck] Notificación enviada → ${instance.instanceName} (userId=${user.id}) aviso=${count}/${MAX_DAILY_NOTIFICATIONS} via=${via}`,
        );
      } catch (error: any) {
        this.logger.error(
          `[ConnectionCheck] Error enviando notificación para ${instance.instanceName}`,
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
