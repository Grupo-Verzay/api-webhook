import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as fs from 'fs';
import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { BaileysMessageStore, extractMessageBody } from './baileys-message.store';

type WASocket = any;
type ConnectionState = { connection: string; lastDisconnect?: { error?: any } };

function makeBaileysLogger() {
  const noop = () => {};
  const child = () => makeBaileysLogger();
  return { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child };
}

type IncomingMessageHandler = (instanceName: string, msg: any) => void;

interface UserInfo { name: string; phone: string; }

@Injectable()
export class BaileysSessionManager implements OnModuleInit, OnModuleDestroy {
  private sockets = new Map<string, WASocket>();
  private qrCodes = new Map<string, string>();
  private authenticated = new Set<string>();
  private userInfoMap = new Map<string, UserInfo>();
  private messageHandler: IncomingMessageHandler | null = null;
  private readonly sessionsDir: string;

  constructor(
    private readonly logger: LoggerService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly messageStore: BaileysMessageStore,
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
        this.authenticated.delete(instanceName);
        if (shouldReconnect) {
          setTimeout(() => this.startSession(instanceName), 5000);
        } else {
          // loggedOut: borrar credenciales para que la próxima llamada a startSession genere QR nuevo
          const sessionDir = path.join(this.sessionsDir, instanceName);
          if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            this.logger.log(`[Baileys] Credenciales borradas para ${instanceName} — próxima reconexión pedirá QR nuevo.`, 'BaileysSessionManager');
          }
        }
      }

      if (connection === 'open') {
        this.qrCodes.delete(instanceName);
        this.authenticated.add(instanceName);
        const user = socket.user;
        if (user) {
          const jid: string = user.id ?? '';
          const phone = jid.split(':')[0].split('@')[0];
          this.userInfoMap.set(instanceName, { name: user.name ?? instanceName, phone });
        }
        this.logger.log(`[Baileys] Conectado: ${instanceName}`, 'BaileysSessionManager');
      }
    });

    socket.ev.on('messages.upsert', ({ messages, type }: { messages: any[]; type: string }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg?.key?.remoteJid) continue;
        this.persistMessage(instanceName, msg);
        this.messageHandler?.(instanceName, msg);
      }
    });

    socket.ev.on('messaging-history.set', ({ messages, contacts, lidPnMappings }: { messages: any[]; contacts: any[]; isLatest: boolean; lidPnMappings?: Array<{ pn: string; lid: string }> }) => {
      this.persistHistory(instanceName, messages, contacts, lidPnMappings).catch(() => {});
    });

    socket.ev.on('lid-mapping.update', (mapping: { pn: string; lid: string }) => {
      if (mapping?.pn && mapping?.lid) {
        const phoneDigits = mapping.pn.replace(/\D/g, '');
        if (phoneDigits) {
          this.messageStore.updateContactPhone(instanceName, mapping.lid, phoneDigits).catch(() => {});
        }
      }
    });

    socket.ev.on('contacts.upsert', (contacts: any[]) => {
      this.persistContacts(instanceName, contacts).catch(() => {});
    });

    socket.ev.on('contacts.update', (contacts: any[]) => {
      this.persistContacts(instanceName, contacts).catch(() => {});
    });
  }

  registerMessageHandler(handler: IncomingMessageHandler): void {
    this.messageHandler = handler;
  }

  async stopSession(instanceName: string): Promise<void> {
    const socket = this.sockets.get(instanceName);
    if (socket) {
      try { socket.end(); } catch {}
      this.sockets.delete(instanceName);
      this.authenticated.delete(instanceName);
      this.userInfoMap.delete(instanceName);
    }
  }

  getUserInfo(instanceName: string): UserInfo | null {
    return this.userInfoMap.get(instanceName) ?? null;
  }

  getSocket(instanceName: string): WASocket | null {
    return this.sockets.get(instanceName) ?? null;
  }

  getQr(instanceName: string): string | null {
    return this.qrCodes.get(instanceName) ?? null;
  }

  isConnected(instanceName: string): boolean {
    return this.authenticated.has(instanceName);
  }

  private persistMessage(instanceName: string, msg: any): void {
    const key = msg.key ?? {};
    const remoteJid: string = key.remoteJid ?? '';
    if (!remoteJid || remoteJid.endsWith('@broadcast')) return;

    // Ignorar mensajes cuyo remoteJid es el propio número del bot (Notas/Saved Messages)
    const ownInfo = this.userInfoMap.get(instanceName);
    if (ownInfo?.phone && remoteJid === `${ownInfo.phone}@s.whatsapp.net`) return;

    const message = msg.message ?? {};
    const { body, type } = extractMessageBody(message);
    const tsSeconds: number = msg.messageTimestamp ?? Math.floor(Date.now() / 1000);
    const timestamp = new Date(tsSeconds * 1000);

    // Resolver número real: senderPn → key.remoteJidAlt (resuelto por Baileys desde auth state)
    let phoneNumber: string | null = null;
    const rawPn: string = msg.senderPn ?? key.senderPn ?? '';
    if (rawPn) {
      phoneNumber = rawPn.replace(/\D/g, '') || null;
    } else if (remoteJid.toLowerCase().endsWith('@lid')) {
      const alt: string = key.remoteJidAlt ?? '';
      if (alt && !alt.toLowerCase().endsWith('@lid') && alt.includes('@')) {
        phoneNumber = alt.replace(/@[^@]*$/, '').replace(/\D/g, '') || null;
      }
    }

    this.logger.log(
      `[Baileys] msg fromMe=${key.fromMe} type=${type} body="${(body ?? '').substring(0, 40)}" remoteJid=${remoteJid}`,
      'BaileysSessionManager',
    );

    this.messageStore.saveMessage({
      instanceName,
      remoteJid,
      messageId: key.id ?? '',
      fromMe: key.fromMe ?? false,
      body,
      type,
      timestamp,
      pushName: msg.pushName ?? null,
      phoneNumber,
    }).catch(() => {});
  }

  private async persistContacts(instanceName: string, contacts: any[]): Promise<void> {
    for (const c of contacts ?? []) {
      if (!c?.id) continue;
      const lidJid: string | null = c.id.toLowerCase().endsWith('@lid')
        ? c.id
        : c.lid ?? null;
      // phoneNumber in Contact type is the @s.whatsapp.net JID
      const pnRaw: string = c.senderPn ?? c.phoneNumber ?? '';
      const phoneDigits = pnRaw.replace(/\D/g, '');
      if (lidJid && phoneDigits) {
        await this.messageStore.updateContactPhone(instanceName, lidJid, phoneDigits, c.notify ?? c.name ?? null).catch(() => {});
      }
    }
  }

  private async persistHistory(instanceName: string, messages: any[], contacts: any[], lidPnMappings?: Array<{ pn: string; lid: string }>): Promise<void> {
    const contactMap = new Map<string, string>();
    const contactPnMap = new Map<string, string>();

    // Process explicit LID→PN mappings first (most reliable)
    for (const m of lidPnMappings ?? []) {
      if (m?.pn && m?.lid) {
        const phoneDigits = m.pn.replace(/\D/g, '');
        if (phoneDigits) {
          contactPnMap.set(m.lid, phoneDigits);
          await this.messageStore.updateContactPhone(instanceName, m.lid, phoneDigits).catch(() => {});
        }
      }
    }

    for (const c of contacts ?? []) {
      if (c?.id) {
        const displayName = c.notify ?? c.name ?? '';
        contactMap.set(c.id, displayName);
        const pn = c.senderPn ?? c.phoneNumber ?? '';
        const phoneDigits = pn.replace(/\D/g, '');
        if (phoneDigits) contactPnMap.set(c.id, phoneDigits);

        // Cross-index: id=@s.whatsapp.net + lid=@lid → index by lid too
        if (c.lid && c.lid !== c.id) {
          if (!contactMap.has(c.lid)) contactMap.set(c.lid, displayName);
          if (phoneDigits && !contactPnMap.has(c.lid)) contactPnMap.set(c.lid, phoneDigits);
          // Persist the LID→phone mapping
          if (phoneDigits) {
            await this.messageStore.updateContactPhone(instanceName, c.lid, phoneDigits, displayName || null).catch(() => {});
          }
        }
        // Cross-index: id=@lid + phoneNumber=@s.whatsapp.net → already captured above
      }
    }

    let saved = 0;
    for (const msg of messages ?? []) {
      const key = msg.key ?? {};
      const remoteJid: string = key.remoteJid ?? '';
      if (!remoteJid || remoteJid.endsWith('@broadcast')) continue;

      const message = msg.message ?? {};
      const { body, type } = extractMessageBody(message);
      const tsSeconds: number = msg.messageTimestamp ?? Math.floor(Date.now() / 1000);
      const timestamp = new Date(tsSeconds * 1000);
      const pushName = contactMap.get(remoteJid) || msg.pushName || null;
      const rawPn = msg.senderPn ?? key.senderPn ?? contactPnMap.get(remoteJid) ?? '';
      const phoneNumber = rawPn ? rawPn.replace(/\D/g, '') : null;

      await this.messageStore.saveMessage({
        instanceName,
        remoteJid,
        messageId: key.id ?? '',
        fromMe: key.fromMe ?? false,
        body,
        type,
        timestamp,
        pushName,
        phoneNumber,
      });
      saved++;
    }

    if (saved > 0) {
      this.logger.log(`[Baileys] Historial inicial: ${saved} mensajes guardados para ${instanceName}`, 'BaileysSessionManager');
    }
  }
}
