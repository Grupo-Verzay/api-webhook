import { Injectable } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { LoggerService } from 'src/core/logger/logger.service';
import { WebhookBodyDto } from './dto/webhook-body';
import { MessageDirectionService } from './services/message-direction/message-direction.service';
import { MessageTypeHandlerService } from './services/message-type-handler/message-type-handler.service';
import { InstancesService } from '../instances/instances.service';
import { AiAgentService } from '../ai-agent/ai-agent.service';
import { UserService } from '../user/user.service';
import { isGroupChat } from './utils/is-group-chat';
import { Pausar, rr, User } from '@prisma/client';
import { MessageBufferService } from './services/message-buffer/message-buffer.service';
import { ChatHistoryService } from '../chat-history/chat-history.service';
import { NodeSenderService } from '../workflow/services/node-sender.service.ts/node-sender.service';
import { SeguimientosService } from '../seguimientos/seguimientos.service';
import { AutoRepliesService } from '../auto-replies/auto-replies.service';
import { WorkflowService } from '../workflow/services/workflow.service.ts/workflow.service';
import { AiCreditsService } from '../ai-credits/ai-credits.service';
import { SessionTriggerService } from '../session-trigger/session-trigger.service';
import { CreditValidationInput, onAutoRepliesInterface, stopOrResumeConversation, flags, getReactivateDate } from 'src/types/open-ai';
import { AntifloodService } from './services/antiflood/antiflood.service';

@Injectable()
export class WebhookService {
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
   * Procesa un webhook recibido de Evolution API.
   *
   * @param {WebhookBodyDto} body - Payload recibido del webhook.
   * @returns {Promise<void>}
   */
  async processWebhook(body: WebhookBodyDto): Promise<void> {
    const {
      instance: instanceName,
      server_url,
      apikey,
      data,
    } = body;

    const delayConversation = 10000;
    const remoteJid = data?.key?.remoteJid ?? '';
    const pushName = data?.pushName || 'Desconocido';

    const prismaInstancia = await this.instancesService.getUserId(instanceName);
    const userId = prismaInstancia?.userId ?? '';
    const instanceId = prismaInstancia?.instanceId ?? '';
    const fromMe = data?.key?.fromMe ?? false;
    const messageType = data?.messageType ?? '';
    /* user information */
    const userWithRelations = await this.userService.getUserWithPausar(userId) as User & { pausar: Pausar[] };
    /* apikey */
    const apikeyOpenAi = userWithRelations?.apiUrl as string;

    const sessionStatus = await this.checkOrRegisterSession(remoteJid, instanceName, userId, pushName, userWithRelations);
    const msgChat = data?.message?.conversation ?? '';
    const conversationMsg = msgChat.trim().toLowerCase();
    const sessionHistoryId = `${instanceName}-${remoteJid}`;
    const apiMsgUrl = `${server_url}/message/sendText/${instanceName}`;

    /* Validar créditos */
    const creditOk = await this.creditValidation({
      flags,
      userId,
      webhookUrl: userWithRelations.webhookUrl ?? '',
      apikey,
      apiUrl: apiMsgUrl,
      userPhone: userWithRelations.notificationNumber
    });

    if (!creditOk) {
      return;
    }

    /* Validar si el mensaje proviene de un grupo. */
    if (isGroupChat(remoteJid)) {
      this.logger.log('🔇 Mensaje de grupo detectado, no se responderá.', 'WebhookService');
      return;
    }

    this.logger.log(`Is from me: ${fromMe}`);

    /* Validar quién está escribiendo y ejecutar pausas, reactivaciones o seguimientos */
    if (this.messageDirectionService.isFromMe(fromMe)) {
      /* Encargada de reanudar o pausar el chat */
      await this.stopOrResumeConversation({ conversationMsg, remoteJid, instanceId, sessionStatus, userWithRelations, instanceName, apikey, server_url });
      return;
    }

    /* Validar si la session está activa */
    const sessionActive = await this.sessionService.isSessionActive(remoteJid, userId);
    this.logger.log(`Estado de la session: ${sessionActive}`, 'WebhookService');

    if (!sessionActive) {
      // Terminar flujo
      return;
    }

    /* Extraer la data dependiendo del tipo de mensaje, "text", "media", "audio" */
    const extractedContent = await this.messageTypeHandlerService.extractContentByType(messageType, apikeyOpenAi, data);
    const incomingMessage = extractedContent.toString().trim().toLowerCase();


    /* Registra un nuevo mensaje y evalúa si hay un patrón robótico de sincronía */
    // Primero registramos
    this.antifloodService.registerMessageTimestamp(remoteJid);

    // Luego evaluamos
    if (this.antifloodService.isSynchronizedPattern(remoteJid)) {
      await this.sessionService.updateSessionStatus(remoteJid, instanceName, false, userWithRelations.id);
      return;
    }

    /* Get data to process text by Open AI */
    this.messageBufferService.handleIncomingMessage(
      remoteJid,
      incomingMessage,
      delayConversation,
      async (mergedText) => {
        // Guardar historial
        await this.chatHistoryService.saveMessage(sessionHistoryId, mergedText, 'human');

        // Si no es un flujo, continuar con respuesta IA
        const dataProccessInput = {
          input: mergedText,
          userId,
          apikeyOpenAi,
          sessionId: sessionHistoryId,
          server_url,
          apikey,
          instanceName,
          remoteJid,
        };

        const aiResponse = await this.aiAgentService.processInput(dataProccessInput);
        if (!aiResponse || aiResponse === '') return;

        /* Mutea el agente si muteAgentResponses es verdadero*/
        if (userWithRelations.muteAgentResponses) {
          this.logger.warn(`🔇 Agente muteado, no se enviará respuesta.`, 'muteAgentResponses');
          return;
        };

        // Guardar historial
        await this.chatHistoryService.saveMessage(sessionHistoryId, aiResponse, 'ia');

        /* Envió de mensajes */
        const msgBlocks = aiResponse
          .split('\n\n')
          .map((b) => b.trim())
          .filter((b) => b.length > 0);

        if (msgBlocks.length === 0) {
          this.logger.warn(`El mensaje está vacío después de procesar bloques para ${remoteJid}`, 'NodeSenderService');
          return;
        };

        for (const [index, msgBlock] of msgBlocks.entries()) {
          // this.logger.log(`📤 Enviando bloque ${index + 1}/${msgBlocks.length} a ${remoteJid}: "${msgBlock}"`, 'NodeSenderService');
          this.logger.log(`📤 Enviando bloque ${index + 1}/${msgBlocks.length} a ${remoteJid}`, 'NodeSenderService');

          await this.nodeSenderService.sendTextNode(apiMsgUrl, apikey, remoteJid, msgBlock);

          await new Promise((res) => setTimeout(res, 1200)); // delay entre mensajes
        };

        // ✅ Conversación exitosa: reiniciar contador de flood
        // this.antifloodService.clear(remoteJid);
      })
  };

