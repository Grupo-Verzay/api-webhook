import { Injectable } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { parseRemoteJid } from './utils/parse-remote-jid.util'; // Utilidad separada
import { WebhookBodyDto } from './dto/webhook-body/webhook-body';
import { LoggerService } from 'src/core/logger/logger.service';

@Injectable()
export class WebhookService {
  constructor(
    private readonly logger: LoggerService,
    private readonly sessionService: SessionService,
  ) {}

  /**
   * Procesa un webhook recibido de Evolution API.
   *
   * @param {WebhookBodyDto} body - Payload recibido del webhook.
   * @returns {Promise<void>}
   */
  async procesarWebhook(body: WebhookBodyDto): Promise<void> {
    const {
      instance: instanceName,
      data = {},
    } = body;

    const remoteJid = parseRemoteJid(data?.key?.remoteJid);
    const pushName = data?.pushName || 'Desconocido';

    const prismaInstancia = await this.sessionService.getUserId(instanceName);
    const userId = prismaInstancia?.userId ?? '';
    const instanceId = prismaInstancia?.instanceId ?? '';

    await this.checkOrRegisterSession(remoteJid, instanceId, userId, pushName);
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
}
