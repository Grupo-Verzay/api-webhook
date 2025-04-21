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

@Injectable()
export class WebhookService {
  constructor(
    private readonly logger: LoggerService,
    private readonly sessionService: SessionService,
    private readonly userService: UserService,
    private readonly instancesService: InstancesService,
    private readonly messageDirectionService: MessageDirectionService,
    private readonly messageTypeHandlerService: MessageTypeHandlerService,
    private readonly aiAgentService: AiAgentService,

    private readonly httpService: HttpService,
  ) { }

/**
 * Procesa un webhook recibido desde Evolution API.
 *
 * @param {WebhookBodyDto} body - Payload recibido del webhook.
 * @returns {Promise<void>}
 */
async processWebhook(body: WebhookBodyDto): Promise<void> {
  const { instance: instanceName, server_url, apikey, data } = body;

  const remoteJid = parseRemoteJid(data?.key?.remoteJid ?? '');
  const pushName = data?.pushName || 'Desconocido';
  const fromMe = data?.key?.fromMe ?? false;
  const messageType = data?.messageType ?? '';

  const prismaInstancia = await this.instancesService.getUserId(instanceName);
  const userId = prismaInstancia?.userId ?? '';
  const instanceId = prismaInstancia?.instanceId ?? '';

  if (this.isGroupMessage(remoteJid)) return;

  const sessionStatus = await this.checkOrRegisterSession(remoteJid, instanceId, userId, pushName);

  if (this.messageDirectionService.isFromMe(fromMe)) {
    await this.handleOutgoingMessage(remoteJid, instanceId, userId, data, sessionStatus);
    return;
  }

  const sessionActive = await this.sessionService.isSessionActive(remoteJid);
  this.logger.debug(`Session active: ${sessionActive}`, 'WebhookService');
  if (!sessionActive) return;

  await this.processIncomingMessage(remoteJid, messageType, data, userId, instanceName, server_url, apikey);
}

/**
 * Verifica si el mensaje es de un grupo.
 *
 * @param {string} remoteJid
 * @returns {boolean}
 */
private isGroupMessage(remoteJid: string): boolean {
  const isGroup = remoteJid.endsWith('@g.us');
  if (isGroup) {
    this.logger.log('Group message detected. No response will be sent.', 'WebhookService');
  }
  return isGroup;
}

/**
 * Maneja mensajes enviados desde el sistema (fromMe: true).
 *
 * @param {string} remoteJid
 * @param {string} instanceId
 * @param {string} userId
 * @param {any} data
 * @param {boolean} sessionStatus
 */
private async handleOutgoingMessage(
  remoteJid: string,
  instanceId: string,
  userId: string,
  data: any,
  sessionStatus: boolean,
): Promise<void> {
  this.logger.debug('Processing outgoing message.', 'WebhookService');

  if (!sessionStatus) {
    await this.checkChatReactivation(remoteJid, instanceId, userId, data);
  }

  await this.sessionService.updateSessionStatus(remoteJid, instanceId, false);
  this.logger.log('Chat paused after outgoing message.', 'WebhookService');
}

/**
 * Verifica si el usuario reactivó el chat con la frase configurada.
 *
 * @param {string} remoteJid
 * @param {string} instanceId
 * @param {string} userId
 * @param {any} data
 */
private async checkChatReactivation(
  remoteJid: string,
  instanceId: string,
  userId: string,
  data: any,
): Promise<void> {
  const userWithRelations = await this.userService.getUserWithPausar(userId);

  if (!userWithRelations) {
    this.logger.warn('User not found when attempting reactivation.', 'WebhookService');
    return;
  }

  const phraseToReactivateChat = userWithRelations.pausar?.find(p => p.tipo === 'abrir')?.mensaje;
  if (!phraseToReactivateChat) {
    this.logger.warn('No reactivation phrase configured for the user.', 'WebhookService');
    return;
  }

  const conversationMsg = data?.message?.conversation ?? '';
  if (conversationMsg.trim().toLowerCase() === phraseToReactivateChat.trim().toLowerCase()) {
    await this.sessionService.updateSessionStatus(remoteJid, instanceId, true);
    this.logger.log('Chat reactivated successfully.', 'WebhookService');
  }
}

/**
 * Procesa mensajes entrantes de clientes (fromMe: false).
 *
 * @param {string} remoteJid
 * @param {string} messageType
 * @param {any} data
 * @param {string} userId
 * @param {string} instanceName
 * @param {string} serverUrl
 * @param {string} apiKey
 */
private async processIncomingMessage(
  remoteJid: string,
  messageType: string,
  data: any,
  userId: string,
  instanceName: string,
  serverUrl: string,
  apiKey: string,
): Promise<void> {
  const extractedContent = this.messageTypeHandlerService.extractContentByType(messageType, data);

  if (!extractedContent) {
    this.logger.warn('No valid content extracted from incoming message.', 'WebhookService');
    return;
  }

  this.logger.debug(`Extracted content: ${extractedContent}`, 'WebhookService');

  const aiResponse = await this.aiAgentService.processInput(extractedContent.toString(), userId);

  if (!aiResponse) {
    this.logger.warn('No response generated by AI agent.', 'WebhookService');
    return;
  }

  this.logger.debug(`AI agent response: ${aiResponse}`, 'WebhookService');

  await this.sendMessageToClient(remoteJid, aiResponse, instanceName, serverUrl, apiKey);
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
}