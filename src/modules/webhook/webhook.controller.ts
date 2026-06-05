import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { Response } from 'express';
import { LoggerService } from 'src/core/logger/logger.service';
import { BillingCronService } from './services/billing-cron/billing-cron.service';
import { WebhookBodyDto } from './dto/webhook-body';
import { WompiService } from 'src/modules/payment-receipt/wompi/wompi.service';
import { WompiEventDto } from 'src/modules/payment-receipt/wompi/wompi-event.dto';
import { MetaWebhookNormalizerService, MetaWebhookPayload } from './services/meta-webhook-normalizer/meta-webhook-normalizer.service';

@Controller('webhook')
export class WebhookController {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly logger: LoggerService,
    private readonly billingCronService: BillingCronService,
    private readonly wompiService: WompiService,
    private readonly metaNormalizer: MetaWebhookNormalizerService,
  ) {}

  @Post()
  recibirWebhook(@Body() payload: WebhookBodyDto, @Res() res: Response) {
    void this.logger.log(
      `Webhook recibido: ${JSON.stringify(payload).slice(0, 500)}`,
    );
    // 1. Responde inmediatamente al remitente del webhook.
    // Esto libera su conexión rápidamente, evitando timeouts y reintentos.
    res.status(200).send('Webhook recibido, procesando en segundo plano');

    // 2. Inicia el proceso pesado sin esperar el 'await'.
    // Aquí usamos .then().catch() o simplemente dejamos la promesa "flotando".
    void this.webhookService.processWebhook(payload).catch((error: unknown) => {
      void this.logger.error(
        `Error asíncrono en el webhook: ${JSON.stringify(error)}`,
      );
      // No se puede enviar error 500 al remitente, la respuesta ya fue enviada.
    });
    // El hilo de ejecución se libera aquí.
  }

  /**
   * Webhook de Wompi — recibe eventos de transacciones.
   * Responde 200 inmediatamente y procesa en segundo plano.
   */
  @Post('wompi')
  wompiWebhook(@Body() event: WompiEventDto, @Res() res: Response) {
    res.status(200).send();
    void this.wompiService.process(event).catch((error: unknown) => {
      void this.logger.error(
        `[Wompi] Error asíncrono: ${JSON.stringify(error)}`,
      );
    });
  }

  /** Meta Cloud API — verificación del webhook (GET) */
  @Get('meta')
  verifyMetaWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.challenge') challenge: string,
    @Query('hub.verify_token') verifyToken: string,
    @Res() res: Response,
  ) {
    const expected = (process.env.META_VERIFY_TOKEN ?? '').trim();
    if (mode === 'subscribe' && verifyToken && verifyToken === expected) {
      void this.logger.log(`[Meta] Webhook verificado correctamente`);
      res.status(200).send(challenge);
    } else {
      void this.logger.warn(`[Meta] Verificación fallida — token: ${verifyToken}`);
      res.status(403).send('Forbidden');
    }
  }

  /** Meta Cloud API — recepción de mensajes (POST) */
  @Post('meta')
  receiveMetaWebhook(@Body() payload: MetaWebhookPayload, @Res() res: Response) {
    res.status(200).send('EVENT_RECEIVED');
    void this.metaNormalizer.normalize(payload).then((dtos) => {
      for (const dto of dtos) {
        void this.webhookService.processWebhook(dto).catch((error: unknown) => {
          void this.logger.error(`[Meta] Error procesando mensaje: ${JSON.stringify(error)}`);
        });
      }
    }).catch((error: unknown) => {
      void this.logger.error(`[Meta] Error normalizando payload: ${JSON.stringify(error)}`);
    });
  }

  @Post('billing/process')
  async processBillingCron(
    @Body() body: { force?: boolean } | undefined,
    @Headers('x-runner-key') runnerKey?: string,
  ) {
    const expectedKey =
      (process.env.BILLING_CRON_RUNNER_KEY ?? '').trim() ||
      (process.env.FOLLOW_UP_RUNNER_KEY ?? '').trim();

    if (!expectedKey || runnerKey !== expectedKey) {
      throw new UnauthorizedException('runner key invalida');
    }

    return this.billingCronService.execute({
      source: 'manual',
      force: body?.force !== false,
    });
  }
}
