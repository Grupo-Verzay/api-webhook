import { Injectable } from '@nestjs/common';

import { AiAgentService } from '../ai-agent/ai-agent.service';

import { SessionService } from '../session/session.service';
import { LoggerService } from 'src/core/logger/logger.service';
import { WebhookBodyDto } from './dto/webhook-body';
import { MessageDirectionService } from './services/message-direction/message-direction.service';
import { MessageTypeHandlerService } from './services/message-type-handler/message-type-handler.service';
import { InstancesService } from '../instances/instances.service';
import { UserService } from '../user/user.service';
import { isGroupChat } from './utils/is-group-chat';
import { MessageBufferService } from './services/message-buffer/message-buffer.service';
import { ChatHistoryService } from '../chat-history/chat-history.service';
import { NodeSenderService } from '../workflow/services/node-sender.service.ts/node-sender.service';
import { WorkflowService } from '../workflow/services/workflow.service.ts/workflow.service';
import { AiCreditsService } from '../ai-credits/ai-credits.service';
import {
  CreditValidationInput,
  creditFlags,
  UserWithPausar,
} from 'src/types/open-ai';
import { AntifloodService } from './services/antiflood/antiflood.service';
import { executeWorkflow } from 'src/utils/execute-workflow';
import {
  isRegisterableContactJid,
  pickExplicitWhatsAppPhoneJid,
  pickObservedAlternateRemoteJid,
  pickPreferredWhatsAppRemoteJid,
} from 'src/utils/whatsapp-jid.util';
import { LeadFunnelService } from '../lead-funnel/services/lead-funnel/lead-funnel.service';
import { buildChatHistorySessionId } from '../chat-history/chat-history-session.helper';
import { FollowUpRunnerService } from './services/follow-up-runner/follow-up-runner.service';
import { PaymentReceiptProcessorService } from 'src/modules/payment-receipt/services/payment-receipt-processor.service';
import { TtsService } from '../ai-agent/services/tts/tts.service';
import { normalizeTextForTts } from '../ai-agent/services/tts/tts-normalizer';
import { WhatsAppSenderFactory } from '../whatsapp/whatsapp-sender.factory';
import { BaileysSenderAdapter } from '../whatsapp/adapters/baileys/baileys-sender.adapter';
import { MessageDeduplicationService } from './services/message-deduplication/message-deduplication.service';
import { ConversationControlService } from './services/conversation-control/conversation-control.service';
import { SessionOrchestrationService } from './services/session-orchestration/session-orchestration.service';
import { ChatEventsGateway } from '../realtime/chat-events.gateway';
import { ChatStoreService } from './services/chat-store/chat-store.service';
import { PrismaService } from 'src/database/prisma.service';

@Injectable()
export class WebhookService {
  public static readonly DELAYCONVERSATION = 10000;

  /** Contactos con un callback de buffer actualmente en ejecución */
  private readonly processingContacts = new Set<string>();

  constructor(
    private readonly logger: LoggerService,
    private readonly aiAgentService: AiAgentService,
    private readonly sessionService: SessionService,
    private readonly userService: UserService,
    private readonly instancesService: InstancesService,
    private readonly messageDirectionService: MessageDirectionService,
    private readonly messageTypeHandlerService: MessageTypeHandlerService,
    private readonly messageBufferService: MessageBufferService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly nodeSenderService: NodeSenderService,
    private readonly workflowService: WorkflowService,
    private readonly aiCreditsService: AiCreditsService,
    private readonly antifloodService: AntifloodService,
    private readonly leadFunnelService: LeadFunnelService,
    private readonly followUpRunnerService: FollowUpRunnerService,
    private readonly paymentReceiptProcessor: PaymentReceiptProcessorService,
    private readonly ttsService: TtsService,
    private readonly whatsAppSenderFactory: WhatsAppSenderFactory,
    private readonly baileysSender: BaileysSenderAdapter,
    private readonly messageDeduplication: MessageDeduplicationService,
    private readonly conversationControl: ConversationControlService,
    private readonly sessionOrchestration: SessionOrchestrationService,
    private readonly chatEvents: ChatEventsGateway,
    private readonly chatStore: ChatStoreService,
    private readonly prisma: PrismaService,
  ) { }

  /** Canales cuyos mensajes se persisten en el store unificado (no pasan por Evolution). */
  private isUnifiedStoreChannel(source?: string): boolean {
    return source === 'telegram' || source === 'meta';
  }

  /**
   * Crea un logger con contexto fijo para prefijar todos los mensajes.
   */
  private scopedLogger(ctx: {
    userId?: string;
    instanceName?: string;
    remoteJid?: string;
  }) {
    const tag = `[UID=${ctx.userId ?? '-'}][I=${ctx.instanceName ?? '-'}][R=${ctx.remoteJid ?? '-'}]`;
    return {
      log: (msg: string, context = 'WebhookService') =>
        this.logger.log(`${tag} ${msg}`, context),
      debug: (msg: string) =>
        this.logger.debug(`${tag} ${msg}`, 'WebhookService'),
      warn: (msg: string, context = 'WebhookService') =>
        this.logger.warn(`${tag} ${msg}`, context),
      error: (msg: string, err?: any, context = 'WebhookService') =>
        this.logger.error(`${tag} ${msg}`, err, context),
    };
  }

  /**
   * Devuelve una función de envío de texto que usa Baileys cuando server_url está vacío,
   * o Evolution API cuando está presente.
   */
  private makeSendTextFn(
    instanceName: string,
    server_url: string,
    apikey: string,
    userId?: string,
    source?: string,
  ): (remoteJid: string, text: string) => Promise<void> {
    // Notifica en tiempo real que el chat cambió tras un envío saliente.
    // Envuelto para no afectar nunca el resultado del envío.
    const notify = (remoteJid: string) => {
      if (userId) {
        this.chatEvents.emitChatChanged({ userId, remoteJid, instanceName });
      }
    };

    // Persiste el saliente en el store unificado (canales no-Evolution).
    const persistOutbound = (channel: string, remoteJid: string, text: string, ok: boolean) => {
      if (ok && userId) {
        void this.chatStore.persistMessage({
          userId,
          instanceName,
          instanceType: channel,
          remoteJid,
          fromMe: true,
          messageType: 'conversation',
          content: text,
          // Marca de "Agente IA" para el panel (respuesta del bot, no de un asesor).
          raw: { sentByAi: true },
          messageTimestamp: Math.floor(Date.now() / 1000),
        });
      }
    };

    if (!server_url) {
      const sender = this.whatsAppSenderFactory.getSenderSync('baileys');
      return (remoteJid, text) =>
        sender.sendText(instanceName, remoteJid, text).then(() => {
          notify(remoteJid);
        });
    }
    // Telegram: server_url es el sentinel "telegram" y apikey es el bot token.
    if (server_url === 'telegram') {
      const sender = this.whatsAppSenderFactory.getSenderSync('telegram');
      return (remoteJid, text) =>
        sender.sendText(instanceName, remoteJid, text, server_url, apikey).then((ok) => {
          notify(remoteJid);
          persistOutbound('telegram', remoteJid, text, ok);
        });
    }
    // Meta (WhatsApp Cloud / Facebook / Instagram): usa el adaptador de Graph API.
    // server_url es el phoneNumberId/pageId y apikey es el access token.
    if (source === 'meta') {
      const sender = this.whatsAppSenderFactory.getSenderSync('meta');
      return (remoteJid, text) =>
        sender.sendText(instanceName, remoteJid, text, server_url, apikey).then((ok) => {
          notify(remoteJid);
          persistOutbound('meta', remoteJid, text, ok);
        });
    }
    // Evolution API. Se usa sendTextNodeReturnId (idéntico a sendTextNode pero
    // devuelve el messageId real de Evolution) para persistir el saliente con ese
    // id: así, cuando la app resincronice desde Evolution, el ON CONFLICT lo
    // dedupe en vez de duplicar la respuesta del agente. (Fase 2.5)
    const apiMsgUrl = `${server_url}/message/sendText/${instanceName}`;
    return (remoteJid, text) =>
      this.nodeSenderService
        .sendTextNodeReturnId(apiMsgUrl, apikey, remoteJid, text)
        .then((sentId) => {
          notify(remoteJid);
          if (sentId && userId) {
            void this.chatStore.persistMessage({
              userId,
              instanceName,
              instanceType: 'evolution',
              remoteJid,
              messageId: sentId,
              fromMe: true,
              messageType: 'conversation',
              content: text,
              // Marca de "Agente IA" para el panel (respuesta del bot, no de un asesor).
              raw: { sentByAi: true },
              messageTimestamp: Math.floor(Date.now() / 1000),
            });
          }
        });
  }

