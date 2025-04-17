import { Controller, Post, Body, Res } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { Response } from 'express';

@Controller('webhook')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) { }

  @Post()
  async recibirWebhook(@Body() payload: any, @Res() res: Response) {
    console.log('📦 Webhook recibido:', JSON.stringify(payload, null, 2)); // <<--- Aquí se imprime el body bien formateado 
    try {
      await this.webhookService.procesarWebhook(payload);
      return res.status(200).send('Webhook recibido y procesado con éxito');
    } catch (error) {
      console.error('❌ Error en el webhook:', error);
      return res.status(500).send('Error procesando el webhook');
    }
  }
}
