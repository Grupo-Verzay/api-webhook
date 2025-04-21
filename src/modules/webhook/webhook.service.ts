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
import { isGroupChat } from './utils/is-group-chat';
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

    const pureRemoteJid = data?.key?.remoteJid ?? '';
    const remoteJid = parseRemoteJid(pureRemoteJid);
    const pushName = data?.pushName || 'Desconocido';

    const prismaInstancia = await this.instancesService.getUserId(instanceName);
    const userId = prismaInstancia?.userId ?? '';
    const instanceId = prismaInstancia?.instanceId ?? '';
    const fromMe = data?.key?.fromMe ?? false;
    const messageType = data?.messageType ?? '';

    await this.checkOrRegisterSession(remoteJid, instanceId, userId, pushName);

    /* Validar si el mensaje proviene de un grupo. */
    if (isGroupChat(remoteJid)) {
      this.logger.log('🔇 Mensaje de grupo detectado, no se responderá.', 'WebhookService');
      return;
    }

    /* Validar quién está escribiendo y ejecutar pausas, reactivaciones o seguimientos */
    if (this.messageDirectionService.isFromMe(fromMe)) {
      this.logger.log(`Is from me: ${fromMe}`, 'WebhookService');

      // 1. Poner el estado del chat en falso
      await this.sessionService.updateSessionStatus(remoteJid, instanceId, false);
      this.logger.log(`Chat pausado.`, 'WebhookService');

      // 2. Monitoreo de PAUSA: buscar palabra clave para reactivación
      const userWithRelations = await this.userService.getUserWithPausar(userId);

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

      const conversationMsg = data?.message?.conversation ?? '';

      // 3. Verificar si el cliente escribió la frase correcta para reactivar
      if (conversationMsg.trim().toLowerCase() === phraseToReactivateChat.trim().toLowerCase()) {
        this.logger.log('Frase correcta detectada. Reactivando chat...', 'WebhookService');
        await this.sessionService.updateSessionStatus(remoteJid, instanceId, true);
        return;
      }

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
    const extractedContent = this.messageTypeHandlerService.extractContentByType(messageType, data);
    this.logger.debug(`Ouput AI - proceso multimedia: ${JSON.stringify(extractedContent)}`, 'WebhookService');
    /* LLamado al agente IA */
    const aiResponse = await this.aiAgentService.processInput((await extractedContent).toString(), userId);
    this.logger.debug(`Ouput AI - respuesta del agente IA: ${JSON.stringify(aiResponse)}`, 'WebhookService');

    /* Enviar mensaje al cliente */
    await this.sendMessageToClient(pureRemoteJid, aiResponse, instanceName, server_url, apikey);
    // Continuar con workflow...
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
  ): Promise<void> {
    const session = await this.sessionService.getSession(remoteJid, instanceId, userId);

    if (session) {
      this.logger.log(`[SESSION] Usuario ya registrado: ${remoteJid}`, 'WebhookService');
    } else {
      await this.sessionService.registerSession(userId, remoteJid, pushName, instanceId);
      this.logger.log(`✅ Registro exitoso`, 'WebhookService');
    }
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