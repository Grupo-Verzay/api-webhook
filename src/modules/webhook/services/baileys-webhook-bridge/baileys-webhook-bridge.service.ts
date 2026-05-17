import { Injectable, OnModuleInit } from '@nestjs/common';
import { BaileysSessionManager } from 'src/modules/whatsapp/adapters/baileys/baileys-session.manager';
import { BaileysMessageStore } from 'src/modules/whatsapp/adapters/baileys/baileys-message.store';
import { WebhookService } from '../../webhook.service';
import { LoggerService } from 'src/core/logger/logger.service';

@Injectable()
export class BaileysWebhookBridgeService implements OnModuleInit {
  constructor(
    private readonly sessions: BaileysSessionManager,
    private readonly messageStore: BaileysMessageStore,
    private readonly webhookService: WebhookService,
    private readonly logger: LoggerService,
  ) {}

  onModuleInit() {
    this.sessions.registerMessageHandler((instanceName, msg) => {
      this.handleMessage(instanceName, msg).catch((err) =>
        this.logger.error(`[BaileyseBridge] Error procesando mensaje de ${instanceName}`, err?.message, 'BaileysWebhookBridgeService'),
      );
    });
  }

  private async handleMessage(instanceName: string, msg: any): Promise<void> {
    const key = msg.key ?? {};
    const remoteJid: string = key.remoteJid ?? '';
    const message = msg.message ?? {};
    const messageType = Object.keys(message)[0] ?? 'conversation';

    // Resolve real phone JID for @lid contacts from our contact store
    let remoteJidAlt = remoteJid;
    if (remoteJid.toLowerCase().endsWith('@lid')) {
      const phoneNumber = await this.messageStore.getContactPhone(instanceName, remoteJid);
      if (phoneNumber) {
        remoteJidAlt = `${phoneNumber}@s.whatsapp.net`;
      }
    }

    const payload = {
      event: 'messages.upsert',
      instance: instanceName,
      server_url: '',
      apikey: '',
      data: {
        key: {
          remoteJid,
          remoteJidAlt,
          fromMe: key.fromMe ?? false,
          id: key.id ?? '',
          participant: key.participant ?? '',
          participantAlt: key.participantAlt ?? key.participant ?? '',
          addressingMode: 'lid',
        },
        pushName: msg.pushName ?? '',
        status: 'DELIVERY_ACK',
        message,
        messageType,
      },
    };

    await this.webhookService.processWebhook(payload as any);
  }
}
