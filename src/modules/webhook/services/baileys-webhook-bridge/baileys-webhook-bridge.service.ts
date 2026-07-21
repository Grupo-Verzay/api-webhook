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

    // Resolve real phone JID for @lid contacts.
    // WhatsApp/Meta ahora entrega el remitente como @lid (ID de privacidad, NO el
    // teléfono). Hay que resolverlo al número real ANTES de procesar, o se crea una
    // "conversación fantasma" con el ID largo, sin nombre ni historial. El puente es
    // el punto de estrangulamiento: si aquí dejamos el teléfono en remoteJidAlt,
    // todo lo de abajo (sesión CRM, inbox unificado) queda anclado al número real.
    let remoteJidAlt = remoteJid;
    if (remoteJid.toLowerCase().endsWith('@lid')) {
      const persistPhone = (jid: string) => {
        const phoneDigits = jid.replace(/@[^@]*$/, '').replace(/\D/g, '');
        if (phoneDigits) {
          this.messageStore.updateContactPhone(instanceName, remoteJid, phoneDigits).catch(() => {});
        }
      };

      // 1º: Baileys resuelve key.remoteJidAlt desde su auth state
      const baileysAlt: string = key.remoteJidAlt ?? '';
      if (baileysAlt && !baileysAlt.toLowerCase().endsWith('@lid')) {
        remoteJidAlt = baileysAlt;
        persistPhone(baileysAlt);
      } else {
        // 2º: mapeo NATIVO de Baileys (lidMapping) — autoridad para LID→PN.
        // Se sincroniza vía USync/historial, así que resuelve incluso el primer
        // mensaje que llega como @lid puro (el hueco que creaba los fantasmas).
        let resolvedPhoneJid = '';
        try {
          const socket: any = this.sessions.getSocket(instanceName);
          const pn: string | null | undefined =
            await socket?.signalRepository?.lidMapping?.getPNForLID?.(remoteJid);
          if (pn && !pn.toLowerCase().endsWith('@lid')) {
            resolvedPhoneJid = pn;
          }
        } catch (err: any) {
          this.logger.error(`[BaileyseBridge] getPNForLID falló para ${remoteJid}: ${err?.message}`, 'BaileysWebhookBridgeService');
        }

        if (resolvedPhoneJid) {
          remoteJidAlt = resolvedPhoneJid;
          persistPhone(resolvedPhoneJid);
        } else {
          // 3º: fallback a nuestra BD (mapeos ya aprendidos)
          const phoneNumber = await this.messageStore.getContactPhone(instanceName, remoteJid);
          if (phoneNumber) {
            remoteJidAlt = `${phoneNumber}@s.whatsapp.net`;
          }
        }
      }
    }

    // senderPn explícito para que el webhook aprenda el mapeo LID→teléfono
    // (chat_lid_map) y ancle la conversación al número real.
    const senderPn =
      remoteJidAlt !== remoteJid && remoteJidAlt.toLowerCase().endsWith('@s.whatsapp.net')
        ? remoteJidAlt
        : '';

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

    if (messageType === 'documentMessage') {
      const result = await this.downloadMediaAsBase64(message, 'document');
      if (result) {
        mediaBase64 = result.base64;
        mediaMimetype = result.mimetype;
        this.logger.log(`[BaileyseBridge] Documento descargado para ${instanceName} (${Math.round(result.base64.length * 0.75 / 1024)}KB, ${result.mimetype})`, 'BaileysWebhookBridgeService');
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
          senderPn,
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
