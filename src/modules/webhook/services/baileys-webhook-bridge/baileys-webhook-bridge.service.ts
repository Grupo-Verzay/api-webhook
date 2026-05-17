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

  private async downloadMediaAsBase64(message: any, mediaType: 'image' | 'audio' | 'video' | 'document'): Promise<{ base64: string; mimetype: string } | null> {
    try {
      const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
      const mediaMsg = message[`${mediaType}Message`];
      if (!mediaMsg) return null;

      const stream = await downloadContentFromMessage(mediaMsg, mediaType);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      const buffer = Buffer.concat(chunks);
      return {
        base64: buffer.toString('base64'),
        mimetype: mediaMsg.mimetype ?? `${mediaType}/jpeg`,
      };
    } catch (err: any) {
      this.logger.error(`[BaileyseBridge] Error descargando media (${mediaType}): ${err?.message}`, 'BaileysWebhookBridgeService');
      return null;
    }
  }

  private async handleMessage(instanceName: string, msg: any): Promise<void> {
    const key = msg.key ?? {};
    const remoteJid: string = key.remoteJid ?? '';
    const message = msg.message ?? {};
    const messageType = Object.keys(message)[0] ?? 'conversation';

    // Resolve real phone JID for @lid contacts
    let remoteJidAlt = remoteJid;
    if (remoteJid.toLowerCase().endsWith('@lid')) {
      // 1st: Baileys resuelve key.remoteJidAlt desde su auth state
      const baileysAlt: string = key.remoteJidAlt ?? '';
      if (baileysAlt && !baileysAlt.toLowerCase().endsWith('@lid')) {
        remoteJidAlt = baileysAlt;
        // Persistir en BD para próximos usos
        const phoneDigits = baileysAlt.replace(/@[^@]*$/, '').replace(/\D/g, '');
        if (phoneDigits) {
          this.messageStore.updateContactPhone(instanceName, remoteJid, phoneDigits).catch(() => {});
        }
      } else {
        // 2nd: fallback a nuestra BD
        const phoneNumber = await this.messageStore.getContactPhone(instanceName, remoteJid);
        if (phoneNumber) {
          remoteJidAlt = `${phoneNumber}@s.whatsapp.net`;
        }
      }
    }

    // Para imágenes y audio de Baileys, descargar la media y agregar base64 al payload.
    // Evolution API provee mediaUrl; Baileys necesita descarga directa via downloadContentFromMessage.
    let mediaBase64: string | undefined;
    let mediaMimetype: string | undefined;

    if (messageType === 'imageMessage') {
      const result = await this.downloadMediaAsBase64(message, 'image');
      if (result) {
        mediaBase64 = result.base64;
        mediaMimetype = result.mimetype;
        this.logger.log(`[BaileyseBridge] Imagen descargada para ${instanceName} (${Math.round(result.base64.length * 0.75 / 1024)}KB)`, 'BaileysWebhookBridgeService');
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
        message: {
          ...message,
          // Campos adicionales para que message-type-handler los use igual que Evolution API
          ...(mediaBase64 && { mediaBase64, mediaMimetype }),
        },
        messageType,
      },
    };

    await this.webhookService.processWebhook(payload as any);
  }
}
