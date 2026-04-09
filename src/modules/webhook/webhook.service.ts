import { Body, Injectable, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import type { AiAgentService } from '../ai-agent/ai-agent.service';

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
import { SeguimientosService } from '../seguimientos/seguimientos.service';
import { AutoRepliesService } from '../auto-replies/auto-replies.service';
import { WorkflowService } from '../workflow/services/workflow.service.ts/workflow.service';
import { AiCreditsService } from '../ai-credits/ai-credits.service';
import { SessionTriggerService } from '../session-trigger/session-trigger.service';
import {
  CreditValidationInput,
  onAutoRepliesInterface,
  stopOrResumeConversation,
  flags,
  getReactivateDate,
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

@Injectable()
export class WebhookService implements OnModuleInit {
  public static readonly DELAYCONVERSATION = 10000;

  private aiAgentService!: AiAgentService;
  private readonly processedMsgIds = new Map<string, number>();
  /** Contactos con un callback de buffer actualmente en ejecución */
  private readonly processingContacts = new Set<string>();
  /**
   * Deduplicación de respuestas salientes: evita enviar el mismo contenido
   * al mismo contacto en menos de OUTGOING_DEDUPE_TTL_MS milisegundos.
   * Clave: `${instanceName}:${remoteJid}` → hash simple del último texto enviado + timestamp.
   */
  private readonly outgoingResponseCache = new Map<
    string,
    { hash: string; ts: number }
  >();
  private static readonly OUTGOING_DEDUPE_TTL_MS = 10 * 60_000; // 10 min

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly logger: LoggerService,
    private readonly sessionService: SessionService,
    private readonly userService: UserService,
    private readonly instancesService: InstancesService,
    private readonly messageDirectionService: MessageDirectionService,
    private readonly messageTypeHandlerService: MessageTypeHandlerService,
    private readonly messageBufferService: MessageBufferService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly nodeSenderService: NodeSenderService,
    private readonly seguimientosService: SeguimientosService,
    private readonly autoRepliesService: AutoRepliesService,
    private readonly workflowService: WorkflowService,
    private readonly aiCreditsService: AiCreditsService,
    private readonly sessionTriggerService: SessionTriggerService,
    private readonly antifloodService: AntifloodService,
    private readonly leadFunnelService: LeadFunnelService,
    private readonly followUpRunnerService: FollowUpRunnerService,
    private readonly paymentReceiptProcessor: PaymentReceiptProcessorService,
  ) { }

  onModuleInit(): void {
    const { AiAgentService } = require('../ai-agent/ai-agent.service');
    this.aiAgentService = this.moduleRef.get(AiAgentService, { strict: false });
  }

  /**
   * Genera un hash liviano (no criptográfico) de un string para comparar contenido.
   */
  private simpleHash(text: string): string {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  /**
   * Verifica si ya enviamos esta respuesta (o una igual) a este contacto recientemente.
   * Devuelve true si debe omitirse (duplicado), false si es nueva y la registra.
   */
  private isDuplicateOutgoingResponse(
    instanceName: string,
    remoteJid: string,
    responseText: string,
  ): boolean {
    const key = `${instanceName}:${remoteJid}`;
    const hash = this.simpleHash(responseText.trim());
    const now = Date.now();
    const ttl = WebhookService.OUTGOING_DEDUPE_TTL_MS;

    // Limpiar entradas expiradas
    for (const [k, v] of this.outgoingResponseCache.entries()) {
      if (now - v.ts > ttl) this.outgoingResponseCache.delete(k);
    }

    const cached = this.outgoingResponseCache.get(key);
    if (cached && cached.hash === hash && now - cached.ts < ttl) {
      return true;
    }

    this.outgoingResponseCache.set(key, { hash, ts: now });
    return false;
  }

  private isDuplicateMessage(key: string, ttlMs = 120000): boolean {
    const now = Date.now();

    // cleanup simple
    for (const [k, ts] of this.processedMsgIds.entries()) {
      if (now - ts > ttlMs) this.processedMsgIds.delete(k);
    }

    const last = this.processedMsgIds.get(key);
    if (last && now - last < ttlMs) return true;

    this.processedMsgIds.set(key, now);
    return false;
  }

  private getMessageId(data: any): string {
    return (
      data?.key?.id ??
      data?.key?.msgId ?? // puede venir en runtime aunque el type no lo tenga
      data?.messageId ??
      data?.message?.messageId ??
      ''
    );
  }

  /**
   * Crea un logger con contexto fijo para prefijar todos los mensajes.
   */
  private scopedLogger(ctx: {
    userId?: string;
    instanceName?: string;
    remoteJid?: string;
  }) {
    // const tag = `[UID=${ctx.userId ?? '-'}][I=${ctx.instanceName ?? '-'}][R=${ctx.remoteJid ?? '-'}]`;
    const tag = ``;
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
   * Procesa un webhook recibido de Evolution API.
   */
  async processWebhook(@Body() body: WebhookBodyDto): Promise<void> {
    const { instance: instanceName, server_url, apikey, data } = body;

    const msgId = this.getMessageId(data);
    if (msgId) {
      const dedupeKey = `${instanceName}:${msgId}`;
      if (this.isDuplicateMessage(dedupeKey)) {
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
    const sessionRes = await this.checkOrRegisterSession(
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

    /* Pausa / Reactivación solo si escribe el admin (fromMe) */
    if (this.messageDirectionService.isFromMe(fromMe)) {
      await this.stopOrResumeConversation({
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

    // this.logger.debug(`[PAUSA] fromMe=${fromMe} | msg="${conversationMsg}"`);

    const agentMuted = !!userWithRelations.muteAgentResponses;

    // 🔹 Si el agente NO está muteado -> sí validamos créditos
    if (!agentMuted) {
      const creditOk = await this.creditValidation({
        flags,
        userId,
        webhookUrl: userWithRelations.webhookUrl ?? '',
        apikey,
        apiUrl: apiMsgUrl,
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

    logger.log(`Is from me: ${fromMe}`);
    logger.log(`Estado de la session: ${canonicalSession?.status ?? sessionRes.status}`);

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

    /* Anti-flood */
    logger.debug(
      `[ANTIFLOOD] Registrando timestamp para remoteJid=${canonicalRemoteJid} instance=${instanceName}`,
    );
    this.antifloodService.registerMessageTimestamp(canonicalRemoteJid, instanceName);

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
      // markBlocked primero: actualiza memoria y persiste en BD (fire-and-forget).
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

    logger.debug(`[ANTIFLOOD] Sin detección. Continuando flujo normal.`);

    /* Buffer + IA + CHATBOT */
    this.messageBufferService.handleIncomingMessage(
      canonicalRemoteJid,
      incomingMessage,
      delayConversation,
      async (mergedText) => {
        if (this.processingContacts.has(canonicalRemoteJid)) {
          logger.warn(
            `[WEBHOOK] Callback concurrente ignorado para ${canonicalRemoteJid}`,
          );
          return;
        }
        this.processingContacts.add(canonicalRemoteJid);
        try {
          const mergedTextStr = mergedText.toString();

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

          // Guardamos el mensaje completo que se acumuló en el buffer
          await this.chatHistoryService.saveMessage(
            sessionHistoryId,
            mergedTextStr,
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

          //Lead Funnel (bucket/sintetizador)
          if (canonicalSession?.id && userWithRelations.enabledSynthesizer) {
            this.logger.debug(
              `Entrando a sintetizador... instanceID=${instanceId} userId=${userId} remoteJid=${canonicalRemoteJid}`,
            );
            const history =
              await this.chatHistoryService.getChatHistory(sessionHistoryId);

            const funnelRes = await this.leadFunnelService.processIncomingText({
              userId,
              instanceId,
              remoteJid: canonicalRemoteJid,
              pushName,
              enabledLeadStatusClassifier:
                !!userWithRelations.enabledLeadStatusClassifier,
              enabledCrmFollowUps: !!userWithRelations.enabledCrmFollowUps,
              sessionDbId: canonicalSession.id,
              text: mergedTextStr,
              history,
            });

            this.logger.debug(
              `[LEAD_FUNNEL] result=${JSON.stringify(funnelRes)}`,
            );
          }

          const resumed = await this.workflowService.continuePausedWorkflow(
            server_url,
            apikey,
            instanceName,
            canonicalRemoteJid,
            userId,
            mergedTextStr,
          );

          if (resumed) {
            logger.log(
              'Continuación de workflow pausado (intention) ejecutada. No se usa IA.',
              'WebhookService',
            );
            return;
          }

          // 2) luego sí: intentar disparar workflow por descripción
          const matchedWorkflow =
            await this.workflowService.findWorkflowByDescriptionMatch(
              userId,
              mergedTextStr,
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
          const dataProccessInput = {
            input: mergedTextStr,
            userId,
            apikeyOpenAi: defaultApiKey ?? '',
            defaultModel: model,
            defaultProvider: provider,
            sessionId: sessionHistoryId,
            server_url,
            apikey,
            instanceName,
            remoteJid: canonicalRemoteJid,
          };

          const aiResponse =
            await this.aiAgentService.processInput(dataProccessInput);
          if (!aiResponse || aiResponse === '') return;

          // Deduplicación de respuesta saliente: evita reenviar el mismo
          // contenido al mismo contacto en menos de OUTGOING_DEDUPE_TTL_MS.
          if (
            this.isDuplicateOutgoingResponse(
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

          for (const [index, msgBlock] of msgBlocks.entries()) {
            logger.log(
              `📤 Enviando bloque ${index + 1}/${msgBlocks.length}`,
              'NodeSenderService',
            );
            await this.nodeSenderService.sendTextNode(
              apiMsgUrl,
              apikey,
              canonicalRemoteJid,
              msgBlock,
            );
            await new Promise((res) => setTimeout(res, 300));
          }
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
        try {
          await this.nodeSenderService.sendTextNode(
            apiUrl,
            apikey,
            userPhone,
            flags[0].message,
          );
        } catch (error) {
          logger.error(
            `Error enviando notificación por flag ${credits.msg}`,
            error,
          );
        }
        return false;
      }

      const { available } = credits;

      const range = 5;
      for (const flag of flags) {
        const min = flag.value - range;
        const max = flag.value + range;

        if (available >= min && available <= max) {
          logger.log(
            `⚠️ alcanzó rango de créditos ${flag.value} (dentro de ${min}-${max}). Enviando mensaje... "${flag.message}"`,
          );
          try {
            await this.nodeSenderService.sendTextNode(
              apiUrl,
              apikey,
              userPhone,
              flag.message,
            );
          } catch (error) {
            logger.error(
              `Error enviando notificación por flag ${flag.value}`,
              error,
            );
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

  /**
   * Normaliza la sesión entre @lid y @s.whatsapp.net y devuelve el estado (activa o no).
   */
  async checkOrRegisterSession(
    remoteJid: string,
    instanceName: string,
    userId: string,
    pushName: string,
    userWithRelations: UserWithPausar,
    remoteJidAlt?: string,
    senderPn?: string,
  ): Promise<{ status: boolean; canonicalRemoteJid: string }> {
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // 1) Intentar con el JID principal (prioriza @s.whatsapp.net)
    let session = await this.sessionService.getSession(
      remoteJid,
      instanceName,
      userId,
    );

    // 2) Si no existe y hay alternativo (ej: @lid), intentar con él
    if (!session && remoteJidAlt && remoteJidAlt !== remoteJid) {
      const sessionAlt = await this.sessionService.getSession(
        remoteJidAlt,
        instanceName,
        userId,
      );

      if (sessionAlt) {
        logger.log(
          `[SESSION] Usuario ya registrado con JID alternativo: ${remoteJidAlt}`,
        );

        // Normalizar: actualizamos remoteJid en BD al canon
        if (sessionAlt.remoteJid !== remoteJid) {
          try {
            await this.sessionService.updateSessionRemoteJid(
              sessionAlt.id,
              remoteJid,
            );
            logger.log(
              `[SESSION] remoteJid actualizado de ${sessionAlt.remoteJid} → ${remoteJid}`,
            );
            sessionAlt.remoteJid = remoteJid;
          } catch (error) {
            logger.error('Error actualizando remoteJid de la sesión', error);
          }
        }

        session = sessionAlt;
      }
    }

    if (session) {
      if (
        session.remoteJid !== remoteJid ||
        ((session.remoteJidAlt ?? '') !== (remoteJidAlt ?? '') &&
          Boolean(remoteJidAlt))
      ) {
        try {
          session = await this.sessionService.registerSession(
            userId,
            remoteJid,
            pushName,
            instanceName,
            remoteJidAlt,
            senderPn,
          );
        } catch (error) {
          logger.error('Error normalizando la sesión existente.', error);
        }
      }

      logger.log(`[SESSION] Usuario ya registrado: ${session.remoteJid}`);

      const hasTrigger = await this.sessionTriggerService.findBySessionId(
        session.id.toString(),
      );
      const dateReactivate = await this.getReactivateDate({
        userWithRelations,
      });

      if (!hasTrigger) {
        if (dateReactivate) {
          await this.sessionTriggerService.create(
            session.id.toString(),
            dateReactivate,
          );
          logger.log(
            `[TRIGGER] Reactivación programada para: ${dateReactivate}`,
          );
        }
      } else {
        if (dateReactivate) {
          await this.sessionTriggerService.updateTimeBySessionId(
            session.id.toString(),
            dateReactivate,
          );
          logger.log(`[TRIGGER] Fecha actualizada a: ${dateReactivate}`);
        }
      }

      return { status: session.status, canonicalRemoteJid: session.remoteJid };
    }

    // 3) Registrar usando el canon
    await this.sessionService.registerSession(
      userId,
      remoteJid,
      pushName,
      instanceName,
      remoteJidAlt,
      senderPn,
    );
    logger.log(`✅ Registro exitoso para ${remoteJid}`);
    return { status: true, canonicalRemoteJid: remoteJid };
  }

  private async getReactivateDate({
    userWithRelations,
  }: getReactivateDate): Promise<string | null> {
    const logger = this.scopedLogger({ userId: userWithRelations?.id });
    if (!userWithRelations) {
      logger.error('Se esperaba el userWithRelations para reactivar el chat.');
      return null;
    }

    const minutesToReactivate = parseInt(
      userWithRelations.autoReactivate ?? '',
    );
    if (isNaN(minutesToReactivate)) {
      logger.error(
        `Valor inválido para autoReactivate: "${userWithRelations.autoReactivate}"`,
      );
      return null;
    }

    const MILLISECONDS_PER_MINUTE = 60000;
    const currentDate = new Date();
    const futureDate = new Date(
      currentDate.getTime() + minutesToReactivate * MILLISECONDS_PER_MINUTE,
    );

    const pad = (n: number) => n.toString().padStart(2, '0');
    const day = pad(futureDate.getDate());
    const month = pad(futureDate.getMonth() + 1);
    const year = futureDate.getFullYear();
    const hours = pad(futureDate.getHours());
    const minutes = pad(futureDate.getMinutes());
    const formatted = `${day}/${month}/${year} ${hours}:${minutes}`;

    return formatted;
  }

  private async stopOrResumeConversation({
    conversationMsg,
    remoteJid,
    remoteJidAlt,
    instanceId,
    sessionStatus,
    userWithRelations,
    instanceName,
    apikey,
    server_url,
  }: stopOrResumeConversation) {
    const logger = this.scopedLogger({
      userId: userWithRelations?.id,
      instanceName,
      remoteJid,
    });

    const msg = (conversationMsg ?? '').trim().toLowerCase();

    // logger.debug(`🟦 INICIO stopOrResumeConversation`);
    // logger.debug(`Datos: remoteJid=${remoteJid} | alt=${remoteJidAlt ?? '-'} | instance=${instanceName} | sessionStatus=${sessionStatus ? 'ACTIVA' : 'PAUSADA'} | msg="${msg}"`);

    // 1) Pausar sesión principal (si estaba activa)
    // logger.debug(`1) Pausa sesión principal: ${sessionStatus ? 'ENTRA (estaba activa)' : 'NO entra (ya pausada)'}`);

    if (sessionStatus) {
      // logger.debug(`➡️ Llamando updateSessionStatus(false) para sesión principal...`);
      await this.sessionService.updateSessionStatus(
        remoteJid,
        instanceName,
        false,
        userWithRelations.id,
      );
      // logger.debug(`✅ updateSessionStatus(false) sesión principal OK`);
      logger.log(`Chat pausado para ${remoteJid}.`);
    } else {
      logger.log(`Chat ya estaba pausado para ${remoteJid}.`);
    }

    // 2) Pausar también el alternativo SOLO si existe sesión (y con false)
    // logger.debug(`2) Pausa JID alternativo: ${remoteJidAlt && remoteJidAlt !== remoteJid ? 'ENTRA' : 'NO entra'}`);

    if (remoteJidAlt && remoteJidAlt !== remoteJid) {
      // logger.debug(`➡️ Consultando getSession() para alternativo: ${remoteJidAlt}...`);
      const altSession = await this.sessionService.getSession(
        remoteJidAlt,
        instanceName,
        userWithRelations.id,
      );
      // logger.debug(`✅ getSession() alternativo respondió: ${altSession ? 'HAY sesión' : 'NO hay sesión'}`);

      if (altSession) {
        // logger.debug(`➡️ Llamando updateSessionStatus(false) para alternativo...`);
        await this.sessionService.updateSessionStatus(
          remoteJidAlt,
          instanceName,
          false,
          userWithRelations.id,
        );
        // logger.debug(`✅ updateSessionStatus(false) alternativo OK`);
        logger.log(
          `Chat pausado también para JID alternativo: ${remoteJidAlt}.`,
        );
      } else {
        logger.log(
          `JID alternativo no tiene sesión; se omite pausa: ${remoteJidAlt}.`,
        );
      }
    }

    // 3) Reactivar SOLO si estaba pausado y se escribe la frase correcta
    // logger.debug(`3) Reactivación: validando usuario y frase...`);

    if (!userWithRelations) {
      logger.warn(
        '❌ No se encontró el usuario para obtener la frase de reactivación.',
      );
      // logger.debug(`🟥 FIN (return: no userWithRelations)`);
      return;
    }

    const dataPausar = userWithRelations.pausar ?? [];
    const pausarItem = dataPausar.find((p) => p.tipo === 'abrir');

    // logger.debug(`➡️ pausar configurado: ${dataPausar.length} items | abrir=${pausarItem ? 'SÍ' : 'NO'}`);

    if (!pausarItem) {
      logger.warn('❌ El usuario no tiene frase de reactivación configurada.');
      // logger.debug(`🟥 FIN (return: no pausarItem abrir)`);
      return;
    }

    const phraseToReactivateChat = (pausarItem.mensaje ?? '')
      .trim()
      .toLowerCase();
    logger.log(`Frase de reactivación del usuario: "${pausarItem.mensaje}"`);
    // logger.debug(`Comparación reactivación: msg="${msg}" vs frase="${phraseToReactivateChat}" => ${msg === phraseToReactivateChat ? 'COINCIDE' : 'NO coincide'}`);

    if (msg === phraseToReactivateChat) {
      // logger.debug(`✅ Entró a reactivación (frase correcta)`);
      // logger.debug(`Estado de sesión antes: ${sessionStatus ? 'ACTIVA' : 'PAUSADA'}`);

      if (!sessionStatus) {
        logger.log('Frase correcta detectada. Reactivando chat...');

        // logger.debug(`➡️ Llamando updateSessionStatus(true) para sesión principal...`);
        await this.sessionService.updateSessionStatus(
          remoteJid,
          instanceName,
          true,
          userWithRelations.id,
        );
        // logger.debug(`✅ updateSessionStatus(true) sesión principal OK`);

        await this.sessionService.updateAgentDisabled(
          remoteJid,
          instanceName,
          false,
          userWithRelations.id,
        );

        // Reactivar alternativo SOLO si existe sesión
        // logger.debug(`Reactivar alternativo: ${remoteJidAlt && remoteJidAlt !== remoteJid ? 'ENTRA' : 'NO entra'}`);

        if (remoteJidAlt && remoteJidAlt !== remoteJid) {
          // logger.debug(`➡️ Consultando getSession() para alternativo antes de reactivar...`);
          const altSession = await this.sessionService.getSession(
            remoteJidAlt,
            instanceName,
            userWithRelations.id,
          );
          // logger.debug(`✅ getSession() alternativo respondió: ${altSession ? 'HAY sesión' : 'NO hay sesión'}`);

          if (altSession) {
            // logger.debug(`➡️ Llamando updateSessionStatus(true) para alternativo...`);
            await this.sessionService.updateSessionStatus(
              remoteJidAlt,
              instanceName,
              true,
              userWithRelations.id,
            );
            // logger.debug(`✅ updateSessionStatus(true) alternativo OK`);
            logger.log(
              `Chat reactivado también para JID alternativo: ${remoteJidAlt}.`,
            );
          } else {
            logger.log(
              `JID alternativo no tiene sesión; se omite reactivación: ${remoteJidAlt}.`,
            );
          }
        }
      } else {
        logger.log(
          'Frase de reactivación recibida, pero el chat ya estaba activo.',
        );
      }

      // logger.debug(`🟥 FIN (return: rama reactivación)`);
      return;
    }

    // 4) Eliminar seguimiento
    const pharaseToDelSeguimiento = (userWithRelations.delSeguimiento ?? '')
      .trim()
      .toLowerCase();
    // logger.debug(`4) Eliminar seguimiento: msg="${msg}" vs del="${pharaseToDelSeguimiento}" => ${msg === pharaseToDelSeguimiento ? 'COINCIDE' : 'NO coincide'}`);

    if (msg === pharaseToDelSeguimiento) {
      logger.log('Frase correcta detectada. Eliminando seguimiento...');
      try {
        // logger.debug(`➡️ Llamando deleteSeguimientosByRemoteJid(${remoteJid})...`);
        const { count } =
          await this.seguimientosService.deleteSeguimientosByRemoteJid(
            remoteJid,
            instanceName,
          );
        // logger.debug(`✅ deleteSeguimientosByRemoteJid respondió count=${count ?? 0}`);

        if (count && count > 0) {
          logger.log('Seguimiento eliminado con exito.');
        } else {
          logger.log('No se encontró un seguimiento relacionado.');
        }
      } catch (error) {
        logger.error('ERROR_SEGUIMIENTOS', error);
        // logger.debug(`🟥 FIN (return: error eliminando seguimiento)`);
      }

      await this.sessionService.updateAgentDisabled(
        remoteJid,
        instanceName,
        true,
        userWithRelations.id,
      );

      // logger.debug(`🟥 FIN (return: rama eliminar seguimiento)`);
      return;
    }

    // 5) AutoReplies
    // logger.debug(`5) Ninguna condición coincidió → llama onAutoReplies`);
    // logger.debug(`➡️ Ejecutando onAutoReplies...`);

    await this.onAutoReplies({
      userId: userWithRelations.id.toString(),
      conversationMsg,
      server_url,
      apikey,
      instanceName,
      remoteJid,
    });

    // logger.debug(`✅ onAutoReplies terminó`);
    // logger.debug(`🟩 FIN stopOrResumeConversation`);
  }

  private async onAutoReplies({
    userId,
    conversationMsg,
    server_url,
    apikey,
    instanceName,
    remoteJid,
  }: onAutoRepliesInterface): Promise<void> {
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    const userWithRelations = (await this.userService.getUserWithPausar(
      userId,
    )) as UserWithPausar;

    const aiConfig = await this.userService.getUserDefaultAiConfig(userId);
    const { defaultModel, defaultProvider, defaultApiKey } = aiConfig || {};

    const model = defaultModel?.name || 'gpt-4o-mini';
    const provider = defaultProvider?.name || 'openai';

    try {
      const autoReplies =
        await this.autoRepliesService.getAutoRepliesByUserId(userId);
      if (!autoReplies || autoReplies.length === 0) return;

      const matchedReply = autoReplies.find(
        (reply) => reply.mensaje?.trim().toLowerCase() === conversationMsg,
      );

      if (matchedReply) {
        logger.log(`Respuesta rápida encontrada: ${matchedReply.mensaje}`);
        if (!matchedReply.workflowId) return;
        const workflow = await this.workflowService.getWorkflowByWorkflowId(
          matchedReply.workflowId,
        );
        if (!workflow) return;

        await this.sessionService.clearInactividadAfterAgentReply(
          userId,
          remoteJid,
          instanceName,
        );

        const sessionHistoryId = buildChatHistorySessionId(
          instanceName,
          remoteJid,
        );
        const apiMsgUrl = `${server_url}/message/sendText/${instanceName}`;

        await executeWorkflow({
          workflowService: this.workflowService,
          nodeSenderService: this.nodeSenderService,
          chatHistoryService: this.chatHistoryService,
          aiAgentService: this.aiAgentService,
          logger,

          workflowName: workflow?.name ?? '',
          server_url,
          apikey,
          instanceName,
          remoteJid,
          userId,

          sessionHistoryId,
          apiMsgUrl,

          apikeyOpenAi: defaultApiKey ?? '',
          model,
          provider,

          muteAgentResponses: !!userWithRelations.muteAgentResponses,
        });

        /* Deja la session con status en true siempre despues de ejecutar  una respuesta rapida  */
        await this.sessionService.updateSessionStatus(
          remoteJid,
          instanceName,
          true,
          userWithRelations.id,
        );
      }
    } catch (error) {
      logger.error('Error al procesar autoReplies', error);
    }
  }
}