  /**
   * Procesa el evento 'call' de Evolution: registra una llamada entrante perdida
   * como burbuja en los Chats (tabla unificada chat_messages). Como el número de
   * WhatsApp del agente no puede contestar voz por Evolution, toda entrante se
   * registra como "perdida". El dedupe por messageId (call_<id>) evita duplicados
   * cuando Evolution emite varios eventos para la misma llamada.
   */
  private async handleCallEvent(body: WebhookBodyDto): Promise<void> {
    try {
      const instanceName = body.instance;
      const rawData = (body as unknown as { data?: unknown }).data;
      const call = (Array.isArray(rawData) ? rawData[0] : rawData) as
        | {
            id?: string;
            from?: string;
            chatId?: string;
            status?: string;
            isVideo?: boolean;
            date?: number;
          }
        | undefined;
      if (!call) return;

      const from = call.from || call.chatId || '';
      if (!from) return;

      const prismaInstancia =
        await this.instancesService.getUserId(instanceName);
      const userId = prismaInstancia?.userId ?? '';
      if (!userId) return;

      // El "from" de la llamada llega como @lid. Si conocemos su número (aprendido
      // de mensajes previos), usamos ese para que la perdida caiga en el chat real.
      let remoteJid = from.includes('@') ? from : `${from}@s.whatsapp.net`;
      if (from.includes('@lid')) {
        const resolved = await this.chatStore.resolveLid(userId, from);
        if (resolved) remoteJid = resolved;
      }
      // Si acabamos de hacer una llamada SALIENTE a este número (p. ej. el
      // voicebot), este evento es el "eco" y NO debe registrarse como perdida.
      const phoneDigits = remoteJid.split('@')[0].split(':')[0];
      if (await this.chatStore.recentOutgoingCallExists(userId, phoneDigits)) {
        this.logger.log(`[CALL] eco de saliente ignorado (no perdida) jid=${remoteJid}`);
        return;
      }

      const isVideo = Boolean(call.isVideo);
      const callId = String(call.id || `${from}_${call.date ?? ''}`);
      const ts =
        typeof call.date === 'number'
          ? call.date
          : Math.floor(Date.now() / 1000);

      await this.chatStore.persistMessage({
        userId,
        instanceName,
        instanceType: 'evolution',
        remoteJid,
        messageId: `call_${callId}`,
        fromMe: false,
        messageType: 'call',
        content: isVideo ? 'Videollamada perdida' : 'Llamada perdida',
        raw: { call: { direction: 'incoming', isVideo, status: call.status ?? '' } },
        messageTimestamp: ts,
      });

      this.chatEvents.emitChatChanged({ userId, remoteJid, instanceName });

      // Alerta automática al asesor: tarea interna "devolver llamada perdida"
      // (con dedupe de 6h). Best-effort, no rompe el procesamiento de la llamada.
      await this.chatStore.createMissedCallTask({ userId, remoteJid });

      this.logger.log(
        `[CALL] perdida I=${instanceName} from=${from} -> ${remoteJid} video=${isVideo} status=${call.status ?? '-'}`,
      );
    } catch (err: unknown) {
      void this.logger.error(
        `[CALL] error procesando llamada: ${JSON.stringify(err)}`,
      );
    }
  }

