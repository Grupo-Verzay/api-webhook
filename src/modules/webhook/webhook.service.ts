import { Injectable } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { parseRemoteJid } from './utils/parse-remote-jid.util'; // Utilidad separada
import { LoggerService } from 'src/core/logger/logger.service';
import { WebhookBodyDto } from './dto/webhook-body';
import { MessageDirectionService } from './services/message-direction/message-direction.service';
import { MessageTypeHandlerService } from './services/message-type-handler/message-type-handler.service';
import { InstancesService } from '../instances/instances.service';
import { AiAgentService } from '../ai-agent/ai-agent.service';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { UserService } from '../user/user.service';
import { isGroupChat } from './utils/is-group-chat';
import { Pausar, User } from '@prisma/client';
import { MessageBufferService } from './services/message-buffer/message-buffer.service';
import { ChatHistoryService } from '../chat-history/chat-history.service';
import { WorkflowService } from '../workflow/services/workflow.service.ts/workflow.service';
import { IntentionService } from '../ai-agent/services/intention/intention.service';
import { Decision, IntentionItem } from 'src/types/open-ai';
import { NodeSenderService } from '../workflow/services/node-sender.service.ts/node-sender.service';

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
    private readonly httpService: HttpService,
    private readonly workflowService: WorkflowService,
    private readonly intentionService: IntentionService,
    private readonly nodeSenderService: NodeSenderService,
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
    const pureRemoteJid = data?.key?.remoteJid ?? '';
    const remoteJid = parseRemoteJid(pureRemoteJid);
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

    const sessionStatus = await this.checkOrRegisterSession(remoteJid, instanceId, userId, pushName);
    const conversationMsg = data?.message?.conversation ?? '';
    const sessionHistoryId = `${instanceName}-${pureRemoteJid}`;

    /* Validar si el mensaje proviene de un grupo. */
    if (isGroupChat(remoteJid)) {
      this.logger.log('🔇 Mensaje de grupo detectado, no se responderá.', 'WebhookService');
      return;
    }

    this.logger.debug(`Is from me: ${fromMe}`, 'WebhookService');

    /* Validar quién está escribiendo y ejecutar pausas, reactivaciones o seguimientos */
    if (this.messageDirectionService.isFromMe(fromMe)) {
      /* Encargada de reanudar o pausar el chat */
      await this.stopOrResumeConversation(conversationMsg, remoteJid, instanceId, sessionStatus, userWithRelations);
      return;
    }

    /* Validar si la session está activa */
    const sessionActive = await this.sessionService.isSessionActive(remoteJid);
    this.logger.log(`Estado de la session: ${sessionActive}`, 'WebhookService');
    if (!sessionActive) {
      // Terminar flujo
      return;
    }

    /* Extraer la data dependiendo del tipo de mensaje, "text", "media", "audio" */
    const extractedContent = await this.messageTypeHandlerService.extractContentByType(messageType, apikeyOpenAi, data);
    const incomingMessage = extractedContent.toString().trim().toLowerCase();

    /* Send */
    this.messageBufferService.handleIncomingMessage(
      remoteJid,
      incomingMessage,
      delayConversation,
      async (mergedText) => {
        this.logger.debug(`Merged text ready for AI processing: ${mergedText}`, 'WebhookService');

        // Guardar historial
        await this.chatHistoryService.saveMessage(sessionHistoryId, mergedText);


        // Obtener intenciones posibles
        const workflows = await this.workflowService.getWorkflow(userId);
        const posiblesIntenciones: IntentionItem[] = workflows.map((flow) => ({
          name: flow.name,
          tipo: 'flujo',
          frase: flow.description ?? flow.name,
        }));

        // Detectar intención con embeddings usando el mensaje unificado
        const result = await this.intentionService.detectIntent(mergedText, posiblesIntenciones, apikeyOpenAi);
        const decision = result;

        await this.alreadyMsgExecuted(
          sessionHistoryId,
          decision,
          pureRemoteJid,
          instanceName,
          server_url,
          apikey,
          mergedText,
          userId,
          apikeyOpenAi,
        );
      }
    );
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
    instanceId: string,
    userId: string,
    pushName: string,
  ): Promise<boolean> {
    const session = await this.sessionService.getSession(remoteJid, instanceId, userId);

    if (session) {
      this.logger.log(`[SESSION] Usuario ya registrado: ${remoteJid}`, 'WebhookService');
    } else {
      await this.sessionService.registerSession(userId, remoteJid, pushName, instanceId);
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
    conversationMsg: string,
    remoteJid: string,
    instanceId: string,
    sessionStatus: boolean,
    userWithRelations: User & { pausar: Pausar[] },
  ) {

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
      if (conversationMsg.trim().toLowerCase() === phraseToReactivateChat.trim().toLowerCase()) {
        this.logger.log('Frase correcta detectada. Reactivando chat...', 'WebhookService');
        await this.sessionService.updateSessionStatus(remoteJid, instanceId, true);
        return;
      }
    }
    // Poner el estado del chat en falso
    await this.sessionService.updateSessionStatus(remoteJid, instanceId, false);
    this.logger.log(`Chat pausado.`, 'WebhookService');
  }

  /**
   * Verifica si ya se ha enviado un flujo/intención al usuario. Si ya fue enviado,
   * responde con un mensaje alternativo. Si no, lo registra y lo ejecuta.
   *
   * @private
   * @param sessionHistoryId - ID único de sesión (ej: instancia + remoteJid)
   * @param decision - Intención detectada con nombre y tipo
   * @param pureRemoteJid - Número del cliente en formato WhatsApp
   * @param instanceName - Nombre de la instancia en Evolution API
   * @param server_url - URL base del servidor Evolution
   * @param apikey - API Key para autorización con Evolution
   * @param mergedText - Texto merged
   * @param userId - User ID
   * @param apikeyOpenAi - API Key Open AI
   * @returns {Promise<void>}
   */
  private async alreadyMsgExecuted(
    sessionHistoryId: string,
    decision,
    pureRemoteJid: string,
    instanceName: string,
    server_url: string,
    apikey: string,
    mergedText: string,
    userId: string,
    apikeyOpenAi: string,
  ): Promise<void> {
    const url = `${server_url}/message/sendText/${instanceName}`;
    this.logger.debug(`Decision que retorna la función detectIntent: ${JSON.stringify(decision)}`);

    if (decision) {
      const alreadyExecuted = await this.chatHistoryService.hasIntentionBeenExecuted(sessionHistoryId, decision.name);

      if (alreadyExecuted) {
        const msg = `Ya te compartí "${decision?.name}", ¿quieres otra cosa?`;
        this.logger.log(`Intención ya ejecutada anteriormente: ${decision?.name}`, 'WebhookService');

        await this.nodeSenderService.sendTextNode(url, apikey, pureRemoteJid, msg);
        return;
      }

      await this.chatHistoryService.registerExecutedIntention(sessionHistoryId, decision?.name, decision?.tipo);
      this.logger.log(`Registrando intención: ${decision?.name} (${decision?.tipo})`, 'WebhookService');

      if (decision?.tipo === 'flujo') {
        this.logger.log(`Intención detectada: ejecutar flujo "${decision?.name}"`, 'WebhookService');

        await this.workflowService.executeWorkflow(
          decision?.name,
          server_url,
          apikey,
          instanceName,
          pureRemoteJid,
        );
        return;
      }

      if (decision?.tipo === 'seguimiento') { }
      if (decision?.tipo === 'notificacion') { }
    }

    // Si no es un flujo, continuar con respuesta IA
    const aiResponse = await this.aiAgentService.processInput(mergedText, userId, apikeyOpenAi, sessionHistoryId);
    await this.nodeSenderService.sendTextNode(url, apikey, pureRemoteJid, aiResponse);
  }

}