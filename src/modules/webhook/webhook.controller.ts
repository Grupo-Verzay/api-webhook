import { Controller, Post, Body, Res } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { Response } from 'express';
import { LoggerService } from 'src/core/logger/logger.service';

@Controller('webhook')
export class WebhookController {
  constructor(
    private readonly webhookService: WebhookService,
  ) { }

  @Post()
  async recibirWebhook(@Body() payload: any, @Res() res: Response) {
    try {
      await this.webhookService.processWebhook(payload);
      return res.status(200).send('Webhook recibido y procesado con éxito');
    } catch (error) {
      console.error('❌ Error en el webhook:', error);
      return res.status(500).send('Error procesando el webhook');
    }
  }
}
