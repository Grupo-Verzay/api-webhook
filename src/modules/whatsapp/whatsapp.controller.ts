import { Controller, Get, Post, Delete, Param, Headers, UnauthorizedException, NotFoundException, BadRequestException, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import * as QRCode from 'qrcode';
import { BaileysSessionManager } from './adapters/baileys/baileys-session.manager';
import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';

@Controller('whatsapp/baileys')
export class WhatsAppController {
  constructor(
    private readonly sessions: BaileysSessionManager,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  private authorize(headers: Record<string, string>) {
    const key = (this.config.get<string>('CRM_FOLLOW_UP_RUNNER_KEY') ?? '').trim();
    const provided = (headers['x-internal-secret'] ?? headers['authorization']?.replace('Bearer ', '') ?? '').trim();
    if (!key || provided !== key) throw new UnauthorizedException();
  }

  /** GET /whatsapp/baileys/qr/:instanceName
   *  Devuelve la imagen QR como PNG para escanear con WhatsApp. */
  @Get('qr/:instanceName')
  async getQr(
    @Param('instanceName') instanceName: string,
    @Headers() headers: Record<string, string>,
    @Res() res: Response,
  ) {
    this.authorize(headers);

    if (this.sessions.isConnected(instanceName)) {
      return res.status(200).json({ status: 'connected', message: 'La instancia ya está conectada.' });
    }

    const qr = this.sessions.getQr(instanceName);
    if (!qr) {
      return res.status(202).json({ status: 'waiting', message: 'QR aún no disponible. Intenta en unos segundos.' });
    }

    const png = await QRCode.toBuffer(qr, { type: 'png', width: 400 });
    res.setHeader('Content-Type', 'image/png');
    return res.send(png);
  }

  /** GET /whatsapp/baileys/status/:instanceName
   *  Devuelve el estado de conexión de la instancia. */
  @Get('status/:instanceName')
  async getStatus(
    @Param('instanceName') instanceName: string,
    @Headers() headers: Record<string, string>,
  ) {
    this.authorize(headers);
    return {
      instanceName,
      connected: this.sessions.isConnected(instanceName),
      hasQr: !!this.sessions.getQr(instanceName),
    };
  }

  /** POST /whatsapp/baileys/start/:instanceName
   *  Inicia o reinicia una sesión Baileys para la instancia. */
  @Post('start/:instanceName')
  async startSession(
    @Param('instanceName') instanceName: string,
    @Headers() headers: Record<string, string>,
  ) {
    this.authorize(headers);

    const instance = await this.prisma.instancia.findFirst({
      where: { instanceName },
      select: { instanceType: true },
    });

    if (!instance) throw new NotFoundException(`Instancia "${instanceName}" no encontrada.`);
    if (instance.instanceType !== 'baileys') {
      throw new BadRequestException(`La instancia "${instanceName}" no es de tipo Baileys. Cambia instanceType a 'baileys' en la BD primero.`);
    }

    await this.sessions.startSession(instanceName);
    this.logger.log(`[Baileys] Sesión iniciada manualmente: ${instanceName}`, 'WhatsAppController');

    return { message: `Sesión iniciada para "${instanceName}". Llama a /qr/${instanceName} en unos segundos para obtener el QR.` };
  }

  /** DELETE /whatsapp/baileys/stop/:instanceName
   *  Desconecta y cierra una sesión Baileys. */
  @Delete('stop/:instanceName')
  async stopSession(
    @Param('instanceName') instanceName: string,
    @Headers() headers: Record<string, string>,
  ) {
    this.authorize(headers);
    await this.sessions.stopSession(instanceName);
    this.logger.log(`[Baileys] Sesión detenida manualmente: ${instanceName}`, 'WhatsAppController');
    return { message: `Sesión "${instanceName}" detenida.` };
  }
}
