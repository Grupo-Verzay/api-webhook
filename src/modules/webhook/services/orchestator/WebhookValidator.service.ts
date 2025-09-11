import { Injectable, Logger } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { AiCreditsService } from 'src/modules/ai-credits/ai-credits.service';
import { NodeSenderService } from 'src/modules/workflow/services/node-sender.service.ts/node-sender.service';
import { CreditValidationInput, flags } from 'src/types/open-ai';
// import { isGroupChat } from 'src/modules/webhook/utils/is-group-chat';

export class WebhookValidatorService {
  static FLAGS = flags
  constructor(
    private readonly logger: LoggerService,
    private readonly aiCreditsService: AiCreditsService,
    private readonly nodeSenderService: NodeSenderService,
  ) { }
  async creditValidation({ userId, webhookUrl, apiUrl, apikey, userPhone }: CreditValidationInput): Promise<boolean> {
    const flags = WebhookValidatorService.FLAGS
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
  
  isGroupChat(remoteJid: string): boolean {
    return remoteJid.endsWith('@g.us');
  }

}