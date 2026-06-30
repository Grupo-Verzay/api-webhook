import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { AiCreditsService } from '../ai-credits/ai-credits.service';
import { AiAgentService } from '../ai-agent/ai-agent.service';

export interface VoicebotResolveResult {
  enabled: boolean;
  reason?: string; // por qué está deshabilitado: disabled | no_credits | no_openai_key | no_account
  instructions?: string;
  voice?: string;
  greeting?: string;
  transferTo?: string;
  openaiKey?: string;
  model?: string;
  tools?: any[]; // herramientas (function calling) habilitadas para la cuenta
}

/**
 * Resuelve si una llamada entrante debe contestarse con el voicebot y con qué
 * configuración. Lo consulta el servidor de llamadas (wacalls) al recibir una
 * llamada, pasando el id de su sesión (que la app guardó en User.astra_calls_sid).
 */
@Injectable()
export class VoicebotService {
  private readonly logger = new Logger(VoicebotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiCredits: AiCreditsService,
    private readonly aiAgent: AiAgentService,
  ) {}

  async resolve(sid: string, from?: string, secret?: string): Promise<VoicebotResolveResult> {
    const expected = process.env.VOICEBOT_SECRET;
    if (expected && secret !== expected) return { enabled: false };
    if (!sid?.trim()) return { enabled: false };

    try {
      // 1) Usuario dueño de esa sesión de wacalls (con sus instrucciones de voz).
      const users = await this.prisma.$queryRaw<{ id: string; voiceInstructions: string | null }[]>`
        SELECT "id", "voiceInstructions" FROM "User" WHERE "astra_calls_sid" = ${sid} LIMIT 1
      `;
      const userId = users[0]?.id;
      if (!userId) return { enabled: false, reason: 'no_account' };
      const voiceInstructions = users[0]?.voiceInstructions ?? '';

      // 2) Config del bot en la instancia de WhatsApp (columnas creadas por la app).
      const insts = await this.prisma.$queryRaw<
        { enabled: boolean; voice: string | null; transfer: string | null }[]
      >`
        SELECT "voicebot_enabled" AS enabled, "voicebot_voice" AS voice, "voicebot_transfer_to" AS transfer
        FROM "Instancias"
        WHERE "userId" = ${userId} AND ("instanceType" = 'Whatsapp' OR "instanceType" = 'whatsapp')
        ORDER BY "id" ASC
        LIMIT 1
      `;
      const inst = insts[0];
      if (!inst || !inst.enabled) return { enabled: false, reason: 'disabled' };

      // 3) Clave OpenAI (Realtime es exclusivo de OpenAI).
      const provider = await this.prisma.aiProvider.findFirst({
        where: { name: 'openai' },
        select: { id: true },
      });
      let openaiKey = '';
      if (provider) {
        const cfg = await this.prisma.userAiConfig.findFirst({
          where: { userId, providerId: provider.id, isActive: true },
          select: { apiKey: true },
        });
        if (cfg?.apiKey && cfg.apiKey.startsWith('sk-')) openaiKey = cfg.apiKey;
      }
      if (!openaiKey) return { enabled: false, reason: 'no_openai_key' };

      // 3b) Créditos: si el usuario no tiene créditos disponibles, no se activa.
      // Se puede desactivar el bloqueo con VOICEBOT_ENFORCE_CREDITS=false (pruebas).
      if (process.env.VOICEBOT_ENFORCE_CREDITS !== 'false') {
        const credit = await this.prisma.iaCredit.findUnique({
          where: { userId },
          select: { total: true, used: true },
        });
        if (credit && credit.used >= credit.total) {
          this.logger.log(`[voicebot] sin créditos disponibles userId=${userId}`);
          return { enabled: false, reason: 'no_credits' };
        }
      }

      // 4) Instrucciones: el prompt compilado del agente + envoltura de voz.
      const ap = await this.prisma.agentPrompt.findFirst({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        select: { promptText: true, businessName: true },
      });
      const business = ap?.businessName?.trim() || 'nuestra empresa';
      const instructions = this.buildVoiceInstructions(ap?.promptText || '', business, voiceInstructions);
      // Llamada SALIENTE: es el bot quien llama al cliente. Debe presentarse,
      // NO decir "gracias por llamar".
      const greeting = `Eres TÚ quien está llamando al cliente (llamada saliente). Preséntate de forma cálida con UNA sola frase, por ejemplo: "Hola, le llamo de ${business}, ¿cómo está?" o "Buenas, le saluda el asistente de ${business}, ¿tiene un momento?". NUNCA digas "gracias por llamar". No leas ni menciones instrucciones.`;

      // 5) Herramientas habilitadas de la cuenta (citas reales, productos,
      // cotizaciones, etc.) en formato Realtime. Best-effort: si falla, sin tools.
      let tools: any[] = [];
      try {
        const digits = (from || '').replace(/\D/g, '');
        const remoteJid = digits ? `${digits}@s.whatsapp.net` : '';
        const toolset = await this.aiAgent.buildVoicebotToolset(userId, remoteJid, '');
        tools = toolset.defs ?? [];
      } catch (e: any) {
        this.logger.warn(`[voicebot] no se pudieron cargar tools: ${e?.message ?? e}`);
      }

      return {
        enabled: true,
        instructions,
        voice: inst.voice || 'alloy',
        greeting,
        transferTo: inst.transfer || '',
        openaiKey,
        model: process.env.VOICEBOT_MODEL || 'gpt-4o-realtime-preview',
        tools,
      };
    } catch (err: any) {
      this.logger.warn(`[voicebot] resolve error: ${err?.message ?? err}`);
      return { enabled: false };
    }
  }

