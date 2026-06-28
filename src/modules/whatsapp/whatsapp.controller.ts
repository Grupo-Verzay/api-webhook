import { Controller, Get, Post, Delete, Body, Param, Query, Headers, UnauthorizedException, NotFoundException, BadRequestException, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import * as QRCode from 'qrcode';
import { BaileysSessionManager } from './adapters/baileys/baileys-session.manager';
import { BaileysMessageStore } from './adapters/baileys/baileys-message.store';
import { BaileysSenderAdapter } from './adapters/baileys/baileys-sender.adapter';
import { MediaStorageService } from './adapters/baileys/media-storage.service';
import { WhatsAppSenderFactory } from './whatsapp-sender.factory';
import { MetaCloudApiSenderAdapter } from './adapters/meta-cloud-api.adapter';
import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';

@Controller('whatsapp/baileys')
export class WhatsAppController {
  constructor(
    private readonly sessions: BaileysSessionManager,
    private readonly messageStore: BaileysMessageStore,
    private readonly sender: BaileysSenderAdapter,
    private readonly mediaStorage: MediaStorageService,
    private readonly senderFactory: WhatsAppSenderFactory,
    private readonly metaAdapter: MetaCloudApiSenderAdapter,
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

  /** POST /whatsapp/baileys/send-media/:instanceName
   *  Envía imagen, video, documento o audio desde la UI del chat. */
  @Post('send-media/:instanceName')
  async sendMedia(
    @Param('instanceName') instanceName: string,
    @Body() body: {
      remoteJid: string;
      mediatype: string;
      mediaUrl: string;
      mimetype?: string;
      fileName?: string;
      caption?: string;
      ptt?: boolean;
    },
    @Headers() headers: Record<string, string>,
  ) {
    this.authorize(headers);
    if (!body?.remoteJid || !body?.mediaUrl) throw new BadRequestException('remoteJid y mediaUrl son requeridos.');

    // Para audio PTT: enviar base64 directo (sin subir a MinIO)
    if (body.ptt) {
      const base64Pure = body.mediaUrl.includes(',') ? body.mediaUrl.split(',')[1] : body.mediaUrl;
      const ok = await this.sender.sendAudioBase64(instanceName, body.remoteJid, base64Pure);
      if (!ok) throw new BadRequestException(`Sin sesión activa para "${instanceName}".`);
      return { ok: true };
    }

    // Para otros tipos: subir a MinIO y enviar URL pública
    const dataUrl = body.mediaUrl;
    const commaIdx = dataUrl.indexOf(',');
    const base64Pure = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
    const mimeFromDataUrl = commaIdx >= 0 ? dataUrl.slice(5, dataUrl.indexOf(';')) : '';
    const mimetype = body.mimetype || mimeFromDataUrl || 'application/octet-stream';

    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
      'video/mp4': 'mp4', 'video/quicktime': 'mov',
      'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
      'application/pdf': 'pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    };
    const fileNameExt = body.fileName?.includes('.') ? body.fileName.split('.').pop()!.toLowerCase() : '';
    const ext = fileNameExt || extMap[mimetype] || mimetype.split('/')[1] || 'bin';

    const buffer = Buffer.from(base64Pure, 'base64');
    const key = `baileys-ui/${instanceName}/${body.remoteJid.replace(/[@:]/g, '_')}/${Date.now()}.${ext}`;
    const publicUrl = await this.mediaStorage.uploadBuffer(buffer, key, mimetype);

    const ok = await this.sender.sendMedia(instanceName, body.remoteJid, body.mediatype, body.caption ?? '', publicUrl, body.fileName);
    if (!ok) throw new BadRequestException(`Sin sesión activa para "${instanceName}".`);
    return { ok: true };
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

  /** POST /whatsapp/baileys/send-channel/:instanceName
   *  Envío manual genérico para canales no-Evolution (Telegram, Meta).
   *  Resuelve credenciales por instancia y usa el adapter correspondiente. */
  @Post('send-channel/:instanceName')
  async sendChannel(
    @Param('instanceName') instanceName: string,
    @Body() body: { remoteJid: string; text: string },
    @Headers() headers: Record<string, string>,
  ) {
    this.authorize(headers);
    if (!body?.remoteJid || !body?.text) throw new BadRequestException('remoteJid y text son requeridos.');

    const instance = await this.prisma.instancia.findFirst({
      where: { instanceName },
      select: {
        instanceType: true,
        metaAccessToken: true,
        metaPhoneNumberId: true,
        metaPageId: true,
      },
    });
    if (!instance) throw new NotFoundException(`Instancia "${instanceName}" no encontrada.`);

    const apikey = instance.metaAccessToken ?? undefined;

    // Meta: usa el resultado detallado para distinguir el caso "fuera de ventana de 24h".
    // En Facebook/Instagram envía como agente humano (HUMAN_AGENT → ventana de 7 días).
    if (instance.instanceType === 'meta') {
      const serverUrl = instance.metaPhoneNumberId ?? instance.metaPageId ?? undefined;
      const res = await this.metaAdapter.sendTextDetailed(
        instanceName,
        body.remoteJid,
        body.text,
        serverUrl,
        apikey,
        { humanAgent: true },
      );
      if (!res.ok) {
        const msg = res.outsideWindow
          ? 'Fuera de la ventana de 24h de Meta: el cliente debe escribir primero (o usar una plantilla aprobada en WhatsApp).'
          : (res.error ?? `No se pudo enviar el mensaje para "${instanceName}".`);
        throw new BadRequestException(msg);
      }
      return { ok: true };
    }

    // Telegram (y otros canales del factory)
    const serverUrl = instance.instanceType === 'telegram' ? 'telegram' : undefined;
    const sender = this.senderFactory.getSenderSync(instance.instanceType);
    const ok = await sender.sendText(instanceName, body.remoteJid, body.text, serverUrl, apikey);
    if (!ok) throw new BadRequestException(`No se pudo enviar el mensaje para "${instanceName}".`);
    return { ok: true };
  }

  /** POST /whatsapp/baileys/send-media-channel/:instanceName
   *  Envío manual de multimedia para canales no-Evolution (Telegram, Meta).
   *  Sube el archivo a almacenamiento y lo envía por el adaptador del canal.
   *  Devuelve la URL pública para que el frontend la persista y la muestre. */
  @Post('send-media-channel/:instanceName')
  async sendMediaChannel(
    @Param('instanceName') instanceName: string,
    @Body() body: {
      remoteJid: string;
      mediatype: string;
      mediaUrl: string;
      mimetype?: string;
      fileName?: string;
      caption?: string;
      ptt?: boolean;
    },
    @Headers() headers: Record<string, string>,
  ) {
    this.authorize(headers);
    if (!body?.remoteJid || !body?.mediaUrl) throw new BadRequestException('remoteJid y mediaUrl son requeridos.');

    const instance = await this.prisma.instancia.findFirst({
      where: { instanceName },
      select: { instanceType: true, metaAccessToken: true, metaPhoneNumberId: true, metaPageId: true },
    });
    if (!instance) throw new NotFoundException(`Instancia "${instanceName}" no encontrada.`);

    // Subir el archivo (data URL/base64) a almacenamiento y obtener URL pública.
    const dataUrl = body.mediaUrl;
    const commaIdx = dataUrl.indexOf(',');
    const base64Pure = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
    const mimeFromDataUrl = commaIdx >= 0 ? dataUrl.slice(5, dataUrl.indexOf(';')) : '';
    const mimetype = body.mimetype || mimeFromDataUrl || 'application/octet-stream';

    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
      'video/mp4': 'mp4', 'video/quicktime': 'mov',
      'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
      'application/pdf': 'pdf',
    };
    const fileNameExt = body.fileName?.includes('.') ? body.fileName.split('.').pop()!.toLowerCase() : '';
    const ext = fileNameExt || extMap[mimetype] || mimetype.split('/')[1] || 'bin';

    const buffer = Buffer.from(base64Pure, 'base64');
    const key = `channel-ui/${instanceName}/${body.remoteJid.replace(/[@:]/g, '_')}/${Date.now()}.${ext}`;
    const publicUrl = await this.mediaStorage.uploadBuffer(buffer, key, mimetype);

    // Credenciales por canal
    const apikey = instance.metaAccessToken ?? undefined;
    const channelServerUrl =
      instance.instanceType === 'telegram'
        ? 'telegram'
        : instance.instanceType === 'meta'
          ? (instance.metaPhoneNumberId ?? instance.metaPageId ?? undefined)
          : undefined;

    const sender = this.senderFactory.getSenderSync(instance.instanceType);
    const isAudio = body.ptt || body.mediatype === 'audio';
    const ok = isAudio
      ? await sender.sendAudio(instanceName, body.remoteJid, publicUrl, channelServerUrl, apikey)
      : await sender.sendMedia(instanceName, body.remoteJid, body.mediatype, body.caption ?? '', publicUrl, channelServerUrl, apikey);

    if (!ok) throw new BadRequestException(`No se pudo enviar el archivo para "${instanceName}".`);
    return { ok: true, mediaUrl: publicUrl };
  }

  /** GET /whatsapp/baileys/meta-templates/:instanceName
   *  Lista las plantillas APROBADAS de la WABA de una instancia Meta. */
  @Get('meta-templates/:instanceName')
  async listMetaTemplates(
    @Param('instanceName') instanceName: string,
    @Headers() headers: Record<string, string>,
  ) {
    this.authorize(headers);
    const instance = await this.prisma.instancia.findFirst({
      where: { instanceName, instanceType: 'meta' },
      select: { metaWabaId: true, metaAccessToken: true },
    });
    if (!instance?.metaWabaId || !instance.metaAccessToken) {
      return { templates: [] };
    }
    const templates = await this.metaAdapter.listApprovedTemplates(
      instance.metaWabaId,
      instance.metaAccessToken,
    );
    return { templates };
  }

  /** POST /whatsapp/baileys/send-template/:instanceName
   *  Envía un mensaje de plantilla de WhatsApp Cloud (válido fuera de 24h). */
  @Post('send-template/:instanceName')
  async sendMetaTemplate(
    @Param('instanceName') instanceName: string,
    @Body() body: { remoteJid: string; name: string; language: string; params?: string[] },
    @Headers() headers: Record<string, string>,
  ) {
    this.authorize(headers);
    if (!body?.remoteJid || !body?.name || !body?.language) {
      throw new BadRequestException('remoteJid, name e language son requeridos.');
    }
    const instance = await this.prisma.instancia.findFirst({
      where: { instanceName, instanceType: 'meta' },
      select: { metaPhoneNumberId: true, metaAccessToken: true },
    });
    if (!instance?.metaPhoneNumberId || !instance.metaAccessToken) {
      throw new NotFoundException(`Instancia WhatsApp Cloud "${instanceName}" no encontrada.`);
    }

    const res = await this.metaAdapter.sendTemplate(
      instance.metaPhoneNumberId,
      instance.metaAccessToken,
      body.remoteJid,
      body.name,
      body.language,
      body.params ?? [],
    );
    if (!res.ok) {
      throw new BadRequestException(res.error ?? `No se pudo enviar la plantilla para "${instanceName}".`);
    }
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
    const ownPhone = this.sessions.getUserInfo(instanceName)?.phone ?? undefined;
    const chats = await this.messageStore.getChats(instanceName, ownPhone);
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
