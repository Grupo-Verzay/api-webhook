import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as fs from 'fs';
import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';

type WASocket = any;
type ConnectionState = { connection: string; lastDisconnect?: { error?: any } };

function makeBaileysLogger() {
  const noop = () => {};
  const child = () => makeBaileysLogger();
  return { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child };
}

@Injectable()
export class BaileysSessionManager implements OnModuleInit, OnModuleDestroy {
  private sockets = new Map<string, WASocket>();
  private qrCodes = new Map<string, string>();
  private readonly sessionsDir: string;

  constructor(
    private readonly logger: LoggerService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.sessionsDir = this.config.get<string>('BAILEYS_SESSIONS_DIR') ?? path.join(process.cwd(), 'baileys-sessions');
  }

  async onModuleInit() {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }

    const instances = await this.prisma.instancia.findMany({
      where: { instanceType: 'baileys' },
      select: { instanceName: true },
    });

    for (const { instanceName } of instances) {
      this.startSession(instanceName).catch((err) =>
        this.logger.error(`[Baileys] Error iniciando sesión ${instanceName}`, err?.message, 'BaileysSessionManager'),
      );
    }

    if (instances.length > 0) {
      this.logger.log(`[Baileys] ${instances.length} sesión(es) iniciada(s) al arrancar.`, 'BaileysSessionManager');
    }
  }

  onModuleDestroy() {
    for (const [name, socket] of this.sockets.entries()) {
      try { socket.end(); } catch {}
      this.logger.log(`[Baileys] Sesión cerrada: ${name}`, 'BaileysSessionManager');
    }
    this.sockets.clear();
  }

  async startSession(instanceName: string): Promise<void> {
    if (this.sockets.has(instanceName)) return;

    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } =
      await import('@whiskeysockets/baileys');

    const sessionDir = path.join(this.sessionsDir, instanceName);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const socket: WASocket = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: makeBaileysLogger(),
      browser: ['Verzay-IA', 'Chrome', '1.0.0'],
    });

    this.sockets.set(instanceName, socket);

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update: ConnectionState) => {
      const { connection, lastDisconnect } = update;

      if ((update as any).qr) {
        const qrString: string = (update as any).qr;
        this.qrCodes.set(instanceName, qrString);
        this.logger.log(`[Baileys] QR generado para ${instanceName} — escanea con WhatsApp:`, 'BaileysSessionManager');
        try {
          const QRCode = await import('qrcode');
          const ascii = await QRCode.default.toString(qrString, { type: 'terminal', small: true });
          process.stdout.write(ascii + '\n');
        } catch {}
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
        this.logger.warn(`[Baileys] Conexión cerrada para ${instanceName}. Reconectar: ${shouldReconnect}`, 'BaileysSessionManager');
        this.sockets.delete(instanceName);
        if (shouldReconnect) {
          setTimeout(() => this.startSession(instanceName), 5000);
        }
      }

      if (connection === 'open') {
        this.qrCodes.delete(instanceName);
        this.logger.log(`[Baileys] Conectado: ${instanceName}`, 'BaileysSessionManager');
      }
    });
  }

  async stopSession(instanceName: string): Promise<void> {
    const socket = this.sockets.get(instanceName);
    if (socket) {
      try { socket.end(); } catch {}
      this.sockets.delete(instanceName);
    }
  }

  getSocket(instanceName: string): WASocket | null {
    return this.sockets.get(instanceName) ?? null;
  }

  getQr(instanceName: string): string | null {
    return this.qrCodes.get(instanceName) ?? null;
  }

  isConnected(instanceName: string): boolean {
    return this.sockets.has(instanceName);
  }
}
