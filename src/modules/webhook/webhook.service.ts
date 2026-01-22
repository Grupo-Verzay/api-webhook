import { Body, Injectable } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { LoggerService } from 'src/core/logger/logger.service';
import { WebhookBodyDto } from './dto/webhook-body';
import { MessageDirectionService } from './services/message-direction/message-direction.service';
import { MessageTypeHandlerService } from './services/message-type-handler/message-type-handler.service';
import { InstancesService } from '../instances/instances.service';
import { AiAgentService } from '../ai-agent/ai-agent.service';
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

@Injectable()
export class WebhookService {
  public static readonly DELAYCONVERSATION = 10000;

  constructor(
    private readonly logger: LoggerService,
    private readonly sessionService: SessionService,
    private readonly userService: UserService,
    private readonly instancesService: InstancesService,
    private readonly messageDirectionService: MessageDirectionService,
    private readonly messageTypeHandlerService: MessageTypeHandlerService,
    private readonly messageBufferService: MessageBufferService,
    private readonly aiAgentService: AiAgentService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly nodeSenderService: NodeSenderService,
    private readonly seguimientosService: SeguimientosService,
    private readonly autoRepliesService: AutoRepliesService,
    private readonly workflowService: WorkflowService,
    private readonly aiCreditsService: AiCreditsService,
    private readonly sessionTriggerService: SessionTriggerService,
    private readonly antifloodService: AntifloodService,
  ) { }

  /**
   * Crea un logger con contexto fijo para prefijar todos los mensajes.
   */
  private scopedLogger(ctx: { userId?: string; instanceName?: string; remoteJid?: string }) {
    const tag = `[UID=${ctx.userId ?? '-'}][I=${ctx.instanceName ?? '-'}][R=${ctx.remoteJid ?? '-'}]`;
    return {
      log: (msg: string, context = 'WebhookService') => this.logger.log(`${tag} ${msg}`, context),
      warn: (msg: string, context = 'WebhookService') => this.logger.warn(`${tag} ${msg}`, context),
      error: (msg: string, err?: any, context = 'WebhookService') =>
        this.logger.error(`${tag} ${msg}`, err, context),
    };
  }

  /**
   * Procesa un webhook recibido de Evolution API.
   */
  async processWebhook(@Body() body: WebhookBodyDto): Promise<void> {

    const { instance: instanceName, server_url, apikey, data } = body;

    // Log inicial sin userId (todavía no lo conocemos)
    this.logger.log(
      `[WEBHOOK] I=${instanceName} ; rJid ${data?.key?.remoteJid} rJidAlt ${data?.key?.remoteJidAlt}`,
    );
    this.logger.log(`[MESSAGE] M=${data?.message?.conversation ?? ''}`);

    // 🔁 Normalización de JIDs: priorizar @s.whatsapp.net sobre @lid
    const rawRemoteJid = data?.key?.remoteJid ?? '';
    const rawRemoteJidAlt = data?.key?.remoteJidAlt ?? '';

    const jidWhats = [rawRemoteJid, rawRemoteJidAlt].find(
      (j) => j && j.endsWith('@s.whatsapp.net'),
    );
    const jidLid = [rawRemoteJid, rawRemoteJidAlt].find((j) => j && j.endsWith('@lid'));

    // Canon: preferimos @s.whatsapp.net, luego @lid, luego lo que haya
    const remoteJid = jidWhats || jidLid || rawRemoteJid || rawRemoteJidAlt || '';
    // Alternativo: si el canon es @s.whatsapp.net, el alterno será @lid (si existe), y viceversa
    const remoteJidAlt = remoteJid === jidWhats ? jidLid || '' : jidWhats || '';

    const pushName = data?.pushName || 'Desconocido';

    // Buscar userId por instancia
    const prismaInstancia = await this.instancesService.getUserId(instanceName);
    const userId = prismaInstancia?.userId ?? '';
    const instanceId = prismaInstancia?.instanceId ?? '';

    // Logger con contexto ya incluye userId/inst/jid
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    const userWithRelations = await this.userService.getUserWithPausar(userId) as UserWithPausar;

    const aiConfig = await this.userService.getUserDefaultAiConfig(userId);

    const { defaultModel, defaultProvider, defaultApiKey } = aiConfig || {};
    const mask = (k?: string | null) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : null);
    logger.log(
      `AI config recibida → provider=${defaultProvider?.name ?? '-'} model=${defaultModel?.name ?? '-'
      } apiKey=${mask(defaultApiKey)}`,
    );

