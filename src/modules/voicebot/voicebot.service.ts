import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { AiCreditsService } from '../ai-credits/ai-credits.service';
import { AiAgentService } from '../ai-agent/ai-agent.service';
import { LLAMADAS_AGENT_ID } from '../../types/channel-agent-ids';
import { NodeSenderService } from '../workflow/services/node-sender.service.ts/node-sender.service';

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
    private readonly nodeSender: NodeSenderService,
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
        { enabled: boolean; voice: string | null; transfer: string | null; prompt: string | null }[]
      >`
        SELECT "voicebot_enabled" AS enabled, "voicebot_voice" AS voice,
               "voicebot_transfer_to" AS transfer, "voicebot_prompt" AS prompt
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

      // 4) Instrucciones: el entrenamiento del agente de LLAMADAS (mismo editor
      // que los demás canales) + envoltura de voz. Prioridad: AgentPrompt de
      // Llamadas → voicebot_prompt (legacy) → entrenamiento base de chat.
      const [callAp, baseAp] = await Promise.all([
        this.prisma.agentPrompt.findFirst({
          where: { userId, agentId: LLAMADAS_AGENT_ID },
          orderBy: { updatedAt: 'desc' },
          select: { promptText: true, businessName: true },
        }),
        this.prisma.agentPrompt.findFirst({
          where: { userId, agentId: 'system-prompt-ai' },
          orderBy: { updatedAt: 'desc' },
          select: { promptText: true, businessName: true },
        }),
      ]);
      const business =
        (callAp?.businessName || baseAp?.businessName || '').trim() || 'nuestra empresa';
      const callPrompt =
        (callAp?.promptText || '').trim() ||
        (inst.prompt || '').trim() ||
        baseAp?.promptText ||
        '';
      const instructions = this.buildVoiceInstructions(callPrompt, business, voiceInstructions);
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
   * Reportado por wacalls al TERMINAR una llamada saliente del bot, con su
   * resultado. Si NO fue contestada y la cuenta tiene activado el auto-mensaje
   * "al no contestar", se le envía al contacto por WhatsApp (queda en su chat).
   * La llamada ya quedó registrada al iniciarse (logOutgoingCallAction en el front).
   */
  async handleCallResult(
    sid: string,
    phone: string,
    answered: boolean,
    secret?: string,
  ): Promise<{ ok: boolean; sent?: boolean }> {
    const expected = process.env.VOICEBOT_SECRET;
    if (expected && secret !== expected) return { ok: false };
    if (!sid?.trim() || !phone?.trim()) return { ok: false };

    // Contestada → nada que enviar.
    if (answered) return { ok: true, sent: false };

    try {
      const users = await this.prisma.$queryRaw<
        { id: string; enabled: boolean; text: string | null }[]
      >`
        SELECT "id",
               "missed_call_reply_enabled" AS enabled,
               "missed_call_reply_text"    AS text
        FROM "User" WHERE "astra_calls_sid" = ${sid} LIMIT 1
      `;
      const row = users[0];
      if (!row?.id) return { ok: false };
      if (!row.enabled) return { ok: true, sent: false };
      const text = (row.text ?? '').trim();
      if (!text) return { ok: true, sent: false };

      const sent = await this.sendWhatsapp(row.id, phone, text);
      this.logger.log(
        `[voicebot] auto-mensaje al no contestar userId=${row.id} phone=${phone} sent=${sent}`,
      );
      return { ok: true, sent };
    } catch (err: any) {
      this.logger.warn(`[voicebot] handleCallResult error: ${err?.message ?? err}`);
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

  /**
   * Envía por WhatsApp (Evolution) al cliente de la llamada. Si el texto incluye
   * una URL de archivo (pdf/imagen/video/documento), lo envía como MEDIA real
   * (catálogo, cotización, etc.); si no, como texto.
   */
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

      // ¿El mensaje trae una URL de archivo? → enviarlo como MEDIA (documento/
      // imagen/video) con el resto del texto como caption.
      const m = text.match(
        /https?:\/\/\S+?\.(pdf|jpe?g|png|webp|gif|mp4|mov|m4v|docx?|xlsx?|pptx?|csv)\b[^\s]*/i,
      );
      if (m) {
        const mediaUrl = m[0];
        const ext = m[1].toLowerCase();
        const type = /^(mp4|mov|m4v)$/.test(ext)
          ? 'video'
          : /^(jpe?g|png|webp|gif)$/.test(ext)
          ? 'image'
          : 'document';
        const caption = text.replace(mediaUrl, '').replace(/\s{2,}/g, ' ').trim();
        const ok = await this.nodeSender.sendMediaNode(
          `${base}/message/sendMedia/${encodeURIComponent(inst.instanceName)}`,
          inst.instanceId,
          digits,
          type,
          caption,
          mediaUrl,
        );
        if (ok) return true;
        // si el envío de media falla, cae a texto plano abajo
      }

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
      `Tienes herramientas reales: úsalas cuando ayuden. Para mandar un enlace, dirección, dato por escrito o un ARCHIVO (catálogo, cotización, PDF, imagen), usa "enviar_whatsapp" e incluye el enlace del archivo: llegará como archivo de verdad por WhatsApp (nunca dictes enlaces en voz). Para agendar, primero consulta los horarios disponibles y luego crea la cita real con la fecha y hora exactas que el cliente elija. También puedes consultar productos, precios y disponibilidad si te preguntan. Confirma de viva voz lo que hagas y NUNCA leas el nombre de las herramientas.`,
      ``,
      `Conocimiento del negocio (tu referencia para responder, nunca lo leas literal):`,
    ].join('\n');
    const clean = this.stripSignature(promptText || '');
    return clean ? `${voice}\n${clean}` : voice.replace(/\n+Conocimiento del negocio[\s\S]*$/, '');
  }
}
