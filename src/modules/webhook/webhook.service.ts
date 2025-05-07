import { Injectable } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { parseRemoteJid } from './utils/parse-remote-jid.util'; // Utilidad separada
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

interface stopOrResumeConversation {
  conversationMsg: string,
  remoteJid: string,
  instanceId: string,
  sessionStatus: boolean,
  userWithRelations: User & { pausar: Pausar[] },
  instanceName: string,
  apikey: string,
  server_url: string
};

interface onAutoRepliesInterface {
  userId: string
  conversationMsg: string
  server_url: string
  apikey: string
  instanceName: string
  remoteJid: string
};

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

    const sessionStatus = await this.checkOrRegisterSession(remoteJid, instanceName, userId, pushName);
    const msgChat = data?.message?.conversation ?? '';
    const conversationMsg = msgChat.trim().toLowerCase();
    const sessionHistoryId = `${instanceName}-${remoteJid}`;
    const apiMsgUrl = `${server_url}/message/sendText/${instanceName}`;

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

    /* Get data to process text by Open AI */
    this.messageBufferService.handleIncomingMessage(
      remoteJid,
      incomingMessage,
      delayConversation,
      async (mergedText) => {
        this.logger.log(`Merged text ready for AI processing: ${mergedText}`);

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

        // Guardar historial
        await this.chatHistoryService.saveMessage(sessionHistoryId, aiResponse, 'ia');

        await this.nodeSenderService.sendTextNode(apiMsgUrl, apikey, remoteJid, aiResponse);
      })
  }

  /**
   * Verifica si una sesión existe o registra una nueva si no existe.
   *
   * @private
   * @param {string} remoteJid
   * @param {string} instanceId
   * @param {string} userId
   * @param {string} pushName
   */
  private async checkOrRegisterSession(
    remoteJid: string,
    instanceName: string,
    userId: string,
    pushName: string,
  ): Promise<boolean> {
    const session = await this.sessionService.getSession(remoteJid, instanceName, userId);

    if (session) {
      this.logger.log(`[SESSION] Usuario ya registrado: ${remoteJid}`, 'WebhookService');
    } else {
      await this.sessionService.registerSession(userId, remoteJid, pushName, instanceName);
      this.logger.log(`✅ Registro exitoso`, 'WebhookService');
    }

    return session?.status ?? false;
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
        await this.sessionService.updateSessionStatus(remoteJid, instanceId, true);
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

    // Poner el estado del chat en falso
    await this.sessionService.updateSessionStatus(remoteJid, instanceId, false);
    this.logger.log(`Chat pausado.`, 'WebhookService');
  }

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
        this.logger.log(`AutoReply encontrada: ${matchedReply.mensaje}`);
        this.logger.log(`WorkflowID: ${matchedReply.workflowId}`);
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
  }

}