    // 🔹 Delay dinámico por usuario (delayTimeGPT en SEGUNDOS → convertir a ms)
    const defaultDelay = WebhookService.DELAYCONVERSATION; // 10000 ms por defecto (10s)
    let delayConversation = defaultDelay;

    if (userWithRelations.delayTimeGpt) {
      const seconds = parseInt(userWithRelations.delayTimeGpt, 10);

      if (!isNaN(seconds) && seconds > 0) {
        delayConversation = seconds * 1000; // convertir segundos → milisegundos
        logger.log(`delayTimeGPT personalizado: ${seconds}s → ${delayConversation}ms`);
      } else {
        logger.warn(
          `delayTimeGPT inválido ("${userWithRelations.delayTimeGpt}"), usando default ${defaultDelay}ms`,
        );
      }
    }

    const fromMe = data?.key?.fromMe ?? false;
    const messageType = data?.messageType ?? '';

    // ✅ Check de sesión + normalización entre @lid y @s.whatsapp.net
    const sessionStatus = await this.checkOrRegisterSession(
      remoteJid,
      instanceName,
      userId,
      pushName,
      userWithRelations,
      remoteJidAlt,
    );

    const msgChat = data?.message?.conversation ?? '';
    const conversationMsg = msgChat.trim().toLowerCase();
    const sessionHistoryId = `${instanceName}-${remoteJid}`;
    const apiMsgUrl = `${server_url}/message/sendText/${instanceName}`;

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
    if (isGroupChat(remoteJid)) {
      logger.log('🔇 Mensaje de grupo detectado, no se responderá.');
      return;
    }

    logger.log(`Is from me: ${fromMe}`);

    /* Pausa / Reactivación solo si escribe el admin (fromMe) */
    if (this.messageDirectionService.isFromMe(fromMe)) {
      await this.stopOrResumeConversation({
        conversationMsg,
        remoteJid,
        remoteJidAlt, // 👈 PASAMOS TAMBIÉN EL JID ALTERNATIVO
        instanceId,
        sessionStatus,
        userWithRelations,
        instanceName,
        apikey,
        server_url,
      });
      return;
    }

    /* Estado de sesión: usamos lo que detectó checkOrRegisterSession */
    const sessionActive = sessionStatus;
    logger.log(`Estado de la session: ${sessionActive}`);

    if (!sessionActive) return;

    /* Extract content */
    const model = defaultModel?.name || 'gpt-4o-mini';
    const provider = defaultProvider?.name || 'openai';
    const extractedContent =
      await this.messageTypeHandlerService.extractContentByType(
        messageType,
        defaultApiKey ?? '',
        data,
        model,
        provider,
      );

    const incomingMessage = extractedContent.toString().trim();

    /* Anti-flood */
    this.antifloodService.registerMessageTimestamp(remoteJid);
    if (this.antifloodService.isSynchronizedPattern(remoteJid)) {
      await this.sessionService.updateSessionStatus(
        remoteJid,
        instanceName,
        false,
        userWithRelations.id,
      );
      logger.warn('Patrón sincronizado detectado → sesión desactivada.');
      return;
    }

