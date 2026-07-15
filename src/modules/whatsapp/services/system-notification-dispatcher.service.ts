import { Injectable } from '@nestjs/common';

import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';

import { WhatsAppSenderFactory } from '../whatsapp-sender.factory';

const DEFAULT_SYSTEM_NOTIFICATION_INSTANCE =
  process.env.NOTIFICATIONS_WHATSAPP_INSTANCE ||
  process.env.BILLING_WHATSAPP_INSTANCE ||
  process.env.TRIAL_FOLLOWUP_WHATSAPP_INSTANCE ||
  'VERZAY_NOTIFICACIONES_wh';

type NotificationProvider = 'meta' | 'baileys' | 'evolution';

export type NotificationLine = {
  userId: string;
  notificationNumber: string | null;
  instanceName: string;
  instanceId: string;
  instanceType: string | null;
  serverUrl: string | null;
  apiKey: string | null;
  metaPhoneNumberId: string | null;
  metaAccessToken: string | null;
  metaChannel: string | null;
  provider: NotificationProvider;
};

@Injectable()
export class SystemNotificationDispatcherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly senderFactory: WhatsAppSenderFactory,
    private readonly logger: LoggerService,
  ) {}

  normalizePhone(value: string | null | undefined): string {
    return String(value ?? '').split('@')[0].replace(/\D/g, '');
  }

  normalizeJid(value: string | null | undefined): string {
    const phone = this.normalizePhone(value);
    return phone ? `${phone}@s.whatsapp.net` : '';
  }

  private normalizeBase(url: string | null | undefined): string | null {
    const value = String(url ?? '').trim().replace(/\/+$/, '');
    if (!value) return null;
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  }

  private providerFor(instanceType: string | null | undefined): NotificationProvider {
    const type = String(instanceType ?? '').trim().toLowerCase();
    if (type === 'meta') return 'meta';
    if (type === 'baileys') return 'baileys';
    return 'evolution';
  }

  async resolveConfiguredInstanceName(ownerUserId?: string | null): Promise<string> {
    const ownerId = ownerUserId?.trim();

    try {
      if (ownerId) {
        const rows = await this.prisma.$queryRaw<Array<{ instanceName: string | null }>>`
          SELECT "instanceName"
          FROM "reseller_billing_configs"
          WHERE "resellerId" = ${ownerId}
            AND "enabled" = true
            AND "instanceName" IS NOT NULL
            AND btrim("instanceName") <> ''
          ORDER BY "updatedAt" DESC
          LIMIT 1
        `;
        const instanceName = rows[0]?.instanceName?.trim();
        if (instanceName) return instanceName;

        return '';
      }

      const rows = await this.prisma.$queryRaw<Array<{ instanceName: string | null }>>`
        SELECT r."instanceName"
        FROM "reseller_billing_configs" r
        JOIN "User" u ON u."id" = r."resellerId"
        WHERE r."enabled" = true
          AND r."instanceName" IS NOT NULL
          AND btrim(r."instanceName") <> ''
        ORDER BY
          CASE
            WHEN lower(coalesce(u."company", '') || ' ' || coalesce(u."name", '')) LIKE '%verzay%'
              OR lower(coalesce(u."company", '') || ' ' || coalesce(u."name", '')) LIKE '%grupo%'
            THEN 0 ELSE 1
          END,
          r."updatedAt" DESC
        LIMIT 1
      `;

      return rows[0]?.instanceName?.trim() || DEFAULT_SYSTEM_NOTIFICATION_INSTANCE;
    } catch (error) {
      this.logger.warn(
        `[SystemNotificationDispatcher] No se pudo leer configuracion de notificaciones: ${(error as Error)?.message ?? 'sin detalle'}`,
      );
      return ownerId ? '' : DEFAULT_SYSTEM_NOTIFICATION_INSTANCE;
    }
  }

  async resolveLineByInstanceName(instanceName: string): Promise<NotificationLine | null> {
    const exactName = instanceName.trim();
    if (!exactName) return null;
    const candidates = [...new Set([
      exactName,
      exactName.endsWith('_wh') ? exactName.slice(0, -3) : `${exactName}_wh`,
    ])];

    const user = await this.prisma.user.findFirst({
      where: {
        instancias: {
          some: { instanceName: { in: candidates } },
        },
      },
      select: {
        id: true,
        notificationNumber: true,
        apiKey: { select: { url: true, key: true } },
        instancias: {
          where: { instanceName: { in: candidates } },
          take: 1,
          select: {
            instanceName: true,
            instanceId: true,
            instanceType: true,
            metaPhoneNumberId: true,
            metaAccessToken: true,
            metaChannel: true,
          },
        },
      },
    });

    const instance = user?.instancias[0];
    if (!user || !instance?.instanceName || !instance.instanceId) return null;

    const provider = this.providerFor(instance.instanceType);
    if (provider === 'meta' && String(instance.metaChannel ?? 'whatsapp').toLowerCase() !== 'whatsapp') {
      return null;
    }

    return {
      userId: user.id,
      notificationNumber: user.notificationNumber,
      instanceName: instance.instanceName,
      instanceId: instance.instanceId,
      instanceType: instance.instanceType,
      serverUrl: provider === 'evolution' ? this.normalizeBase(user.apiKey?.url) : null,
      apiKey: provider === 'evolution' ? user.apiKey?.key ?? null : null,
      metaPhoneNumberId: instance.metaPhoneNumberId,
      metaAccessToken: instance.metaAccessToken,
      metaChannel: instance.metaChannel,
      provider,
    };
  }

  private async resolveOwnerDefaultLine(ownerUserId?: string | null): Promise<NotificationLine | null> {
    const ownerId = ownerUserId?.trim();
    if (!ownerId) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: {
        id: true,
        notificationNumber: true,
        apiKey: { select: { url: true, key: true } },
        instancias: {
          select: {
            instanceName: true,
            instanceId: true,
            instanceType: true,
            metaPhoneNumberId: true,
            metaAccessToken: true,
            metaChannel: true,
          },
        },
      },
    });

    if (!user?.instancias?.length) return null;

    const whatsappInstances = user.instancias.filter((instance) => {
      if (!instance.instanceName || !instance.instanceId) return false;
      const provider = this.providerFor(instance.instanceType);
      return provider !== 'meta' || String(instance.metaChannel ?? 'whatsapp').toLowerCase() === 'whatsapp';
    });

    const instance =
      whatsappInstances.find((item) => this.providerFor(item.instanceType) === 'meta' && item.metaPhoneNumberId && item.metaAccessToken) ??
      whatsappInstances.find((item) => this.providerFor(item.instanceType) === 'baileys') ??
      whatsappInstances[0];

    if (!instance?.instanceName || !instance.instanceId) return null;

    const provider = this.providerFor(instance.instanceType);

    return {
      userId: user.id,
      notificationNumber: user.notificationNumber,
      instanceName: instance.instanceName,
      instanceId: instance.instanceId,
      instanceType: instance.instanceType,
      serverUrl: provider === 'evolution' ? this.normalizeBase(user.apiKey?.url) : null,
      apiKey: provider === 'evolution' ? user.apiKey?.key ?? null : null,
      metaPhoneNumberId: instance.metaPhoneNumberId,
      metaAccessToken: instance.metaAccessToken,
      metaChannel: instance.metaChannel,
      provider,
    };
  }

  async resolveLine(ownerUserId?: string | null): Promise<NotificationLine | null> {
    const configured = await this.resolveConfiguredInstanceName(ownerUserId);
    const line = await this.resolveLineByInstanceName(configured);
    if (line) return line;

    if (ownerUserId?.trim()) {
      const ownerLine = await this.resolveOwnerDefaultLine(ownerUserId);
      if (ownerLine) return ownerLine;

      this.logger.warn(
        `[SystemNotificationDispatcher] Sin linea propia para userId=${ownerUserId}. No se usara la linea global.`,
      );
      return null;
    }

    return configured !== DEFAULT_SYSTEM_NOTIFICATION_INSTANCE
      ? this.resolveLineByInstanceName(DEFAULT_SYSTEM_NOTIFICATION_INSTANCE)
      : null;
  }

  async getNotificationPhones(userId: string): Promise<string[]> {
    const contacts = await this.prisma.userNotificationContact.findMany({
      where: { userId },
      select: { phone: true },
    });
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificationNumber: true },
    });

    const phones = [
      ...contacts.map((contact) => this.normalizePhone(contact.phone)),
      this.normalizePhone(user?.notificationNumber),
    ].filter((phone) => phone && phone !== '0000000000');

    return [...new Set(phones)];
  }

  async sendText(args: { line: NotificationLine; remoteJid: string; text: string }): Promise<boolean> {
    const jid = this.normalizeJid(args.remoteJid);
    if (!jid) return false;

    const sender = this.senderFactory.getSenderSync(args.line.instanceType);

    if (args.line.provider === 'meta') {
      return sender.sendText(
        args.line.instanceName,
        jid,
        args.text,
        args.line.metaPhoneNumberId ?? undefined,
        args.line.metaAccessToken ?? undefined,
      );
    }

    if (args.line.provider === 'baileys') {
      return sender.sendText(args.line.instanceName, jid, args.text);
    }

    return sender.sendText(
      args.line.instanceName,
      jid,
      args.text,
      args.line.serverUrl ?? undefined,
      args.line.apiKey ?? args.line.instanceId,
    );
  }

  async sendMetaTemplate(args: {
    line: NotificationLine;
    remoteJid: string;
    templateName: string;
    params: string[];
    languageCode?: string;
  }): Promise<boolean> {
    const jid = this.normalizeJid(args.remoteJid);
    if (!jid || args.line.provider !== 'meta') return false;

    const metaSender: any = this.senderFactory.getSenderSync('meta');
    if (!args.line.metaPhoneNumberId || !args.line.metaAccessToken || typeof metaSender?.sendTemplate !== 'function') {
      return false;
    }

    const languageCodes = Array.from(
      new Set([args.languageCode, 'es', 'es_CO'].filter(Boolean) as string[]),
    );

    let lastError: string | undefined;
    for (const languageCode of languageCodes) {
      const result = await metaSender.sendTemplate(
        args.line.metaPhoneNumberId,
        args.line.metaAccessToken,
        jid,
        args.templateName,
        languageCode,
        args.params,
      );

      if (result?.ok) return true;
      lastError = result?.error;
    }

    if (lastError) {
      this.logger.warn(
        `[SystemNotificationDispatcher] Meta rechazo plantilla ${args.templateName}: ${lastError}`,
      );
    }

    return false;
  }

  async sendInternalNotification(args: {
    ownerUserId?: string | null;
    targetUserId?: string | null;
    type: string;
    name: string;
    description: string;
    contact: string;
  }): Promise<number> {
    const line = await this.resolveLine(args.ownerUserId);
    if (!line) {
      this.logger.warn('[SystemNotificationDispatcher] No hay linea de notificaciones disponible.');
      return 0;
    }

    const targetUserId = args.targetUserId ?? line.userId;
    const phones = await this.getNotificationPhones(targetUserId);
    if (!phones.length) return 0;

    const contact = this.normalizePhone(args.contact);
    const legacyText = [
      `✅ *Nuevo aviso: ${args.type}*`,
      '',
      `👤 *Nombre:* ${args.name}`,
      `📝 *Descripción:* ${args.description}`,
      '',
      '📱 *Contacto:*',
      `📲 +${contact || 'Sin numero'}`,
      '--------•--------•--------•--------',
      'Evento registrado',
    ].join('\n');

    void legacyText;
    const fallbackText = [
      `✅ *Nuevo aviso: ${args.type}*`,
      '',
      `👤 *Nombre:* ${args.name}`,
      `📝 *Descripción:* ${args.description}`,
      '',
      '📱 *Contacto:*',
      `📲 +${contact || 'Sin numero'}`,
      '--------•--------•--------•--------',
      'Evento registrado',
    ].join('\n');

    void fallbackText;
    const text = [
      `\u2705 *Nuevo aviso: ${args.type}*`,
      '',
      `\u{1F464} *Nombre:* ${args.name}`,
      `\u{1F4DD} *Descripci\u00f3n:* ${args.description}`,
      '',
      '\u{1F4F1} *Contacto:*',
      `\u{1F4F2} +${contact || 'Sin numero'}`,
      '--------\u2022--------\u2022--------\u2022--------',
      'Evento registrado',
    ].join('\n');

    let sent = 0;
    const isAdvisorRequest = /solicitud\s+de\s+asesor/i.test(args.type);

    for (const phone of phones) {
      let ok = false;

      if (line.provider === 'meta') {
        ok = await this.sendMetaTemplate({
          line,
          remoteJid: phone,
          templateName: isAdvisorRequest ? 'solicitud_asesor' : 'notificacion_evento',
          params: isAdvisorRequest
            ? [args.name, `+${contact || 'Sin numero'}`]
            : [args.type, args.name, args.description, `+${contact || 'Sin numero'}`],
        });

        if (!ok) {
          ok = await this.sendText({ line, remoteJid: phone, text });
        }
      } else {
        ok = await this.sendText({ line, remoteJid: phone, text });
      }

      if (ok) sent++;
    }

    return sent;
  }
}
