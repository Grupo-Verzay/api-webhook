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
  ) { }

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
  ): (remoteJid: string, text: string) => Promise<void> {
    if (!server_url) {
      const sender = this.whatsAppSenderFactory.getSenderSync('baileys');
      return (remoteJid, text) => sender.sendText(instanceName, remoteJid, text).then(() => {});
    }
    const apiMsgUrl = `${server_url}/message/sendText/${instanceName}`;
    return (remoteJid, text) => this.nodeSenderService.sendTextNode(apiMsgUrl, apikey, remoteJid, text);
  }

  /**
   * Procesa un webhook recibido de Evolution API.
   */
  async processWebhook(body: WebhookBodyDto): Promise<void> {
    const { instance: instanceName, server_url, apikey, data } = body;

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

    const fromMe = data?.key?.fromMe ?? false;
    const incomingPushName = (data?.pushName ?? '').trim();
    // Outbound webhooks often carry the business display name, not the contact name.
    const pushName =
      !fromMe && incomingPushName ? incomingPushName : 'Desconocido';

    // Buscar userId por instancia
    const prismaInstancia = await this.instancesService.getUserId(instanceName);
    const userId = prismaInstancia?.userId ?? '';
    const instanceId = prismaInstancia?.instanceId ?? '';

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
    const sendTextFn = this.makeSendTextFn(instanceName, server_url, apikey);

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
      this.logger.warn(
        `[WEBHOOK] agentDisabled=true → flujo detenido. userId=${userId} instance=${instanceName} remoteJid=${canonicalRemoteJid}`,
      );
      return;
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

    // 2) Si el agente está muteado → solo dejamos funcionar flujos (que ya revisamos)
    if (userWithRelations.muteAgentResponses) {
      logger.warn(
        '🔇 Agente muteado: no se usará IA (solo flujos/chatbot).',
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