    /* Buffer + IA + CHATBOT */
    this.messageBufferService.handleIncomingMessage(
      remoteJid,
      incomingMessage,
      delayConversation,
      async (mergedText) => {
        try {
          const mergedTextStr = mergedText.toString();

          // Limpiar inactividad porque el agente ya respondió con un flujo
          await this.sessionService.clearInactividadAfterAgentReply(
            userId,
            remoteJid,
            instanceName,
          );

          // Guardamos el mensaje completo que se acumuló en el buffer
          await this.chatHistoryService.saveMessage(
            sessionHistoryId,
            mergedTextStr,
            'human',
          );

          // 1)  PRIMERO: reanudar si hay un workflow pausado (intention waiting)
          const resumed = await this.workflowService.continuePausedWorkflow(
            server_url,
            apikey,
            instanceName,
            remoteJid,
            userId,
            mergedTextStr,
          );

          if (resumed) {
            logger.log('Continuación de workflow pausado (intention) ejecutada. No se usa IA.', 'WebhookService');
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

            await this.workflowService.executeWorkflow(
              matchedWorkflow.name,
              server_url,
              apikey,
              instanceName,
              remoteJid,
              userId,
            );

            // Importante: NO usamos IA si ya encontramos un flujo
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
            remoteJid,
          };

          const aiResponse = await this.aiAgentService.processInput(
            dataProccessInput,
          );
          if (!aiResponse || aiResponse === '') return;

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
              remoteJid,
              msgBlock,
            );
            await new Promise((res) => setTimeout(res, 300));
          }

        } catch (err: any) {
          logger.error(
            'Error en callback de messageBufferService.handleIncomingMessage (se evita crash global).',
            err?.message || err,
          );
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
          await this.nodeSenderService.sendTextNode(apiUrl, apikey, userPhone, flags[0].message);
        } catch (error) {
          logger.error(`Error enviando notificación por flag ${credits.msg}`, error);
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
            await this.nodeSenderService.sendTextNode(apiUrl, apikey, userPhone, flag.message);
          } catch (error) {
            logger.error(`Error enviando notificación por flag ${flag.value}`, error);
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
  private async checkOrRegisterSession(
    remoteJid: string,
    instanceName: string,
    userId: string,
    pushName: string,
    userWithRelations: UserWithPausar,
    remoteJidAlt?: string,
  ): Promise<boolean> {
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // 1) Intentar con el JID principal (prioriza @s.whatsapp.net)
    let session = await this.sessionService.getSession(remoteJid, instanceName, userId);

    // 2) Si no existe y hay un JID alternativo distinto, intentar con él (ej: @lid)
    if (!session && remoteJidAlt && remoteJidAlt !== remoteJid) {
      const sessionAlt = await this.sessionService.getSession(remoteJidAlt, instanceName, userId);

      if (sessionAlt) {
        logger.log(`[SESSION] Usuario ya registrado con JID alternativo: ${remoteJidAlt}`);

        // 🧠 Normalizar: actualizamos el remoteJid en BD al canon (@s.whatsapp.net si es el seleccionado)
        if (sessionAlt.remoteJid !== remoteJid) {
          try {
            await this.sessionService.updateSessionRemoteJid(sessionAlt.id, remoteJid);
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
      logger.log(`[SESSION] Usuario ya registrado: ${session.remoteJid}`);

      const hasTrigger = await this.sessionTriggerService.findBySessionId(
        session.id.toString(),
      );
      const dateReactivate = await this.getReactivateDate({ userWithRelations });

      if (!hasTrigger) {
        if (dateReactivate) {
          await this.sessionTriggerService.create(session.id.toString(), dateReactivate);
          logger.log(`[TRIGGER] Reactivación programada para: ${dateReactivate}`);
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

      return session.status;
    }

    // 3) Si no hay sesión ni por JID canon ni alterno, registrar usando el canon
    await this.sessionService.registerSession(userId, remoteJid, pushName, instanceName);
    logger.log(`✅ Registro exitoso para ${remoteJid}`);
    return true;
  }

  private async getReactivateDate({
    userWithRelations,
  }: getReactivateDate): Promise<string | null> {
    const logger = this.scopedLogger({ userId: userWithRelations?.id });
    if (!userWithRelations) {
      logger.error('Se esperaba el userWithRelations para reactivar el chat.');
      return null;
    }

    const minutesToReactivate = parseInt(userWithRelations.autoReactivate ?? '');
    if (isNaN(minutesToReactivate)) {
      logger.error(`Valor inválido para autoReactivate: "${userWithRelations.autoReactivate}"`);
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
    const logger = this.scopedLogger({ userId: userWithRelations?.id, instanceName, remoteJid });

    await this.sessionService.updateSessionStatus(
      remoteJid,
      instanceName,
      false,
      userWithRelations.id,
    );
    logger.log(`Chat pausado para ${remoteJid}.`);

    if (remoteJidAlt && remoteJidAlt !== remoteJid) {
      await this.sessionService.updateSessionStatus(
        remoteJidAlt,
        instanceName,
        false,
        userWithRelations.id,
      );
      logger.log(`Chat pausado también para JID alternativo: ${remoteJidAlt}.`);
    }

    if (!sessionStatus) {
      if (!userWithRelations) {
        logger.warn('No se encontró el usuario para obtener la frase de reactivación.');
        return;
      }

      const dataPausar = userWithRelations.pausar ?? [];
      const pausarItem = dataPausar.find((p) => p.tipo === 'abrir');

      if (!pausarItem) {
        logger.warn('El usuario no tiene frase de reactivación configurada.');
        return;
      }

      const phraseToReactivateChat = pausarItem.mensaje;
      logger.log(`Frase de reactivación del usuario: "${phraseToReactivateChat}"`);

      if (conversationMsg === phraseToReactivateChat.trim().toLowerCase()) {
        logger.log('Frase correcta detectada. Reactivando chat...');
        await this.sessionService.updateSessionStatus(
          remoteJid,
          instanceName,
          true,
          userWithRelations.id,
        );

        // Opcional: si quieres reactivar también el alternativo:
        if (remoteJidAlt && remoteJidAlt !== remoteJid) {
          await this.sessionService.updateSessionStatus(
            remoteJidAlt,
            instanceName,
            true,
            userWithRelations.id,
          );
          logger.log(`Chat reactivado también para JID alternativo: ${remoteJidAlt}.`);
        }

        return;
      }
    }

    const pharaseToDelSeguimiento = userWithRelations.delSeguimiento ?? '';

    if (conversationMsg === pharaseToDelSeguimiento.trim().toLowerCase()) {
      logger.log('Frase correcta detectada. Eliminando seguimiento...');
      try {
        const { count } = await this.seguimientosService.deleteSeguimientosByRemoteJid(
          remoteJid,
          instanceName,
        );
        if (count && count > 0) {
          logger.log('Seguimiento eliminado con exito.');
        } else {
          logger.log('No se encontró un seguimiento relacionado.');
        }
      } catch (error) {
        logger.error('ERROR_SEGUIMIENTOS', error);
      }
      return;
    }

    // await this.sessionService.isSessionActive(remoteJid, userWithRelations.id, instanceName);

    await this.onAutoReplies({
      userId: userWithRelations.id.toString(),
      conversationMsg,
      server_url,
      apikey,
      instanceName,
      remoteJid,
    });
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
    try {
      const autoReplies = await this.autoRepliesService.getAutoRepliesByUserId(userId);
      if (!autoReplies || autoReplies.length === 0) return;

      const matchedReply = autoReplies.find(
        (reply) => reply.mensaje?.trim().toLowerCase() === conversationMsg,
      );

      if (matchedReply) {
        logger.log(`Respuesta rápida encontrada: ${matchedReply.mensaje}`);
        const workflow = await this.workflowService.getWorkflowByWorkflowId(
          matchedReply.workflowId,
        );
        if (!workflow) return;

        // 👉 AQUÍ LIMPIAMOS INACTIVIDAD ANTES DE RESPONDER
        await this.sessionService.clearInactividadAfterAgentReply(
          userId,
          remoteJid,
          instanceName,
        );

        await this.workflowService.executeWorkflow(
          workflow?.name ?? '',
          server_url,
          apikey,
          instanceName,
          remoteJid,
          userId,
        );

        // await this.sessionService.updateSessionStatus(remoteJid, instanceName, true, userId);
        // logger.log(`Chat reactivado.`);
      }
    } catch (error) {
      logger.error('Error al procesar autoReplies', error);
    }
  }
}
