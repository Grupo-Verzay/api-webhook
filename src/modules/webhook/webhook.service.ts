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

      // TODO: Continuar con monitoreo de RR y Seguimientos...
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

    /* Ejecución de flujos */
    // Buscar flujos disponibles
    //TODO: SE DEBE DETERMINAR CON BASE AL PROMPT SI SE EJECUTA O NO UN FLUJO
    const workflows = await this.workflowService.getWorkflow();
    const matchedFlow = workflows.find((flow) => incomingMessage.includes(flow.name.toLowerCase()));

    if (matchedFlow) {
      await this.workflowService.executeWorkflow(
        matchedFlow.name,
        server_url,
        apikey,
        instanceName,
        pureRemoteJid,
      );
      return; // Ya ejecutaste un flujo, no proceses normal
    }

    // Detectar comandos especiales
    if (['listo', 'envía', 'terminé'].includes(incomingMessage)) {
      // FLUSH: El usuario terminó de escribir, enviamos lo acumulado YA
      await this.messageBufferService.flush(remoteJid, async (mergedText) => {
        this.logger.debug(`Merged text (flushed) ready for AI processing: ${mergedText}`, 'WebhookService');

        // GUARDAR EN HISTORIAL ✅
        await this.chatHistoryService.saveMessage(sessionHistoryId, mergedText);

        const aiResponse = await this.aiAgentService.processInput(mergedText, userId, apikeyOpenAi, sessionHistoryId);
        await this.sendMessageToClient(pureRemoteJid, aiResponse, instanceName, server_url, apikey);
      });

      return; // No sigas esperando, ya procesaste
    }

    // Detectar cambios de contexto bruscos (opcional)
    if (incomingMessage.includes('otro tema') || incomingMessage.includes('cambiar tema')) {
      // RESET: El usuario quiere hablar de otra cosa
      this.messageBufferService.reset(remoteJid);
    }

    // Si no es "listo" ni cambio de tema, acumula normalmente
    this.messageBufferService.handleIncomingMessage(
      remoteJid,
      incomingMessage,
      delayConversation,
      async (mergedText) => {
        this.logger.debug(`Merged text ready for AI processing: ${mergedText}`, 'WebhookService');

        // GUARDAR EN HISTORIAL ✅
        await this.chatHistoryService.saveMessage(sessionHistoryId, mergedText);

        const aiResponse = await this.aiAgentService.processInput(mergedText, userId, apikeyOpenAi, sessionHistoryId);
        await this.sendMessageToClient(pureRemoteJid, aiResponse, instanceName, server_url, apikey);
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
   * @param {string} remoteJid - Número de teléfono del destinatario en formato internacional.
   * @param {string} message - Contenido del mensaje de texto que se desea enviar.
   * @param {string} instanceName - Nombre de la instancia de Evolution asociada al envío.
   * @param {string} server_url - URL base del servidor Evolution API para el envío de mensajes.
   * @param {string} apikey - Clave API para autorización en el servidor Evolution.
   * @returns {Promise<void>} - No retorna ningún valor. Lanza logs en caso de éxito o error.
   */
  private async sendMessageToClient(
    remoteJid: string,
    message: string,
    instanceName: string,
    server_url: string,
    apikey: string,
  ) {
    try {
      if (!server_url || !apikey) {
        this.logger.error('❌ No se encontraron server_url o apikey dinámicos.', '', 'WebhookService');
        return;
      }

      const url = `${server_url}/message/sendText/${instanceName}`;

      const payload = {
        number: remoteJid,
        text: message,
        delay: 5200,
      };

      await firstValueFrom(
        this.httpService.post(url, payload, {
          headers: {
            apikey: apikey,
            'Content-Type': 'application/json',
          },
        }),
      );

      this.logger.log(`📨 Mensaje enviado exitosamente a ${remoteJid}`, 'WebhookService');
    } catch (error) {
      this.logger.error('❌ Error enviando mensaje a Evolution API', error?.response?.data || error.message, 'WebhookService');
    }
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
}