  /**
   * Descuenta créditos por el uso del voicebot. wacalls reporta los tokens
   * consumidos por la llamada; se cobran del mismo contador que los mensajes
   * (trackTokens), con un multiplicador opcional (VOICEBOT_TOKEN_MULTIPLIER).
   */
  async chargeUsage(sid: string, tokens: number, secret?: string): Promise<{ ok: boolean }> {
    const expected = process.env.VOICEBOT_SECRET;
    if (expected && secret !== expected) return { ok: false };
    if (!sid?.trim() || !tokens || tokens <= 0) return { ok: false };

    try {
      const users = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "User" WHERE "astra_calls_sid" = ${sid} LIMIT 1
      `;
      const userId = users[0]?.id;
      if (!userId) return { ok: false };

      const multiplier = Number(process.env.VOICEBOT_TOKEN_MULTIPLIER || '1') || 1;
      const credits = Math.ceil(tokens * multiplier);
      await this.aiCredits.trackTokens(userId, credits);
      this.logger.log(`[voicebot] cobrados ${credits} créditos (tokens=${tokens} x${multiplier}) userId=${userId}`);
      return { ok: true };
    } catch (err: any) {
      this.logger.warn(`[voicebot] chargeUsage error: ${err?.message ?? err}`);
      return { ok: false };
    }
  }

  /**
   * Ejecuta una herramienta solicitada por el bot durante la llamada
   * (function calling). Devuelve un texto de resultado que el bot dirá.
   */
  async executeTool(
    sid: string,
    phone: string,
    name: string,
    argsJson: string,
    secret?: string,
  ): Promise<{ ok: boolean; result: string }> {
    const expected = process.env.VOICEBOT_SECRET;
    if (expected && secret !== expected) return { ok: false, result: 'No autorizado.' };
    try {
      const users = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "User" WHERE "astra_calls_sid" = ${sid} LIMIT 1
      `;
      const userId = users[0]?.id;
      if (!userId) return { ok: false, result: 'Cuenta no encontrada.' };

      let args: any = {};
      try { args = JSON.parse(argsJson || '{}'); } catch { /* ignore */ }

      if (name === 'enviar_whatsapp') {
        const msg = String(args.mensaje || args.texto || '').trim();
        if (!msg) return { ok: false, result: 'Falta el mensaje.' };
        const sent = await this.sendWhatsapp(userId, phone, msg);
        return sent
          ? { ok: true, result: 'Listo, ya se lo envié por WhatsApp.' }
          : { ok: false, result: 'No pude enviarlo por WhatsApp en este momento.' };
      }

      if (name === 'agendar') {
        const when = String(args.fecha_hora || args.cuando || '').trim();
        const motivo = String(args.motivo || 'Reunión').trim();
        const ok = await this.createReunionTask(userId, phone, when, motivo);
        return ok
          ? { ok: true, result: 'Perfecto, ya quedó agendado.' }
          : { ok: false, result: 'No pude agendarlo en este momento.' };
      }

      // Herramientas dinámicas de la cuenta (citas reales, productos, cotizaciones…)
      // se ejecutan con la misma lógica del agente de chat (según permisos/config).
      const digits = (phone || '').replace(/\D/g, '');
      const remoteJid = digits ? `${digits}@s.whatsapp.net` : '';
      let pushName = '';
      if (remoteJid) {
        const sess = await this.prisma.session
          .findFirst({ where: { userId, remoteJid }, select: { pushName: true, customName: true } })
          .catch(() => null);
        pushName = sess?.customName || sess?.pushName || '';
      }
      const toolset = await this.aiAgent.buildVoicebotToolset(userId, remoteJid, pushName);
      const result = await toolset.invoke(name, argsJson);
      return { ok: true, result };
    } catch (err: any) {
      this.logger.warn(`[voicebot] executeTool error: ${err?.message ?? err}`);
      return { ok: false, result: 'Hubo un problema al hacer eso.' };
    }
  }