  private async creditValidation({ userId, flags, webhookUrl, apiUrl, apikey, userPhone }: CreditValidationInput): Promise<boolean> {
    try {
      if (!webhookUrl || webhookUrl.trim() === '') {

        this.logger.warn(`creditValidation: webhookUrl vacío para userId=${userId}`);
        return false;
      }

      const credits = await this.aiCreditsService.getCreditsByUser(userId);

      if (!credits.success) {
        try {
          await this.nodeSenderService.sendTextNode(apiUrl, apikey, userPhone, flags[0].message);
        } catch (error) {
          this.logger.error(`Error enviando notificación por flag ${credits.msg}`, error?.message || error);
        }
        return false;
      }

      const { available } = credits;

      this.logger.log(`creditValidation: Créditos disponibles para ${userId} → ${available}`);

      // 1. Analizar flags y notificar si corresponde
      const range = 5; // margen de ±5 créditos

      for (const flag of flags) {
        const min = flag.value - range;
        const max = flag.value + range;

        if (available >= min && available <= max) {
          this.logger.log(
            `⚠️ userId=${userId} alcanzó rango de créditos ${flag.value} (dentro de ${min}-${max}). Enviando mensaje... "${flag.message}"`
          );

          try {
            await this.nodeSenderService.sendTextNode(apiUrl, apikey, userPhone, flag.message);
          } catch (error) {
            this.logger.error(`Error enviando notificación por flag ${flag.value}`, error?.message || error);
          }
        }
      }

      // 2. Detener el flujo si no hay créditos
      if (available <= 0) {
        this.logger.error(`❌ SIN CRÉDITOS: Deteniendo flujo para userId=${userId}`);
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error('Error en creditValidation', error?.message || error, 'WebhookService');
      return false;
    }
  }

  /**
   * Verifica si una sesión existe o registra una nueva si no existe.
   *
   * @param remoteJid - ID del usuario remoto (JID de WhatsApp).
   * @param instanceName - Nombre de la instancia.
   * @param userId - ID del usuario interno.
   * @param pushName - Nombre mostrado en WhatsApp.
   * @param userWithRelations - Usuario con relaciones (ej. pausar) para lógica de reactivación.
   * @returns true si la sesión está activa, false si no.
   */
  private async checkOrRegisterSession(
    remoteJid: string,
    instanceName: string,
    userId: string,
    pushName: string,
    userWithRelations: User & { pausar: Pausar[] }
  ): Promise<boolean> {
    const session = await this.sessionService.getSession(remoteJid, instanceName, userId);
    if (session) {
      this.logger.log(`[SESSION] Usuario ya registrado: ${remoteJid}`, 'WebhookService');

      const hasTrigger = await this.sessionTriggerService.findBySessionId(session.id.toString());
      const dateReactivate = await this.getReactivateDate({ userWithRelations });

      if (!hasTrigger) {
        if (dateReactivate) {
          await this.sessionTriggerService.create(session.id.toString(), dateReactivate);
          this.logger.log(`[TRIGGER] Reactivación programada para: ${dateReactivate}`, 'WebhookService');
        }
      } else {
        if (dateReactivate) {
          await this.sessionTriggerService.updateTimeBySessionId(session.id.toString(), dateReactivate);
          this.logger.log(`[TRIGGER] Fecha actualizada a: ${dateReactivate}`, 'WebhookService');
        }
      }

      return session.status;
    }

    await this.sessionService.registerSession(userId, remoteJid, pushName, instanceName);
    this.logger.log(`✅ Registro exitoso para ${remoteJid}`, 'WebhookService');
    return true;
  }

  /**
   * Calcula la fecha futura en la que se debe reactivar el chat para un usuario.
   * Suma los minutos indicados en `autoReactivate` a la fecha actual.
   * 
   * @param userWithRelations - Objeto que contiene la configuración del usuario.
   * @returns Fecha futura como objeto `Date`, o `null` si hay error.
   */
  private async getReactivateDate({ userWithRelations }: getReactivateDate): Promise<string | null> {
    if (!userWithRelations) {
      this.logger.error('Se esperaba el userWithRelations para reactivar el chat.');
      return null;
    }

    const minutesToReactivate = parseInt(userWithRelations.autoReactivate ?? '');
    if (isNaN(minutesToReactivate)) {
      this.logger.error(`Valor inválido para autoReactivate: "${userWithRelations.autoReactivate}"`);
      return null;
    }

    const MILLISECONDS_PER_MINUTE = 60000;
    const currentDate = new Date();
    const futureDate = new Date(currentDate.getTime() + minutesToReactivate * MILLISECONDS_PER_MINUTE);

    // Formateamos la fecha como string
    const formatDate = (date: Date): string => {
      const pad = (n: number) => n.toString().padStart(2, '0');
      const day = pad(date.getDate());
      const month = pad(date.getMonth() + 1);
      const year = date.getFullYear();
      const hours = pad(date.getHours());
      const minutes = pad(date.getMinutes());
      return `${day}/${month}/${year} ${hours}:${minutes}`;
    };

    const formatted = formatDate(futureDate);
    this.logger.debug(`Fecha de reactivación calculada: ${formatted}`);

    return formatted;
  }

  /**
   * Envía un mensaje de texto a un cliente de WhatsApp a través de la Evolution API.
   *
   * @private
   * @param {string} conversationMsg - Número de teléfono del destinatario en formato internacional.
   * @param {string} remoteJid - Contenido del mensaje de texto que se desea enviar.
   * @param {string} instanceId - Nombre de la instancia de Evolution asociada al envío.
   * @param {boolean} sessionStatus - URL base del servidor Evolution API para el envío de mensajes.
   * @param {User & {pausar: Pausar[]}} userWithRelations - Clave API para autorización en el servidor Evolution.
   * @returns {Promise<void>} - No retorna ningún valor. Lanza logs en caso de éxito o error.
   */
  private async stopOrResumeConversation(
    {
      conversationMsg,
      remoteJid,
      instanceId,
      sessionStatus,
      userWithRelations,
      instanceName,
      apikey,
      server_url
    }: stopOrResumeConversation) {


    // Poner el estado del chat en falso
    await this.sessionService.updateSessionStatus(remoteJid, instanceName, false, userWithRelations.id);
    this.logger.log(`Chat pausado.`, 'WebhookService');

    //Pausar chat  
    if (!sessionStatus) {
      // Monitoreo de PAUSA: buscar palabra clave para reactivación
      if (!userWithRelations) {
        this.logger.warn('No se encontró el usuario para obtener la frase de reactivación.', 'WebhookService');
        return;
      }

      const dataPausar = userWithRelations.pausar ?? [];
      const pausarItem = dataPausar.find(p => p.tipo === 'abrir');

      if (!pausarItem) {
        this.logger.warn('El usuario no tiene frase de reactivación configurada.', 'WebhookService');
        return;
      }

      const phraseToReactivateChat = pausarItem.mensaje;
      this.logger.log(`Frase de reactivación del usuario: "${phraseToReactivateChat}"`, 'WebhookService');

      // 3. Verificar si el cliente escribió la frase correcta para reactivar
      if (conversationMsg === phraseToReactivateChat.trim().toLowerCase()) {
        this.logger.log('Frase correcta detectada. Reactivando chat...', 'WebhookService');
        await this.sessionService.updateSessionStatus(remoteJid, instanceName, true, userWithRelations.id);
        return;
      }
    }

    const pharaseToDelSeguimiento = userWithRelations.del_seguimiento ?? '';

    //Eliminar seguimiento
    if (conversationMsg === pharaseToDelSeguimiento.trim().toLowerCase()) {
      this.logger.log('Frase correcta detectada. Eliminando seguimiento...', 'WebhookService');
      try {
        const { count } = await this.seguimientosService.deleteSeguimientosByRemoteJid(remoteJid, instanceName);
        if (count && count > 0) {
          this.logger.log('Seguimiento eliminado con exito.', 'WebhookService');
        } else {
          this.logger.log('No se encontró un seguimiento relacionado.', 'WebhookService');
        }
      } catch (error) {
        this.logger.error('ERROR_SEGUIMIENTOS', error);
      }
    };

    //Flujo de respuestas rapidas
    await this.onAutoReplies({
      userId: userWithRelations.id.toString(),
      conversationMsg,
      server_url,
      apikey,
      instanceName,
      remoteJid,
    });
  };

  /**
   * Busca coincidencias de mensajes automáticos configurados para un usuario
   * y ejecuta el workflow correspondiente si encuentra una coincidencia exacta.
   *
   * @private
   * @param {string} userId - ID del usuario que posee las respuestas automáticas configuradas.
   * @param {string} conversationMsg - Mensaje de conversación recibido que se comparará con las respuestas automáticas.
   * @param {string} server_url - URL base del servidor Evolution API para la ejecución del workflow.
   * @param {string} apikey - Clave API para autorización en el servidor Evolution.
   * @param {string} instanceName - Nombre de la instancia de Evolution asociada a la sesión del usuario.
   * @param {string} remoteJid - Identificador remoto del cliente de WhatsApp (por ejemplo, número de teléfono en formato JID).
   * @returns {Promise<void>} - No retorna ningún valor. Ejecuta el workflow asociado o registra errores en el sistema de logs.
   */

  private async onAutoReplies({ userId, conversationMsg, server_url, apikey, instanceName, remoteJid, }: onAutoRepliesInterface): Promise<void> {
    try {
      const autoReplies = await this.autoRepliesService.getAutoRepliesByUserId(userId);

      if (!autoReplies || autoReplies.length === 0) return;

      const matchedReply = autoReplies.find(
        reply => reply.mensaje?.trim().toLowerCase() === conversationMsg
      );

      if (matchedReply) {
        // Aquí puedes ejecutar lo que desees con matchedReply
        // Por ejemplo: enviar la respuesta automática
        this.logger.log(`Respuesta rápida encontrada: ${matchedReply.mensaje}`);
        //Obtener workflow by ID
        const workflow = await this.workflowService.getWorkflowByWorkflowId(matchedReply.workflowId);
        if (!workflow) return;

        await this.workflowService.executeWorkflow(
          workflow?.name ?? '',
          server_url,
          apikey,
          instanceName,
          remoteJid,
          userId
        );
      }
    } catch (error) {
      this.logger.error('Error al procesar autoReplies', error);
    }
  };

}