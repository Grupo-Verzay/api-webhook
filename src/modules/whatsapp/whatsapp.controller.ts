import { Controller, Get, Post, Delete, Body, Param, Query, Headers, UnauthorizedException, NotFoundException, BadRequestException, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import * as QRCode from 'qrcode';
import { BaileysSessionManager } from './adapters/baileys/baileys-session.manager';
import { BaileysMessageStore } from './adapters/baileys/baileys-message.store';
import { BaileysSenderAdapter } from './adapters/baileys/baileys-sender.adapter';
import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';

@Controller('whatsapp/baileys')
export class WhatsAppController {
  constructor(
    private readonly sessions: BaileysSessionManager,
    private readonly messageStore: BaileysMessageStore,
    private readonly sender: BaileysSenderAdapter,
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
    const info = this.sessions.getUserInfo(instanceName);
    return {
      instanceName,
      connected: this.sessions.isConnected(instanceName),
      hasQr: !!this.sessions.getQr(instanceName),
      profileName: info?.name ?? null,
      phoneNumber: info?.phone ?? null,
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

  /** POST /whatsapp/baileys/send/:instanceName
   *  Envía un mensaje de texto desde la UI del chat. */
  @Post('send/:instanceName')
  async sendMessage(
    @Param('instanceName') instanceName: string,
    @Body() body: { remoteJid: string; text: string },
    @Headers() headers: Record<string, string>,
  ) {
    this.authorize(headers);
    if (!body?.remoteJid || !body?.text) throw new BadRequestException('remoteJid y text son requeridos.');
    const ok = await this.sender.sendText(instanceName, body.remoteJid, body.text);
    if (!ok) throw new BadRequestException(`Sin sesión activa para "${instanceName}".`);
    return { ok: true };
  }

  /** GET /whatsapp/baileys/chats/:instanceName
   *  Lista de chats (contactos con último mensaje) almacenados para la instancia. */
  @Get('chats/:instanceName')
  async getChats(
    @Param('instanceName') instanceName: string,
    @Headers() headers: Record<string, string>,
  ) {
    this.authorize(headers);
    const chats = await this.messageStore.getChats(instanceName);
    return { instanceName, chats };
  }

  /** GET /whatsapp/baileys/messages/:instanceName/:remoteJid?limit=50&before=ISO_DATE
   *  Mensajes de una conversación, paginados hacia atrás. */
  @Get('messages/:instanceName/:remoteJid')
  async getMessages(
    @Param('instanceName') instanceName: string,
    @Param('remoteJid') remoteJid: string,
    @Query('limit') limit: string,
    @Query('before') before: string,
    @Headers() headers: Record<string, string>,
  ) {
    this.authorize(headers);
    const parsedLimit = Math.min(Number(limit) || 50, 200);
    const beforeDate = before ? new Date(before) : undefined;
    const messages = await this.messageStore.getMessages(instanceName, remoteJid, parsedLimit, beforeDate);
    return { instanceName, remoteJid, messages };
  }

  /** GET /whatsapp/baileys/qr-page/:instanceName?secret=KEY
   *  Página HTML con el QR que se refresca cada 10 segundos. */
  @Get('qr-page/:instanceName')
  async getQrPage(
    @Param('instanceName') instanceName: string,
    @Query('secret') secret: string,
    @Res() res: Response,
  ) {
    const key = (this.config.get<string>('CRM_FOLLOW_UP_RUNNER_KEY') ?? '').trim();
    if (!key || (secret ?? '').trim() !== key) throw new UnauthorizedException();

    const connected = this.sessions.isConnected(instanceName);
    const qr = this.sessions.getQr(instanceName);

    let body: string;
    if (connected) {
      body = `<h2 style="color:green">✅ ${instanceName} está conectado a WhatsApp</h2>`;
    } else if (qr) {
      const png = await QRCode.toDataURL(qr, { width: 400 });
      body = `
        <h2>Escanea con WhatsApp — se renueva automáticamente</h2>
        <img src="${png}" style="display:block;margin:20px auto;border:4px solid #000;border-radius:8px" />
        <p style="text-align:center;color:#666">Instancia: <b>${instanceName}</b></p>
      `;
    } else {
      body = `<h2 style="color:orange">⏳ Generando QR para ${instanceName}... espera unos segundos</h2>`;
    }

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta http-equiv="refresh" content="8">
      <title>QR Baileys — ${instanceName}</title>
      <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5}</style>
    </head><body>${body}</body></html>`;

    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  }
}