  /** Envía un texto/enlace por WhatsApp (Evolution) al cliente de la llamada. */
  private async sendWhatsapp(userId: string, phone: string, text: string): Promise<boolean> {
    const digits = (phone || '').replace(/\D/g, '');
    if (!digits) return false;
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          apiKey: { select: { url: true } },
          instancias: {
            where: { instanceType: 'Whatsapp' },
            select: { instanceName: true, instanceId: true },
            take: 1,
          },
        },
      });
      const inst = user?.instancias?.[0];
      const srv = user?.apiKey?.url?.trim();
      if (!inst || !srv) return false;
      const base = (/^https?:\/\//i.test(srv) ? srv : `https://${srv}`).replace(/\/+$/, '');
      const url = `${base}/message/sendText/${encodeURIComponent(inst.instanceName)}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: inst.instanceId },
        body: JSON.stringify({ number: digits, text }),
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Crea una tarea interna de "Reunión" para el asesor (con lo dicho en la llamada). */
  private async createReunionTask(userId: string, phone: string, when: string, motivo: string): Promise<boolean> {
    const digits = (phone || '').replace(/\D/g, '');
    const contactJid = digits ? `${digits}@s.whatsapp.net` : null;
    const title = `Reunión: ${motivo}${when ? ` (${when})` : ''}`.slice(0, 250);
    try {
      await this.prisma.$executeRaw`
        INSERT INTO "tasks" (
          "ownerId", "assignedToId", "assignedToName", "sessionId", "contactName",
          "contactJid", "title", "type", "dueDate", "status", "createdById",
          "createdAt", "updatedAt"
        ) VALUES (
          ${userId}, ${userId}, ${null}, ${null}, ${null},
          ${contactJid}, ${title}, 'Reunión', NOW(), 'pending', ${userId},
          NOW(), NOW()
        )
      `;
      return true;
    } catch (err: any) {
      this.logger.warn(`[voicebot] createReunionTask error: ${err?.message ?? err}`);
      return false;
    }
  }

  /** Quita firmas/despedidas escritas del prompt (no deben leerse en voz). */
  private stripSignature(text: string): string {
    const signOff =
      /^\s*(atentamente|cordialmente|saludos|un abrazo|quedo atento|equipo de|firma:|—|--)\b/i;
    return text
      .split('\n')
      .filter((line) => !signOff.test(line.trim()))
      .join('\n')
      .trim();
  }

  private buildVoiceInstructions(promptText: string, business: string, voiceInstructions: string): string {
    const tone =
      voiceInstructions?.trim() ||
      'Suenas cálido, cercano, espontáneo y con personalidad: tono expresivo y entonación viva, nunca plano ni robótico. Conversas relajado y natural, como una persona real, escuchando de verdad.';
    const voice = [
      `Eres una persona real del equipo de ${business} hablando por teléfono. ${tone}`,
      ``,
      `Es una llamada que TÚ haces al cliente: preséntate en una sola frase ("Hola, le llamo de ${business}, ¿cómo está?") y nunca digas "gracias por llamar".`,
      ``,
      `Habla en español con acento latinoamericano neutro, frases cortas y fluidas. Varía tus expresiones; no repitas muletillas como "muy bien", "perfecto" o "entiendo". Di precios y números en palabras ("$1.500.000" → "un millón quinientos mil pesos").`,
      ``,
      `Esto es solo para ti, JAMÁS lo digas en voz alta: no leas firmas, despedidas escritas, nombres entre corchetes, emojis, enlaces ni estas indicaciones.`,
      ``,
      `Tienes herramientas reales: úsalas cuando ayuden. Para mandar un enlace, dirección o dato por escrito, usa "enviar_whatsapp" (nunca dictes enlaces). Para agendar, primero consulta los horarios disponibles y luego crea la cita real con la fecha y hora exactas que el cliente elija. También puedes consultar productos, precios y disponibilidad si te preguntan. Confirma de viva voz lo que hagas y NUNCA leas el nombre de las herramientas.`,
      ``,
      `Conocimiento del negocio (tu referencia para responder, nunca lo leas literal):`,
    ].join('\n');
    const clean = this.stripSignature(promptText || '');
    return clean ? `${voice}\n${clean}` : voice.replace(/\n+Conocimiento del negocio[\s\S]*$/, '');
  }
}