  /**
   * Procesa un webhook recibido de Evolution API.
   */
  async processWebhook(body: WebhookBodyDto): Promise<void> {
    const { instance: instanceName, server_url, apikey, data } = body;

    // Evento de LLAMADA (Evolution event 'call'): se registra como burbuja en el
    // chat (llamada perdida) y no sigue el flujo normal de mensajes.
    if (body.event === 'call') {
      await this.handleCallEvent(body);
      return;
    }

    const msgId = this.messageDeduplication.getMessageId(data);
    if (msgId) {
      const dedupeKey = `${instanceName}:${msgId}`;
      if (this.messageDeduplication.isDuplicateMessage(dedupeKey)) {
        this.logger.warn(
          `[WEBHOOK] DEDUPE: mensaje duplicado ignorado. key=${dedupeKey}`,
        );
        return;
      }
    }

    // Log inicial sin userId (todavía no lo conocemos)
    this.logger.log(
      `[WEBHOOK] I=${instanceName} ; rJid ${data?.key?.remoteJid} rJidAlt ${data?.key?.remoteJidAlt}`,
    );
    this.logger.log(`[MESSAGE] M=${data?.message?.conversation ?? ''}`);

    // DIAG TEMPORAL: registra TODOS los eventos del webhook (compacto) para ver qué
    // llega exactamente al borrar un mensaje —o si no llega nada—. Filtra en los
    // logs por [EVT] y por el número de prueba. Quitar tras diagnosticar.
    try {
      const _dm: any = data?.message;
      const _mt = data?.messageType;
      const _hasText = !!(_dm?.conversation || _dm?.extendedTextMessage?.text);
      this.logger.warn(
        `[EVT] event=${body.event} msgType=${_mt ?? '(none)'} stub=${(data as any)?.messageStubType ?? '-'} keyId=${data?.key?.id} fromMe=${data?.key?.fromMe} rjid=${data?.key?.remoteJid} hasText=${_hasText} msgKeys=[${_dm ? Object.keys(_dm).join(',') : ''}]${_dm?.protocolMessage ? ` proto=${JSON.stringify(_dm.protocolMessage)}` : ''}`,
      );
    } catch {}

    const rawRemoteJid = data?.key?.remoteJid ?? '';
    const rawRemoteJidAlt = data?.key?.remoteJidAlt ?? '';
    const rawSenderLid = data?.key?.senderLid ?? '';
    const rawSenderPn = data?.key?.senderPn ?? data?.senderPn ?? '';
    const observedJids = [
      rawRemoteJid,
      rawRemoteJidAlt,
      rawSenderPn,
      rawSenderLid,
    ];
    const remoteJid =
      pickExplicitWhatsAppPhoneJid(observedJids) ||
      pickPreferredWhatsAppRemoteJid(observedJids) ||
      rawRemoteJid ||
      rawRemoteJidAlt ||
      rawSenderLid ||
      '';
    const remoteJidAlt =
      pickObservedAlternateRemoteJid(remoteJid, observedJids) || '';

    // 🚫 Descarta eventos que NO son contactos 1:1 reales: grupos (@g.us),
    // estados/difusiones (status@broadcast, @broadcast), newsletters y JIDs
    // vacíos o sin número válido. Sin esto se creaban "leads basura" (+0 / Você)
    // en la cuenta. Los salientes (fromMe) a un número real SÍ pasan y crean lead.
    if (
      !isRegisterableContactJid(remoteJid) &&
      !isRegisterableContactJid(remoteJidAlt)
    ) {
      this.logger.log(
        `[WEBHOOK] Evento ignorado: JID no registrable como lead (rJid="${remoteJid || '-'}" rJidAlt="${remoteJidAlt || '-'}" I=${instanceName}).`,
      );
      return;
    }

    const fromMe = data?.key?.fromMe ?? false;
    const incomingPushName = (data?.pushName ?? '').trim();
    // Nombres que WhatsApp asigna a mensajes propios/salientes según el idioma del
    // dispositivo ("Você"=tú en portugués, "You", "Tú"...). No son el nombre del
    // contacto → no los guardamos como tal (quedaría un lead llamado "Você").
    const SELF_PUSHNAMES = new Set(['você', 'voce', 'tú', 'tu', 'you', 'yo']);
    const isSelfPushName = SELF_PUSHNAMES.has(incomingPushName.toLowerCase());
    // Outbound webhooks often carry the business display name, not the contact name.
    const pushName =
      !fromMe && incomingPushName && !isSelfPushName
        ? incomingPushName
        : 'Desconocido';

    // Buscar userId por instancia
    const prismaInstancia = await this.instancesService.getUserId(instanceName);
    const userId = prismaInstancia?.userId ?? '';
    const instanceId = prismaInstancia?.instanceId ?? '';

    // Aprender el mapeo lid -> número, para luego resolver el "from" de las
    // llamadas entrantes (que llega como @lid) al chat correcto del contacto.
    if (userId && rawSenderLid && remoteJid.includes('@s.whatsapp.net')) {
      void this.chatStore.rememberLid(userId, rawSenderLid, remoteJid);
    }

    // Tiempo real: notificar que este chat cambió en cuanto sabemos a qué
    // usuario/instancia pertenece. Cubre mensajes entrantes (y los echos
    // salientes que reenvía Evolution). Es aditivo y nunca bloquea el flujo.
    if (userId && remoteJid) {
      // Para mensajes de TEXTO incluimos el contenido para que el cliente haga
      // append directo sin re-consultar a Evolution (Fase 2). Para multimedia,
      // el contenido va vacío y el cliente cae al refetch.
      const realtimeText =
        data?.message?.conversation ||
        data?.message?.extendedTextMessage?.text ||
        '';
      const realtimeTs =
        typeof data?.messageTimestamp === 'number'
          ? data.messageTimestamp
          : Math.floor(Date.now() / 1000);

      this.chatEvents.emitChatChanged({
        userId,
        remoteJid,
        instanceName,
        message: realtimeText
          ? {
              id: data?.key?.id ?? null,
              fromMe: Boolean(data?.key?.fromMe),
              content: realtimeText,
              messageType: data?.messageType ?? 'conversation',
              pushName: incomingPushName || null,
              ts: realtimeTs,
            }
          : null,
      });
    }

    // Logger con contexto ya incluye userId/inst/jid
    const userWithRelations = (await this.userService.getUserWithPausar(
      userId,
    )) as UserWithPausar;

    const aiConfig = await this.userService.getUserDefaultAiConfig(userId);

    const { defaultModel, defaultProvider, defaultApiKey } = aiConfig || {};
    const mask = (k?: string | null) =>
      k ? `${k.slice(0, 4)}…${k.slice(-4)}` : null;
    this.logger.log(
      `AI config recibida → provider=${defaultProvider?.name ?? '-'} model=${defaultModel?.name ?? '-'} apiKey=${mask(defaultApiKey)}`,
      'WebhookService',
    );

    if (!defaultApiKey) {
      this.logger.warn(
        `Usuario sin API key configurada (userId=${userId}). Webhook ignorado.`,
        'WebhookService',
      );
      return;
    }

    // ── Puente con operario: ¿es la RESPUESTA de un operario a una consulta? ──
    // Aditivo y detrás del flag global. Si el remitente es un operario con un
    // puente OPEN, la IA reformula su respuesta y se la entrega al cliente, se
    // cierra el puente y se reactiva la IA del cliente. NO se procesa como lead.
    // Va ANTES de checkOrRegisterSession para no crear un lead del operario.
    if (process.env.OPERATOR_BRIDGE_ENABLED === 'true' && userId && !fromMe) {
      try {
        const senderDigits = String(remoteJid).split('@')[0].replace(/\D/g, '');
        // ¿El remitente es un operario del directorio de esta cuenta?
        const operator = senderDigits
          ? await this.prisma.operatorContact.findFirst({
              where: { userId, phone: senderDigits },
              select: { id: true },
            })
          : null;

        if (operator) {
          const operatorText =
            data?.message?.conversation ||
            data?.message?.extendedTextMessage?.text ||
            '';

          // Correlación: primero por mensaje CITADO (el operario respondió
          // citando la consulta), luego el puente OPEN más reciente de ese número.
          const quotedId: string | null =
            data?.message?.extendedTextMessage?.contextInfo?.stanzaId ?? null;
          let bridge = quotedId
            ? await this.prisma.operatorBridge.findFirst({
                where: { userId, operatorPhone: senderDigits, status: 'OPEN', lastOutboundMsgId: quotedId },
                orderBy: { createdAt: 'desc' },
              })
            : null;
          if (!bridge) {
            bridge = await this.prisma.operatorBridge.findFirst({
              where: { userId, operatorPhone: senderDigits, status: 'OPEN' },
              orderBy: { createdAt: 'desc' },
            });
          }

          if (bridge && operatorText.trim()) {
            const clientMsg = await this.aiAgentService.reformulateOperatorReply({
              question: bridge.question,
              rawReply: operatorText,
              apikeyOpenAi: defaultApiKey,
              defaultModel: (defaultModel as any)?.name,
              defaultProvider: (defaultProvider as any)?.name,
            });
            const sendText = this.makeSendTextFn(
              instanceName,
              server_url,
              apikey,
              userId,
              'operator_bridge',
            );
            await sendText(bridge.clientRemoteJid, clientMsg);
            await this.prisma.operatorBridge.update({
              where: { id: bridge.id },
              data: { status: 'CLOSED' },
            });
            // Reactivar la IA del cliente (la tool la había pausado al abrir el puente).
            await this.prisma.session.update({
              where: { id: bridge.clientSessionId },
              data: { agentDisabled: false },
            });
            this.logger.log(
              `[BRIDGE] Respuesta del operario ${senderDigits} entregada al cliente ${bridge.clientRemoteJid}.`,
              'WebhookService',
            );
          } else {
            this.logger.log(
              `[BRIDGE] Mensaje de operario ${senderDigits} sin puente activo — ignorado (no se crea lead).`,
              'WebhookService',
            );
          }
          // El remitente es un operario: NUNCA se procesa como lead/cliente.
          return;
        }
      } catch (e: any) {
        this.logger.warn(
          `[BRIDGE] Error procesando respuesta de operario: ${e?.message ?? e}`,
          'WebhookService',
        );
        // Ante cualquier error, se cae al flujo normal.
      }
    }

    // 🔹 Delay dinámico por usuario (delayTimeGPT en SEGUNDOS → convertir a ms)
    const defaultDelay = WebhookService.DELAYCONVERSATION; // 10000 ms por defecto (10s)
    let delayConversation = defaultDelay;

    if (userWithRelations.delayTimeGpt) {
      const seconds = parseInt(userWithRelations.delayTimeGpt, 10);

      if (!isNaN(seconds) && seconds > 0) {
        delayConversation = seconds * 1000; // convertir segundos → milisegundos
        this.logger.log(
          `delayTimeGPT personalizado: ${seconds}s → ${delayConversation}ms`,
          'WebhookService',
        );
      } else {
        this.logger.warn(
          `delayTimeGPT inválido ("${userWithRelations.delayTimeGpt}"), usando default ${defaultDelay}ms`,
          'WebhookService',
        );
      }
    }

    const messageType = data?.messageType ?? '';

    //Check de sesión + normalización entre @lid y @s.whatsapp.net
    const sessionRes = await this.sessionOrchestration.checkOrRegisterSession(
      remoteJid,
      instanceName,
      userId,
      pushName,
      userWithRelations,
      remoteJidAlt,
      rawSenderPn,
    );
    const canonicalRemoteJid = sessionRes.canonicalRemoteJid;
    const logger = this.scopedLogger({
      userId,
      instanceName,
      remoteJid: canonicalRemoteJid,
    });
    const canonicalSession = await this.sessionService.getSession(
      canonicalRemoteJid,
      instanceName,
      userId,
    );
    const canonicalAlt = canonicalSession?.remoteJidAlt || remoteJidAlt || '';
    const msgChat = data?.message?.conversation ?? '';
    const conversationMsg = msgChat.trim().toLowerCase();

    // Guardar origen Click-to-WhatsApp la primera vez que llega con adReply
    if (!fromMe && canonicalSession?.id && !canonicalSession.adSource) {
      const adReply =
        (data?.message as any)?.extendedTextMessage?.contextInfo?.externalAdReply ||
        (data?.contextInfo as any)?.externalAdReply;
      if (adReply?.title || adReply?.sourceUrl) {
        void this.sessionService.saveAdSource(canonicalSession.id, {
          title: adReply.title,
          body: adReply.body,
          sourceUrl: adReply.sourceUrl,
        });
      }
    }

    /* Pausa / Reactivación solo si escribe el admin (fromMe) */
    if (this.messageDirectionService.isFromMe(fromMe)) {
      await this.conversationControl.stopOrResumeConversation({
        conversationMsg,
        remoteJid: canonicalRemoteJid,
        remoteJidAlt: canonicalAlt,
        instanceId,
        sessionStatus: canonicalSession
          ? !!canonicalSession.status
          : !!sessionRes.status,
        userWithRelations,
        instanceName,
        apikey,
        server_url,
      });
      return;
    }

    /* Borrado del cliente ("eliminar para todos" / revoke): NO se procesa como
       mensaje ni dispara la IA; se MARCA el mensaje original como eliminado
       (conservando su contenido) para que el panel muestre el badge "Eliminado". */
    {
      const protocolMsg: any = (data?.message as any)?.protocolMessage;
      const isRevokeEvent =
        messageType === 'protocolMessage' &&
        (protocolMsg?.type === 0 || protocolMsg?.type === 'REVOKE' || protocolMsg?.type === 'MESSAGE_REVOKE');
      if (isRevokeEvent) {
        const deletedId = protocolMsg?.key?.id;
        if (deletedId && userId) {
          void this.chatStore.markMessageDeleted({
            userId,
            instanceName,
            remoteJid: canonicalRemoteJid,
            remoteJidAlt: canonicalAlt || null,
            messageId: deletedId,
          });
        }
        return;
      }
    }

    const model = defaultModel?.name || 'gpt-4o-mini';
    const provider = defaultProvider?.name || 'openai';
    const isAdminInstance = userId === process.env.ADMIN_USER_ID;

    // ── Detección de pagos: siempre activa, sin importar guards ──────────────
    // Para la instancia admin extraemos el contenido UNA sola vez aquí,
    // antes de cualquier validación (sesión, créditos, grupo, agentDisabled).
    // El resultado se reutiliza más abajo en el flujo normal para evitar
    // llamar dos veces a Vision API en mensajes de imagen.
    let preExtractedMessage: string | null = null;

    if (isAdminInstance) {
      const earlyContent =
        await this.messageTypeHandlerService.extractContentByType(
          messageType,
          defaultApiKey ?? '',
          data,
          model,
          provider,
        );
      preExtractedMessage = earlyContent.toString().trim();
      if (preExtractedMessage) {
        void this.paymentReceiptProcessor
          .handle({ content: preExtractedMessage, remoteJid: canonicalRemoteJid })
          .catch((err: unknown) =>
            logger.error(
              `[PaymentReceipt] Error procesando comprobante: ${(err as any)?.message ?? err}`,
            ),
          );
      }
    }

    if (!(canonicalSession?.status ?? sessionRes.status)) return;
    if (!sessionRes.status) return;

    const sessionHistoryId = buildChatHistorySessionId(
      instanceName,
      canonicalRemoteJid,
    );
    const apiMsgUrl = `${server_url}/message/sendText/${instanceName}`;
    const sendTextFn = this.makeSendTextFn(instanceName, server_url, apikey, userId, data?.source);

    // this.logger.debug(`[PAUSA] fromMe=${fromMe} | msg="${conversationMsg}"`);

    const agentMuted = !!userWithRelations.muteAgentResponses;

    // 🔹 Si el agente NO está muteado -> sí validamos créditos
    if (!agentMuted) {
      // Para clientes de reseller: notificaciones de créditos desde la línea del reseller
      let notifApiUrl = apiMsgUrl;
      let notifApikey = apikey;
      if (userWithRelations.ownerId) {
        const resellerSender = await this.userService.getResellerSender(userWithRelations.ownerId);
        if (resellerSender) {
          notifApiUrl = resellerSender.sendUrl;
          notifApikey = resellerSender.senderApikey;
        }
      }
      const creditOk = await this.creditValidation({
        flags: creditFlags,
        userId,
        webhookUrl: userWithRelations.webhookUrl ?? '',
        apikey: notifApikey,
        apiUrl: notifApiUrl,
        userPhone: userWithRelations.notificationNumber,
      });

      if (!creditOk) {
        logger.warn('Créditos insuficientes. Deteniendo flujo.');
        return;
      }
    } else {
      logger.log(
        'Agente muteado: se omite validación de créditos y uso de IA.',
        'WebhookService',
      );
    }

    /* Grupo */
    if (isGroupChat(canonicalRemoteJid)) {
      logger.log('🔇 Mensaje de grupo detectado, no se responderá.');
      return;
    }


    /* Extract content — reutiliza la extracción temprana si ya se hizo (admin) */
    const incomingMessage = preExtractedMessage !== null
      ? preExtractedMessage
      : (
          await this.messageTypeHandlerService.extractContentByType(
            messageType,
            defaultApiKey ?? '',
            data,
            model,
            provider,
          )
        ).toString().trim();

    /* Stickers y tipos de mensaje no soportados → ignorar silenciosamente */
    if (incomingMessage === '[UNKNOWN_MESSAGE_TYPE]') {
      logger.debug(`[CONTENT] Tipo de mensaje no soportado (sticker/media) → ignorado.`);
      return;
    }

    /* Persistir entrante en el store unificado (Telegram/Meta) para la bandeja de Chats */
    if (this.isUnifiedStoreChannel(data?.source)) {
      const mediaTypes = ['imageMessage', 'audioMessage', 'videoMessage', 'documentMessage'];
      const isMedia = mediaTypes.includes(messageType);
      // storeIncomingMedia ya dejó la URL pública en data.message.mediaUrl (si pudo subirla).
      const storedUrl = data?.message?.mediaUrl;
      const publicMediaUrl =
        typeof storedUrl === 'string' && /^https?:\/\//.test(storedUrl) ? storedUrl : null;
      const mediaLabel =
        messageType === 'imageMessage' ? '[Imagen]'
          : messageType === 'audioMessage' ? '[Audio]'
            : messageType === 'videoMessage' ? '[Video]'
              : messageType === 'documentMessage' ? '[Documento]' : '';
      // Para media, el panel renderiza el archivo; el texto que se guarda es el
      // caption o una etiqueta (la descripción/transcripción la usa la IA, no el panel).
      const displayContent = isMedia
        ? (data?.message?.conversation?.trim() || mediaLabel)
        : incomingMessage;

      void this.chatStore.persistMessage({
        userId,
        instanceName,
        instanceType: data.source,
        remoteJid: canonicalRemoteJid,
        remoteJidAlt: canonicalAlt || null,
        messageId: data?.key?.id,
        fromMe: false,
        pushName: incomingPushName || null,
        messageType,
        content: displayContent,
        mediaUrl: publicMediaUrl,
        messageTimestamp: data?.messageTimestamp,
      });
    }

    /* Persistir entrante de Evolution (WhatsApp real) en el store unificado, para
       que la bandeja de Chats tenga historial local y abrir la conversación sea
       instantáneo sin depender del fetch on-demand a Evolution. (Fase 2.5)
       Aditivo y no bloqueante (persistMessage tiene su propio try/catch). El id
       real (data.key.id) hace que la resync de la app deduplique por ON CONFLICT. */
    if (!this.isUnifiedStoreChannel(data?.source) && !fromMe && userId) {
      const mediaTypes = ['imageMessage', 'audioMessage', 'videoMessage', 'documentMessage'];
      const isMedia = mediaTypes.includes(messageType);
      const storedUrl = data?.message?.mediaUrl;
      const publicMediaUrl =
        typeof storedUrl === 'string' && /^https?:\/\//.test(storedUrl) ? storedUrl : null;
      const mediaLabel =
        messageType === 'imageMessage' ? '[Imagen]'
          : messageType === 'audioMessage' ? '[Audio]'
            : messageType === 'videoMessage' ? '[Video]'
              : messageType === 'documentMessage' ? '[Documento]' : '';
      const displayContent = isMedia
        ? (data?.message?.conversation?.trim() || mediaLabel)
        : incomingMessage;

      void this.chatStore.persistMessage({
        userId,
        instanceName,
        instanceType: 'evolution',
        remoteJid: canonicalRemoteJid,
        remoteJidAlt: canonicalAlt || null,
        senderPn: rawSenderPn || null,
        messageId: data?.key?.id,
        fromMe: false,
        pushName: incomingPushName || null,
        messageType,
        content: displayContent,
        mediaUrl: publicMediaUrl,
        messageTimestamp: data?.messageTimestamp,
      });
    }

    /* Registrar contenido e timestamp para checks de antiflood */
    this.antifloodService.registerMessageContent(canonicalRemoteJid, instanceName, incomingMessage);
    logger.debug(
      `[ANTIFLOOD] Registrando timestamp para remoteJid=${canonicalRemoteJid} instance=${instanceName}`,
    );
    this.antifloodService.registerMessageTimestamp(canonicalRemoteJid, instanceName);

    /* Lista blanca: números de prueba omiten todos los checks de spam */
    const isWhitelisted = this.antifloodService.isWhitelisted(canonicalRemoteJid);

    logger.log(`[WEBHOOK_DIAG] isWhitelisted=${isWhitelisted} para ${canonicalRemoteJid}`);
    if (!isWhitelisted) {
      /* Anti-flood temporal (loops AI-to-AI) */
      logger.debug(`[ANTIFLOOD] Evaluando isSynchronizedPattern...`);
      const isFlood =
        this.antifloodService.isSynchronizedPattern(canonicalRemoteJid, instanceName);
      logger.debug(`[ANTIFLOOD] isSynchronizedPattern → ${isFlood}`);

      logger.debug(`[ANTIFLOOD] Evaluando isHighFrequencyContact...`);
      const isHighFreq =
        this.antifloodService.isHighFrequencyContact(canonicalRemoteJid, instanceName);
      logger.debug(`[ANTIFLOOD] isHighFrequencyContact → ${isHighFreq}`);

      logger.debug(`[ANTIFLOOD] Evaluando isMediumFrequencyBurst...`);
      const isMediumBurst =
        this.antifloodService.isMediumFrequencyBurst(canonicalRemoteJid, instanceName);
      logger.debug(`[ANTIFLOOD] isMediumFrequencyBurst → ${isMediumBurst}`);

      if (isFlood || isHighFreq || isMediumBurst) {
        const reason = isFlood
          ? 'Patrón sincronizado'
          : isHighFreq
            ? 'Alta frecuencia AI-to-AI'
            : 'Burst de media frecuencia (loop lento AI-to-AI)';
        logger.debug(
          `[ANTIFLOOD] Detección confirmada (${reason}). Reseteando buffer y marcando bloqueo...`,
        );
        this.messageBufferService.reset(canonicalRemoteJid);
        this.antifloodService.markBlocked(canonicalRemoteJid, instanceName);
        logger.debug(`[ANTIFLOOD] Desactivando sesión en BD...`);
        try {
          await this.sessionService.disableSession(
            canonicalRemoteJid,
            instanceName,
            userWithRelations.id,
          );
          logger.debug(`[ANTIFLOOD] Sesión desactivada en BD correctamente.`);
        } catch (err: any) {
          logger.error(
            `[ANTIFLOOD] Error desactivando sesión en BD (cooldown en-memoria activo). ${err?.message}`,
          );
        }
        logger.warn(`${reason} detectado → sesión desactivada y agente bloqueado.`);
        return;
      }

      /* Anti-spam de contenido (soft-skip: no bloquea sesión) */
      const isRepeated = this.antifloodService.isRepeatedContentSpam(incomingMessage, canonicalRemoteJid, instanceName);
      logger.log(`[WEBHOOK_DIAG] isRepeatedContentSpam=${isRepeated}`);
      if (isRepeated) {
        logger.warn(`[CONTENT] Mensaje repetido consecutivamente → ignorado.`);
        return;
      }

      const isInternalRep = this.antifloodService.hasInternalRepetition(incomingMessage);
      logger.log(`[WEBHOOK_DIAG] hasInternalRepetition=${isInternalRep}`);
      if (isInternalRep) {
        logger.warn(`[CONTENT] Mensaje con palabras repetidas internamente → ignorado.`);
        return;
      }

      const isBadWord = this.antifloodService.isBadWordMessage(incomingMessage);
      logger.log(`[WEBHOOK_DIAG] isBadWordMessage=${isBadWord}`);
      if (isBadWord) {
        logger.warn(`[CONTENT] Mensaje con palabras ofensivas → ignorado.`);
        return;
      }
    }

    logger.log(`[WEBHOOK_DIAG] Todos los checks antiflood pasados. Continuando flujo normal.`);

    // Cancelar seguimientos de inactividad INMEDIATAMENTE al recibir respuesta del cliente,
    // antes del buffer, para evitar race condition con el scheduler de follow-ups.
    // El scheduler puede disparar durante los segundos de delay del buffer; esta llamada
    // garantiza que se cancele antes de que eso ocurra.
    void this.followUpRunnerService
      .cancelPendingFollowUpsOnReply({
        userId,
        remoteJid: canonicalRemoteJid,
        instanceName,
      })
      .catch((err: unknown) =>
        logger.error(
          `[INACTIVIDAD] Error cancelando follow-ups al recibir mensaje: ${(err as any)?.message ?? err}`,
        ),
      );

    /* Buffer + IA + CHATBOT */
    logger.log(
      `[WEBHOOK_DIAG] Antiflood OK → llamando handleIncomingMessage para ${canonicalRemoteJid} | msgLen=${incomingMessage.length} | msgType=${messageType}`,
    );
    this.messageBufferService.handleIncomingMessage(
      canonicalRemoteJid,
      incomingMessage,
      delayConversation,
      async (mergedText) => {
        logger.log(
          `[WEBHOOK_DIAG] Buffer callback disparado para ${canonicalRemoteJid} | mergedLen=${mergedText.toString().length} | concurrentBlock=${this.processingContacts.has(canonicalRemoteJid)}`,
        );
        if (this.processingContacts.has(canonicalRemoteJid)) {
          logger.warn(
            `[WEBHOOK] Callback concurrente ignorado para ${canonicalRemoteJid}`,
          );
          return;
        }
        this.processingContacts.add(canonicalRemoteJid);
        try {
          await this.processBufferedMessage({
            mergedText: mergedText.toString(),
            canonicalRemoteJid, canonicalSession, instanceName, instanceId,
            userId, pushName, server_url, apikey, defaultApiKey,
            model, provider, messageType, userWithRelations,
            sessionHistoryId, apiMsgUrl, sendTextFn, logger,
          });
        } catch (err: any) {
          logger.error(
            'Error en callback de messageBufferService.handleIncomingMessage (se evita crash global).',
            err?.message || err,
          );
        } finally {
          this.processingContacts.delete(canonicalRemoteJid);
        }
      },
    );
  }

