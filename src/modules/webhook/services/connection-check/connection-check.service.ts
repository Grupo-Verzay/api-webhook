import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { ChatHistoryService } from 'src/modules/chat-history/chat-history.service';
import { buildChatHistorySessionId } from 'src/modules/chat-history/chat-history-session.helper';
import { BaileysSessionManager } from 'src/modules/whatsapp/adapters/baileys/baileys-session.manager';
import { SystemNotificationDispatcherService } from 'src/modules/whatsapp/services/system-notification-dispatcher.service';
import { ChatStoreService } from '../chat-store/chat-store.service';

const ADMIN_USER_ID = process.env.ADMIN_USER_ID ?? 'cm842kthc0000qd2l66nbnytv';
const TIMEOUT_MS = 10_000;
const MAX_DAILY_NOTIFICATIONS = 3;
const TIME_ZONE = 'America/Bogota';
const DISABLED_SENTINEL = '0000000000';

const QR_DISCONNECTION_MESSAGE =
  '📵 El WhatsApp esta *desvinculado* del Agente.\n\n' +
  '*Solución*: entre a su cuenta\n\n' +
  '👉 agente.ia-app.com/profile\n\n' +
  '*Conectar* → en WhatsApp Business: Dispositivos vinculados.\n\n' +
  '*Vincular un dispositivo* y escanee el *QR* 📳';

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
    private readonly chatHistoryService: ChatHistoryService,
    private readonly notificationDispatcher: SystemNotificationDispatcherService,
    private readonly baileysSessions: BaileysSessionManager,
    private readonly chatStore: ChatStoreService,
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
    apiKey: string,
  ): Promise<boolean> {
    try {
      const base = normalizeBase(serverUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(
        `${base}/instance/connect/${encodeURIComponent(instanceName)}`,
        {
          method: 'GET',
          headers: { apikey: apiKey },
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

  private isQrWhatsappType(instanceType: string | null | undefined): boolean {
    const type = String(instanceType ?? 'Whatsapp').trim().toLowerCase();
    return type === 'whatsapp' || type === 'evolution' || type === 'baileys';
  }

  private async isQrInstanceConnected(params: {
    instanceType: string | null | undefined;
    serverUrl?: string | null;
    apiKey?: string | null;
    instanceName: string;
    instanceId: string;
  }): Promise<boolean> {
    const type = String(params.instanceType ?? 'Whatsapp').trim().toLowerCase();
    if (type === 'baileys') {
      return this.baileysSessions.isConnected(params.instanceName);
    }

    const serverUrl = params.serverUrl?.trim();
    const apiKey = params.apiKey?.trim() || params.instanceId;
    if (!serverUrl || !apiKey) return false;
    return this.isInstanceConnected(serverUrl, params.instanceName, apiKey);
  }

  async run(now = new Date()): Promise<{ checked: number; disconnected: number; notified: number }> {
    const dayKey = this.getDayKey(now);

    const users = await this.prisma.user.findMany({
      where: {
        status: true,
        instancias: {
          some: {
            OR: [
              { instanceType: null },
              { instanceType: { in: ['Whatsapp', 'whatsapp', 'evolution', 'baileys'] } },
            ],
          },
        },
      },
      select: {
        id: true,
        ownerId: true,
        demoResellerId: true,
        notificationNumber: true,
        apiKey: { select: { url: true, key: true } },
        // Vínculo cliente→reseller por el sistema VIEJO (tabla `reseller`, columna
        // userId). La vinculación vive en DOS sistemas (nuevo demoResellerId + viejo
        // Reseller.userId); hay que combinar ambos para saber si el cliente pertenece
        // a un reseller. Si solo se mira demoResellerId, un cliente vinculado por el
        // sistema viejo cae al ADMIN (Verzay) y el aviso sale por la línea equivocada.
        reseller_reseller_userIdToUser: {
          select: { resellerid: true },
          take: 1,
        },
        instancias: {
          where: {
            OR: [
              { instanceType: null },
              { instanceType: { in: ['Whatsapp', 'whatsapp', 'evolution', 'baileys'] } },
            ],
          },
          select: { instanceName: true, instanceId: true, instanceType: true },
        },
      },
    });

    let checked = 0;
    let disconnected = 0;
    let notified = 0;

    for (const user of users) {
      const serverUrl = user.apiKey?.url?.trim();
      const apiKey = user.apiKey?.key?.trim();
      const phone = user.notificationNumber;

      if (!phone || phone === DISABLED_SENTINEL) continue;

      for (const instance of user.instancias) {
        if (!instance?.instanceName || !instance.instanceId || !this.isQrWhatsappType(instance.instanceType)) continue;

        const instanceKey = `${user.id}::${instance.instanceName}`;
        checked++;

        const connected = await this.isQrInstanceConnected({
          instanceType: instance.instanceType,
          serverUrl,
          apiKey,
          instanceName: instance.instanceName,
          instanceId: instance.instanceId,
        });
        if (connected) continue;

        disconnected++;

        if (!this.canNotify(instanceKey, dayKey)) {
          this.logger.log(
            `[ConnectionCheck] ${instance.instanceName} desconectada; limite diario alcanzado.`,
          );
          continue;
        }

        // Reseller del cliente combinando AMBOS sistemas de vinculación:
        // nuevo (demoResellerId) + viejo (Reseller.userId → resellerid).
        const legacyResellerId = user.reseller_reseller_userIdToUser[0]?.resellerid ?? null;
        const resellerId = user.demoResellerId ?? legacyResellerId;
        // Si el cliente pertenece a un reseller, la notificación SOLO puede salir por
        // la línea de ese reseller; nunca por Verzay. resolveLine(resellerId) devuelve
        // null (sin fallback global) cuando el reseller no tiene línea disponible, así
        // que basta con no dejar que ownerKey caiga al ADMIN para clientes de reseller.
        const isResellerClient = Boolean(resellerId);
        const ownerKey = user.ownerId ?? resellerId ?? ADMIN_USER_ID;

        try {
          const line = await this.notificationDispatcher.resolveLine(ownerKey);
          if (!line) {
            this.logger.warn(
              isResellerClient
                ? `[ConnectionCheck] Cliente de reseller (${resellerId}) sin linea del reseller para notificar; NO se usa Verzay. instancia=${instance.instanceName}`
                : '[ConnectionCheck] Sin linea configurada para notificar desconexion.',
            );
            continue;
          }

          let ok = false;
          if (line.provider === 'meta') {
            ok = await this.notificationDispatcher.sendMetaTemplate({
              line,
              remoteJid: phone,
              templateName: 'whatsapp_desvinculado_qr',
              params: ['agente.ia-app.com/profile'],
            });
          }

          if (!ok) {
            ok = await this.notificationDispatcher.sendText({
              line,
              remoteJid: phone,
              text: QR_DISCONNECTION_MESSAGE,
            });
          }
          if (!ok) throw new Error('No se pudo enviar la notificacion por la linea configurada.');

          await this.chatHistoryService.saveMessage(
            buildChatHistorySessionId(line.instanceName, phone),
            QR_DISCONNECTION_MESSAGE,
            'ia',
          );

          // Persistir el aviso en la bandeja unificada (chat_messages/
          // chat_conversations) para que aparezca en el panel de Chats de la línea
          // emisora, igual que un envío manual. Sin esto el aviso salía y se
          // entregaba, pero no se veía en Chats (solo quedaba en el historial de IA).
          // Solo para Meta: su envío no persiste por sí mismo y Meta no reenvía el
          // saliente por webhook, así que no hay riesgo de duplicado. Evolution/
          // Baileys ya persisten su saliente por su propio flujo/echo.
          if (line.provider === 'meta') {
            await this.chatStore.persistMessage({
              userId: line.userId,
              instanceName: line.instanceName,
              instanceType: line.instanceType ?? 'meta',
              remoteJid: this.notificationDispatcher.normalizeJid(phone),
              fromMe: true,
              messageType: 'conversation',
              content: QR_DISCONNECTION_MESSAGE,
              messageTimestamp: now,
            });
          }

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
    }

    this.logger.log(
      `[ConnectionCheck] checked=${checked} disconnected=${disconnected} notified=${notified}`,
    );
    return { checked, disconnected, notified };
  }
}
