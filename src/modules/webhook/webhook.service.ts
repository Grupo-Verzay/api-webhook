import { Injectable } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { parseRemoteJid } from './utils/parse-remote-jid.util'; // Utilidad separada
import { LoggerService } from 'src/core/logger/logger.service';
import { WebhookBodyDto } from './dto/webhook-body';
import { MessageDirectionService } from './services/message-direction/message-direction.service';
import { MessageTypeHandlerService } from './services/message-type-handler/message-type-handler.service';
import { InstancesService } from '../instances/instances.service';
import { AiAgentService } from '../ai-agent/ai-agent.service';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class WebhookService {
  constructor(
    private readonly logger: LoggerService,
    private readonly sessionService: SessionService,
    private readonly instancesService: InstancesService,
    private readonly messageDirectionService: MessageDirectionService,
    private readonly messageTypeHandlerService: MessageTypeHandlerService,
    private readonly aiAgentService: AiAgentService,

    private readonly configService: ConfigService,
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
      data = {},
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

    if (this.messageDirectionService.isFromMe(fromMe)) {
      // Ejecutar otro flujo si es enviado por el sistema
      return;
    }

    /* Validar si la session está activa */
    const sessionActive = await this.sessionService.isSessionActive(remoteJid);
    this.logger.debug(`Estado de la session: ${sessionActive}`, 'WebhookService');
    if (!sessionActive) {
      // Terminar flujo
      return;
    }

    /* Extraer la data dependiendo del tipo de mensaje, "text", "media", "audio" */
    const extractedContent = this.messageTypeHandlerService.extractContentByType(messageType, data);
    this.logger.debug(`Ouput AI - proceso multimedia: ${JSON.stringify(extractedContent)}`, 'WebhookService');
    /* LLamado al agente IA */
    const aiResponse = await this.aiAgentService.processInput((await extractedContent).toString());
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

      this.logger.debug(server_url)
      this.logger.debug(apikey)
      this.logger.debug(instanceName)
      this.logger.debug(remoteJid)
      this.logger.debug(message)

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