  private async creditValidation({
    userId,
    flags,
    webhookUrl,
    apiUrl,
    apikey,
    userPhone,
  }: CreditValidationInput): Promise<boolean> {
    const logger = this.scopedLogger({ userId });
    try {
      if (!webhookUrl || webhookUrl.trim() === '') {
        logger.warn(`creditValidation: webhookUrl vacío.`);
        return false;
      }

      const credits = await this.aiCreditsService.getCreditsByUser(userId);

      if (!credits.success) {
        if (!this.aiCreditsService.hasNotifiedThreshold(userId, -1)) {
          const zeroFlag = flags.find((f) => f.pct === 0);
          const msg = zeroFlag ? zeroFlag.message({ available: 0, total: 0 }) : '🛑 Sin créditos disponibles.';
          try {
            await this.nodeSenderService.sendTextNode(apiUrl, apikey, userPhone, msg);
            this.aiCreditsService.markThresholdNotified(userId, -1);
          } catch (error) {
            logger.error(`Error enviando notificación sin registro de créditos`, error);
          }
        }
        return false;
      }

      const { available, total } = credits;
      const availablePct = total > 0 ? Math.floor((available / total) * 100) : 0;

      // Ordenar de mayor a menor para notificar primero el umbral más alto cruzado
      const sortedFlags = [...flags].sort((a, b) => b.pct - a.pct);

      for (const flag of sortedFlags) {
        const crossed = flag.pct === 0 ? available <= 0 : availablePct <= flag.pct;
        if (crossed && !this.aiCreditsService.hasNotifiedThreshold(userId, flag.pct)) {
          logger.log(`⚠️ Créditos al ${availablePct}% — umbral ${flag.pct}% cruzado. Enviando notificación.`);
          try {
            await this.nodeSenderService.sendTextNode(apiUrl, apikey, userPhone, flag.message({ available, total }));
            this.aiCreditsService.markThresholdNotified(userId, flag.pct);
          } catch (error) {
            logger.error(`Error enviando notificación por umbral ${flag.pct}%`, error);
          }
        }
      }

      if (available <= 0) {
        logger.error(`❌ SIN CRÉDITOS: Deteniendo flujo.`);
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Error en creditValidation', error);
      return false;
    }
  }




  private async processBufferedMessage(params: {
    mergedText: string;
    canonicalRemoteJid: string;
    canonicalSession: any;
    instanceName: string;
    instanceId: string;
    userId: string;
    pushName: string;
    server_url: string;
    apikey: string;
    defaultApiKey: string | null | undefined;
    model: string;
    provider: string;
    messageType: string;
    userWithRelations: UserWithPausar;
    sessionHistoryId: string;
    apiMsgUrl: string;
    sendTextFn: (remoteJid: string, text: string) => Promise<void>;
    logger: ReturnType<WebhookService['scopedLogger']>;
  }): Promise<void> {
    const {
      mergedText, canonicalRemoteJid, canonicalSession, instanceName, instanceId,
      userId, pushName, server_url, apikey, defaultApiKey,
      model, provider, messageType, userWithRelations,
      sessionHistoryId, apiMsgUrl, sendTextFn, logger,
    } = params;

    // Guard: re-verificar session.status en tiempo real (puede haberse pausado durante el delay del buffer)
    const currentSession = await this.sessionService.getSession(
      canonicalRemoteJid,
      instanceName,
      userId,
    );
    if (currentSession && !currentSession.status) {
      logger.log(
        `[WEBHOOK] Sesión pausada durante el buffer → flujo detenido para ${canonicalRemoteJid}`,
      );
      return;
    }

    // Guard: verificar agentDisabled ANTES de cualquier modificación de estado
    const agentDisabled = await this.sessionService.getAgentDisabled(
      canonicalRemoteJid,
      instanceName,
      userId,
    );

    if (agentDisabled) {
      // Timeout reactivo del puente con operario: si el cliente vuelve a escribir
      // y su consulta al operario lleva demasiado tiempo sin respuesta, retomamos
      // la conversación con la IA (cerramos el puente vencido y la reactivamos).
      let retomado = false;
      if (process.env.OPERATOR_BRIDGE_ENABLED === 'true') {
        try {
          const timeoutMs = Number(process.env.OPERATOR_BRIDGE_TIMEOUT_MS) || 900_000; // 15 min
          const cutoff = new Date(Date.now() - timeoutMs);
          const stale = await this.prisma.operatorBridge.findFirst({
            where: {
              userId,
              clientRemoteJid: canonicalRemoteJid,
              status: 'OPEN',
              createdAt: { lt: cutoff },
            },
            orderBy: { createdAt: 'desc' },
          });
          if (stale) {
            await this.prisma.operatorBridge.update({
              where: { id: stale.id },
              data: { status: 'CLOSED' },
            });
            await this.prisma.session.update({
              where: { id: stale.clientSessionId },
              data: { agentDisabled: false },
            });
            this.logger.log(
              `[BRIDGE] Puente vencido para ${canonicalRemoteJid} → IA reactivada (el cliente volvió a escribir).`,
              'WebhookService',
            );
            retomado = true;
          }
        } catch (e: any) {
          this.logger.warn(`[BRIDGE] Error en timeout reactivo: ${e?.message ?? e}`, 'WebhookService');
        }
      }
      if (!retomado) {
        this.logger.warn(
          `[WEBHOOK] agentDisabled=true → flujo detenido. userId=${userId} instance=${instanceName} remoteJid=${canonicalRemoteJid}`,
        );
        return;
      }
      // Si se retomó, el flujo continúa y la IA atiende este mensaje.
    }

    // Guardamos el mensaje completo que se acumuló en el buffer.
    // Para imágenes añadimos el marcador [IMAGEN] para que la IA
    // tenga contexto claro en turnos futuros.
    const msgToSave = messageType === 'imageMessage'
      ? `[IMAGEN]: ${mergedText}`
      : messageType === 'documentMessage'
        ? mergedText  // ya incluye el prefijo [DOCUMENTO: nombre] desde message-type-handler
        : mergedText;
    await this.chatHistoryService.saveMessage(
      sessionHistoryId,
      msgToSave,
      'human',
    );

    const cancelledFollowUps =
      await this.followUpRunnerService.cancelPendingFollowUpsOnReply({
        userId,
        remoteJid: canonicalRemoteJid,
        instanceName,
      });
    if (cancelledFollowUps.count > 0) {
      logger.log(
        `Follow-ups cancelados por respuesta del lead: ${cancelledFollowUps.count}`,
        'WebhookService',
      );
    }

    // Limpiar inactividad solo cuando el agente va a responder
    await this.sessionService.clearInactividadAfterAgentReply(
      userId,
      canonicalRemoteJid,
      instanceName,
    );

    // Una sola query de historial reutilizada por el sintetizador y la lógica de bienvenida
    const chatHistory =
      await this.chatHistoryService.getChatHistory(sessionHistoryId);

    //Lead Funnel (bucket/sintetizador)
    if (canonicalSession?.id && userWithRelations.enabledSynthesizer) {
      this.logger.debug(
        `Entrando a sintetizador... instanceID=${instanceId} userId=${userId} remoteJid=${canonicalRemoteJid}`,
      );

      const funnelRes = await this.leadFunnelService.processIncomingText({
        userId,
        instanceId,
        remoteJid: canonicalRemoteJid,
        pushName,
        enabledLeadStatusClassifier:
          !!userWithRelations.enabledLeadStatusClassifier,
        enabledCrmFollowUps: !!userWithRelations.enabledCrmFollowUps,
        sessionDbId: canonicalSession.id,
        text: mergedText,
        history: chatHistory,
      });

      this.logger.debug(
        `[LEAD_FUNNEL] result=${JSON.stringify(funnelRes)}`,
      );
    }

    // Auto-ejecutar flujo BIENVENIDA en primera conexión
    const historyForBienvenida = chatHistory;
    let bienvenidaJustExecuted = false; // evita que el embudo se dispare en el mismo turno
    logger.log(
      `[BIENVENIDA] historyLength=${historyForBienvenida.length} sessionHistoryId=${sessionHistoryId} userId=${userId}`,
      'WebhookService',
    );
    if (historyForBienvenida.length === 1) {
      const bienvenidaWorkflow =
        await this.workflowService.findWelcomeWorkflow(
          userId,
          this.aiAgentService.initWorkflowName,
        );
      logger.log(
        `[BIENVENIDA] workflow encontrado: ${bienvenidaWorkflow ? bienvenidaWorkflow.name : 'null'}`,
        'WebhookService',
      );
      if (bienvenidaWorkflow) {
        const alreadyExecuted =
          await this.chatHistoryService.hasIntentionBeenExecuted(
            sessionHistoryId,
            bienvenidaWorkflow.name,
          );
        if (alreadyExecuted) {
          logger.log(
            `[BIENVENIDA] Flujo "${bienvenidaWorkflow.name}" ya ejecutado previamente → omitiendo re-ejecución.`,
            'WebhookService',
          );
          // Inyectamos contexto para que el modelo de IA no reinicie desde el Paso 1.
          // Sin esto el AI vería history.length=1 y asumiría current_step=1 (GATE abierto).
          await this.chatHistoryService.saveMessage(
            sessionHistoryId,
            '[SISTEMA]: Este usuario ya completó el flujo de bienvenida en una conversación previa. Continúa la conversación en el punto donde se quedó, sin repetir presentaciones ni preguntar datos ya recopilados.',
            'ai',
          );
        } else {
          logger.log(
            `[BIENVENIDA] Primera conexión → ejecutando flujo "${bienvenidaWorkflow.name}"`,
            'WebhookService',
          );
          bienvenidaJustExecuted = true; // no ejecutar embudo en este mismo turno
          await this.chatHistoryService.registerExecutedIntention(
            sessionHistoryId,
            bienvenidaWorkflow.name,
            'intention',
          );
          await this.sessionService.registerWorkflow(
            { id: bienvenidaWorkflow.id, name: bienvenidaWorkflow.name },
            canonicalRemoteJid,
            instanceName,
            userId,
          );
          await executeWorkflow({
            workflowService: this.workflowService,
            nodeSenderService: this.nodeSenderService,
            chatHistoryService: this.chatHistoryService,
            aiAgentService: this.aiAgentService,
            logger,
            workflowName: bienvenidaWorkflow.name,
            server_url,
            apikey,
            instanceName,
            remoteJid: canonicalRemoteJid,
            userId,
            sessionHistoryId,
            apiMsgUrl,
            apikeyOpenAi: defaultApiKey ?? '',
            model,
            provider,
            muteAgentResponses: userWithRelations.muteAgentResponses,
            sendTextFn,
            // sin postPromptBuilder → executeWorkflow no llama a la IA
          });

          // Inyectar contexto para que la IA responda con la REGLA/PARÁMETRO del paso
          if (!userWithRelations.muteAgentResponses) {
            await this.chatHistoryService.saveMessage(
              sessionHistoryId,
              `[SISTEMA]: El flujo "${bienvenidaWorkflow.name}" acaba de ejecutarse. Responde únicamente con el mensaje de Regla/parámetro del paso correspondiente, sin texto adicional.`,
              'ai',
            );
          }
          // bienvenidaJustExecuted=true ya bloquea el embudo; la IA corre abajo y envía la REGLA
        }
      }
    }

    // Auto-ejecutar pasos de embudo en secuencia (desde el primer mensaje real del cliente,
    // pero nunca en el mismo turno en que BIENVENIDA acaba de ejecutarse)
    const funnelFlows = !bienvenidaJustExecuted && historyForBienvenida.length >= 1
      ? await this.workflowService.getFunnelFlows(userId)
      : [];
    let funnelStepExecuted = false;
    if (funnelFlows.length > 0) {
      const welcomeFlow = await this.workflowService.findWelcomeWorkflow(userId, this.aiAgentService.initWorkflowName);
      const welcomeDone = welcomeFlow
        ? await this.chatHistoryService.hasIntentionBeenExecuted(sessionHistoryId, welcomeFlow.name)
        : true;

      if (welcomeDone) {
        for (let i = 0; i < funnelFlows.length; i++) {
          const funnelFlow = funnelFlows[i];
          const alreadyDone = await this.chatHistoryService.hasIntentionBeenExecuted(sessionHistoryId, funnelFlow.name);
          if (alreadyDone) continue;

          const prevDone = i === 0
            ? true
            : await this.chatHistoryService.hasIntentionBeenExecuted(sessionHistoryId, funnelFlows[i - 1].name);

          if (prevDone) {
            logger.log(`[EMBUDO] Ejecutando paso ${i + 1}: "${funnelFlow.name}"`, 'WebhookService');
            await this.chatHistoryService.registerExecutedIntention(sessionHistoryId, funnelFlow.name, 'intention');
            await this.sessionService.registerWorkflow(
              { id: funnelFlow.id, name: funnelFlow.name },
              canonicalRemoteJid, instanceName, userId,
            );
            await executeWorkflow({
              workflowService: this.workflowService,
              nodeSenderService: this.nodeSenderService,
              chatHistoryService: this.chatHistoryService,
              aiAgentService: this.aiAgentService,
              logger,
              workflowName: funnelFlow.name,
              server_url, apikey, instanceName,
              remoteJid: canonicalRemoteJid,
              userId, sessionHistoryId, apiMsgUrl,
              apikeyOpenAi: defaultApiKey ?? '',
              model, provider,
              muteAgentResponses: userWithRelations.muteAgentResponses,
              sendTextFn,
              pushName: pushName || '',
              // sin postPromptBuilder → executeWorkflow no llama a la IA
            });

            // Inyectar contexto para que la IA responda con la REGLA/PARÁMETRO del paso
            if (!userWithRelations.muteAgentResponses) {
              await this.chatHistoryService.saveMessage(
                sessionHistoryId,
                `[SISTEMA]: El flujo "${funnelFlow.name}" acaba de ejecutarse. Responde únicamente con el mensaje de Regla/parámetro del paso correspondiente, sin texto adicional.`,
                'ai',
              );
            }
            funnelStepExecuted = true;
          }
          break; // solo un paso por turno
        }
      }
    }

    // funnelStepExecuted: la IA corre igualmente para responder con la REGLA/PARÁMETRO del paso

    // Las imágenes también pueden reanudar flujos pausados (ej: paso que pide comprobante).
    // continuePausedWorkflow solo actúa si hay un estado 'waiting' activo → seguro para imágenes.
    logger.log(
      `[WORKFLOW_RESUME] Verificando flujo pausado. messageType=${messageType} remoteJid=${canonicalRemoteJid}`,
      'WebhookService',
    );
    const resumed = await this.workflowService.continuePausedWorkflow(
        server_url,
        apikey,
        instanceName,
        canonicalRemoteJid,
        userId,
        mergedText,
      );
    logger.log(
      `[WORKFLOW_RESUME] continuePausedWorkflow resultado: resumed=${resumed}`,
      'WebhookService',
    );

    if (resumed) {
      logger.log(
        'Continuación de workflow pausado (intention) ejecutada. No se usa IA.',
        'WebhookService',
      );
      return;
    }

    // 2) luego sí: intentar disparar workflow por descripción
    // Las imágenes (imageMessage) siempre van al LLM — Vision API describe el contenido
    // con texto que puede contener keywords de workflows (ej: "pago", "comprobante"),
    // provocando un match falso que dispara el script en lugar de llamar a la IA.
    const matchedWorkflow = messageType === 'imageMessage'
      ? null
      : await this.workflowService.findWorkflowByDescriptionMatch(
          userId,
          mergedText,
        );

    if (matchedWorkflow) {
      logger.log(
        `Workflow por descripción encontrado (via buffer): ${matchedWorkflow.name} → ejecutando sin IA.`,
        'WebhookService',
      );

      //  Evita doble ejecución si luego entra la IA / tool Ejecutar_Flujos
      await this.chatHistoryService.registerExecutedIntention(
        sessionHistoryId,
        matchedWorkflow.name,
        'intention',
      );

      // (Opcional pero recomendado si tú llevas tracking en Session)
      await this.sessionService.registerWorkflow(
        { id: matchedWorkflow.id, name: matchedWorkflow.name },
        canonicalRemoteJid,
        instanceName,
        userId,
      );

      await executeWorkflow({
        workflowService: this.workflowService,
        nodeSenderService: this.nodeSenderService,
        chatHistoryService: this.chatHistoryService,
        aiAgentService: this.aiAgentService,
        logger,

        workflowName: matchedWorkflow.name,
        server_url,
        apikey,
        instanceName,
        remoteJid: canonicalRemoteJid,
        userId,

        sessionHistoryId,
        apiMsgUrl,

        apikeyOpenAi: defaultApiKey ?? '',
        model,
        provider,

        muteAgentResponses: userWithRelations.muteAgentResponses,
        sendTextFn,
      });

      return;
    }

    // 2) Gate de IA. El interruptor global "Estado del agente" (muteAgentResponses)
    // apaga la IA para TODA la cuenta. PERO un contacto puede quedar habilitado
    // individualmente (opt-in por sesión, p. ej. tras un flujo por palabra clave con
    // el nodo "Activar IA"): en ese caso la IA sí responde a ESE contacto aunque el
    // global esté apagado. Así se logra "chatbot para todos, IA solo para los
    // contactos activados". El opt-out por contacto (agentDisabled) ya cortó antes.
    if (userWithRelations.muteAgentResponses && !currentSession?.aiOptIn) {
      logger.warn(
        '🔇 Agente muteado y contacto sin opt-in de IA: no se usará IA (solo flujos/chatbot).',
        'muteAgentResponses',
      );
      return;
    }

    // 3) Si no hay flujo y no está muteado → ahora sí usamos IA
    // Para imágenes: usamos el marcador [IMAGEN] en el input para que la IA
    // entienda que viene de una imagen (ya guardado así en el historial).
    const aiInput = messageType === 'imageMessage'
      ? `[IMAGEN]: ${mergedText}`
      : mergedText;  // documentMessage ya trae [DOCUMENTO: nombre]\n{texto} desde message-type-handler

    const dataProccessInput = {
      input: aiInput,
      userId,
      apikeyOpenAi: defaultApiKey ?? '',
      defaultModel: model,
      defaultProvider: provider,
      sessionId: sessionHistoryId,
      server_url,
      apikey,
      instanceName,
      remoteJid: canonicalRemoteJid,
      pushName,
    };

    const aiResponseRaw =
      await this.aiAgentService.processInput(dataProccessInput);

    // Cuando el agente no produce respuesta para una imagen (finalTextRaw vacío),
    // el agente retorna el fallback genérico. Sustituimos ese fallback por un
    // mensaje más apropiado para el contexto de imagen.
    const AI_GENERIC_FALLBACK = 'No pude procesar tu solicitud correctamente. ¿Puedes reformular tu mensaje?';
    const aiResponse = (messageType === 'imageMessage' && aiResponseRaw === AI_GENERIC_FALLBACK)
      ? 'Gracias por enviar la imagen. La hemos recibido y la revisaremos. ¿Hay algo más en lo que pueda ayudarte?'
      : aiResponseRaw;

    if (!aiResponse || aiResponse === '') return;

    // Deduplicación de respuesta saliente: evita reenviar el mismo
    // contenido al mismo contacto en menos de OUTGOING_DEDUPE_TTL_MS.
    if (
      this.messageDeduplication.isDuplicateOutgoingResponse(
        instanceName,
        canonicalRemoteJid,
        aiResponse,
      )
    ) {
      logger.warn(
        `[OUTGOING_DEDUPE] Respuesta idéntica detectada para ${canonicalRemoteJid} → omitida para evitar loop.`,
      );
      return;
    }

    await this.chatHistoryService.saveMessage(
      sessionHistoryId,
      aiResponse,
      'ia',
    );

    const msgBlocks = aiResponse
      .split('\n\n')
      .map((b) => b.trim())
      .filter((b) => b.length > 0);

    if (msgBlocks.length === 0) {
      logger.warn(
        `El mensaje está vacío después de procesar bloques.`,
        'NodeSenderService',
      );
      return;
    }

    const isBaileysInstance = !server_url;
    const isAudioMessage = messageType === 'audioMessage';
    const isDetailedForAudio = (text: string): boolean => {
      if (text.length > 450) return true;
      if (/\n[-*]\s/.test(text)) return true;
      if (/\n\d+\.\s/.test(text)) return true;
      if (/https?:\/\//.test(text)) return true;
      if ((text.match(/\n/g) ?? []).length > 4) return true;
      return false;
    };
    const hasTtsKey = !!(
      userWithRelations.ttsProvider === 'elevenlabs'
        ? userWithRelations.elevenLabsApiKey
        : defaultApiKey
    );
    const voiceEnabled =
      !!userWithRelations.enableVoiceResponses &&
      hasTtsKey &&
      isAudioMessage &&
      !isDetailedForAudio(aiResponse);

    if (voiceEnabled) {
      // Quitar bloques que parecen firma (inicio o final): cortos, negrita o emoji+negrita
      const isSignatureBlock = (b: string) => {
        const t = b.trim();
        if (t.length > 60) return false;
        if (/^\*[^*]+\*$/.test(t)) return true;           // *Asistente Verzy*
        if (/^—\s*\*?[^*]+\*?$/.test(t)) return true;     // — Asistente Verzy
        if (/^.{0,6}\s*\*[^*\n]+\*$/.test(t)) return true; // 👨 *Asistente Verzy*
        return false;
      };
      let voiceBlocks = [...msgBlocks];
      if (voiceBlocks.length > 1 && isSignatureBlock(voiceBlocks[0])) voiceBlocks = voiceBlocks.slice(1);
      if (voiceBlocks.length > 0 && isSignatureBlock(voiceBlocks[voiceBlocks.length - 1])) voiceBlocks = voiceBlocks.slice(0, -1);
      const advisorSig = (userWithRelations.advisorSignature ?? '').trim();
      const rawFullText = voiceBlocks.join('\n\n');
      const stripSignature = (text: string): string => {
        let t = text;
        const knownAgentNames = [
          'Asistente Verzy',
          'Agente Verzy',
          'Asistente Verzay',
          'Agente Verzay',
        ];
        const agentNamePattern = knownAgentNames
          .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|');
        const decorativePrefix = String.raw`[^\p{L}\p{N}]*`;

        // Quita firmas pegadas al inicio: "👨🏻‍💻 *Asistente Verzy* Hola..."
        t = t.replace(
          new RegExp(
            String.raw`^\s*${decorativePrefix}(?:[\*_~]*\s*)?(?:${agentNamePattern})(?:\s*[\*_~]*)?\s*[:：,\-—–|]*\s*`,
            'iu',
          ),
          '',
        );

        // Quita firmas en líneas propias al inicio o final.
        t = t
          .split(/\r?\n/)
          .filter((line) => {
            const cleanLine = line
              .trim()
              .replace(/^[\s*_~\-—–|:：]+|[\s*_~\-—–|:：]+$/g, '')
              .trim();
            if (!cleanLine) return true;
            return !new RegExp(String.raw`^${decorativePrefix}(?:${agentNamePattern})$`, 'iu').test(cleanLine);
          })
          .join('\n');

        // Strip firma inline al final: línea corta con formato *Texto* o — Texto
        t = t.replace(/[\n\r]+[\*_—\-]*\s*[A-ZÀ-ßa-zà-ÿ ]{3,40}[\*_]*\s*$/, '').trim();
        if (advisorSig) {
          const escaped = advisorSig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          t = t
            .replace(new RegExp(String.raw`^\s*${decorativePrefix}[\*_~—\-]*\s*${escaped}[\*_~—\-]*\s*[:：,\-—–|]*\s*`, 'iu'), '')
            .replace(new RegExp(`[\\*_\\u2014\\-]*\\s*${escaped}[\\*_]*`, 'gi'), '')
            .trim();
        }
        return t;
      };
      const fullText = normalizeTextForTts(stripSignature(rawFullText));
      logger.log(`[TTS] fullText normalizado: "${fullText.slice(0, 80)}..."`, 'TtsService');
      const ttsProvider = userWithRelations.ttsProvider || 'openai';
      const voiceId = userWithRelations.voiceId || 'nova';
      const voiceModel = userWithRelations.voiceModel || 'gpt-4o-mini-tts';
      const voiceInstructions = userWithRelations.voiceInstructions || undefined;
      const elApiKey = userWithRelations.elevenLabsApiKey;
      const elVoiceId = userWithRelations.elevenLabsVoiceId;

      logger.log(`🎙️ Generando nota de voz (provider=${ttsProvider}, voice=${ttsProvider === 'elevenlabs' ? elVoiceId : voiceId}, baileys=${isBaileysInstance}, textLen=${fullText.length})`, 'TtsService');

      let audioBase64: string | null = null;
      if (ttsProvider === 'elevenlabs' && elApiKey && elVoiceId) {
        if (!fullText) {
          logger.warn(`TTS abortado: texto vacío tras strip de firma`, 'TtsService');
        } else {
          try {
            audioBase64 = await this.ttsService.generateVoiceElevenLabs(fullText, elApiKey, elVoiceId);
          } catch (elErr: any) {
            logger.error(`[TTS/ElevenLabs] ${elErr?.message ?? elErr}`, undefined, 'TtsService');
          }
        }
      } else {
        audioBase64 = await this.ttsService.generateVoiceBase64(fullText, defaultApiKey, voiceId, voiceModel, voiceInstructions);
      }
      let audioSent = false;
      if (audioBase64) {
        if (isBaileysInstance) {
          audioSent = await this.baileysSender.sendAudioBase64(instanceName, canonicalRemoteJid, audioBase64);
        } else if (!/^https?:\/\//i.test(server_url)) {
          // Canales no-Evolution (Telegram/Meta): el envío de voz requiere URL/archivo,
          // no base64. Se hace fallback a texto.
          audioSent = false;
        } else {
          const audioUrl = `${server_url}/message/sendWhatsAppAudio/${instanceName}`;
          audioSent = await this.nodeSenderService.sendAudioNode(audioUrl, apikey, canonicalRemoteJid, audioBase64);
        }
        if (audioSent) {
          logger.log(`✅ Nota de voz enviada a ${canonicalRemoteJid}`, 'TtsService');
        } else {
          logger.warn(`sendAudio falló, enviando como texto`, 'TtsService');
        }
      } else {
        logger.warn(`TTS falló, enviando como texto`, 'TtsService');
      }
      if (!audioSent) {
        for (const msgBlock of msgBlocks) {
          await sendTextFn(canonicalRemoteJid, msgBlock);
          await new Promise((res) => setTimeout(res, 300));
        }
      }
    } else {
      for (const [index, msgBlock] of msgBlocks.entries()) {
        logger.log(
          `📤 Enviando bloque ${index + 1}/${msgBlocks.length}`,
          'NodeSenderService',
        );
        await sendTextFn(canonicalRemoteJid, msgBlock);
        await new Promise((res) => setTimeout(res, 300));
      }
    }
  }
}
