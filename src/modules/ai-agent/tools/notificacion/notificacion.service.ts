import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { NotificationContactsService } from 'src/modules/ai-agent/services/notificacionService/notification-contacts.service';
import { WhatsAppSenderFactory } from 'src/modules/whatsapp/whatsapp-sender.factory';
import { NodeSenderService } from 'src/modules/workflow/services/node-sender.service.ts/node-sender.service';

@Injectable()
export class NotificacionToolService {
  constructor(
    private readonly nodeSenderService: NodeSenderService,
    private readonly logger: LoggerService,
    private readonly notificationContactsService: NotificationContactsService,
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private normalizePhone(value: string): string {
    const raw = String(value ?? '').split('@')[0];
    return raw.replace(/\D/g, '');
  }

  private buildAdvisorNotificationMessage(args: any, remoteJid: string): string {
    const phone = this.normalizePhone(remoteJid);
    return [
      '\u2705 *Tienes Nueva Solicitud:*',
      '',
      `\uD83D\uDC64 *Nombre:* ${args.nombre ?? 'Contacto'}`,
      '\uD83D\uDCDD *Descripcion:*',
      `${args.detalles ?? 'Solicitud recibida desde el chat.'}`,
      '',
      '\uD83D\uDCF1 *WhatsApp del usuario:*',
      '',
      `\uD83D\uDC49 +${phone}`,
    ].join('\n');
  }

  private getSenderFactory(): WhatsAppSenderFactory | null {
    try {
      return this.moduleRef.get(WhatsAppSenderFactory, { strict: false });
    } catch {
      return null;
    }
  }

  async handleNotificacionTool(
    args: any,
    sessionId: string,
    server_url: string,
    apikey: string,
    instanceName: string,
    remoteJid: string,
  ): Promise<string> {
    try {
      const phones = await this.notificationContactsService.getActiveNumbers(sessionId);

      if (phones.length === 0) {
        throw new Error('El usuario no tiene numeros de notificacion configurados');
      }

      const clientPhone = this.normalizePhone(remoteJid);
      const message = this.buildAdvisorNotificationMessage(args, remoteJid);
      const instance = await this.prisma.instancia.findFirst({
        where: { userId: sessionId, instanceName },
        select: {
          instanceType: true,
          metaPhoneNumberId: true,
          metaAccessToken: true,
          metaChannel: true,
        },
      });

      const senderFactory = this.getSenderFactory();
      const instanceType = (instance?.instanceType ?? '').toLowerCase();
      const metaChannel = (instance?.metaChannel ?? 'whatsapp').toLowerCase();

      if (instanceType === 'meta' && metaChannel === 'whatsapp') {
        const phoneNumberId = instance?.metaPhoneNumberId || server_url;
        const accessToken = instance?.metaAccessToken || apikey;
        const metaSender: any = senderFactory?.getSenderSync('meta');
        const details = String(args.detalles ?? 'Solicitud recibida desde el chat.');
        const contactName = String(args.nombre ?? 'Contacto');
        const isAdvisorRequest = /asesor|humano|transfer|esperando tu respuesta/i.test(details);
        const templateName = isAdvisorRequest ? 'solicitud_asesor' : 'notificacion_evento';
        const templateParams = isAdvisorRequest
          ? [contactName, `+${clientPhone}`]
          : ['Solicitud', contactName, details, `+${clientPhone}`];

        if (!phoneNumberId || !accessToken || typeof metaSender?.sendTemplate !== 'function') {
          throw new Error('Instancia Meta sin credenciales completas para notificacion interna.');
        }

        const results = await Promise.all(
          phones.map((phone) =>
            metaSender.sendTemplate(
              phoneNumberId,
              accessToken,
              phone,
              templateName,
              'es_CO',
              templateParams,
            ),
          ),
        );

        if (results.some((result: any) => !result?.ok)) {
          throw new Error('Meta rechazo una o mas notificaciones internas.');
        }

        return 'ok';
      }

      if (senderFactory) {
        const sender = senderFactory.getSenderSync(instance?.instanceType);
        const results = await Promise.all(
          phones.map((phone) =>
            sender.sendText(instanceName, phone, message, server_url, apikey),
          ),
        );

        if (results.some((ok) => !ok)) {
          throw new Error('No se pudo enviar una o mas notificaciones internas.');
        }

        return 'ok';
      }

      const url = `${server_url}/message/sendText/${instanceName}`;

      await Promise.all(
        phones.map((phone) =>
          this.nodeSenderService.sendTextNode(url, apikey, phone, message),
        ),
      );

      return 'ok';
    } catch (error) {
      this.logger.error(
        'Error enviando notificacion',
        error?.message,
        'NotificacionToolService',
      );
      return '[ERROR_SENDING_NOTIFICATION]';
    }
  }
}
