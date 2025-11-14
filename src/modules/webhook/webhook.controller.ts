import { Controller, Post, Body, Res } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { Response } from 'express';
import { LoggerService } from 'src/core/logger/logger.service';

@Controller('webhook')
export class WebhookController {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly logger: LoggerService,
  ) { }

  @Post()
    async recibirWebhook(@Body() payload: any, @Res() res: Response) {
        // 1. Responde inmediatamente al remitente del webhook.
        // Esto libera su conexión rápidamente, evitando timeouts y reintentos.
        res.status(200).send('Webhook recibido, procesando en segundo plano');

        // 2. Inicia el proceso pesado sin esperar el 'await'.
        // Aquí usamos .then().catch() o simplemente dejamos la promesa "flotando".
        this.webhookService.processWebhook(payload)
            .catch(error => {
                this.logger.error(`Error asíncrono en el webhook: ${JSON.stringify(error)}`);
                // No se puede enviar error 500 al remitente, la respuesta ya fue enviada.
            });
        // El hilo de ejecución se libera aquí.
    }

}
