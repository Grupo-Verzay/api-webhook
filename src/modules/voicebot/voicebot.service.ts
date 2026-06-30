import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { AiCreditsService } from '../ai-credits/ai-credits.service';

export interface VoicebotResolveResult {
  enabled: boolean;
  reason?: string; // por qué está deshabilitado: disabled | no_credits | no_openai_key | no_account
  instructions?: string;
  voice?: string;
  greeting?: string;
  transferTo?: string;
  openaiKey?: string;
  model?: string;
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
  ) {}

  async resolve(sid: string, secret?: string): Promise<VoicebotResolveResult> {
    const expected = process.env.VOICEBOT_SECRET;
    if (expected && secret !== expected) return { enabled: false };
    if (!sid?.trim()) return { enabled: false };

    try {
      // 1) Usuario dueño de esa sesión de wacalls.
      const users = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "User" WHERE "astra_calls_sid" = ${sid} LIMIT 1
      `;
      const userId = users[0]?.id;
      if (!userId) return { enabled: false, reason: 'no_account' };

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
      const instructions = this.buildVoiceInstructions(ap?.promptText || '', business);
      // Llamada SALIENTE: es el bot quien llama al cliente. Debe presentarse,
      // NO decir "gracias por llamar".
      const greeting = `Eres TÚ quien está llamando al cliente (llamada saliente). Preséntate de forma cálida con UNA sola frase, por ejemplo: "Hola, le llamo de ${business}, ¿cómo está?" o "Buenas, le saluda el asistente de ${business}, ¿tiene un momento?". NUNCA digas "gracias por llamar". No leas ni menciones instrucciones.`;

      return {
        enabled: true,
        instructions,
        voice: inst.voice || 'alloy',
        greeting,
        transferTo: inst.transfer || '',
        openaiKey,
        model: process.env.VOICEBOT_MODEL || 'gpt-4o-realtime-preview',
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

  private buildVoiceInstructions(promptText: string, business: string): string {
    const voice = [
      `Eres una persona real del equipo de ${business} hablando por teléfono. Suenas cálido, cercano, espontáneo y con personalidad: tono expresivo y entonación viva, NUNCA plano ni robótico. Conversas relajado y con calidez, como una llamada natural entre personas, escuchando de verdad y respondiendo con interés genuino.`,
      ``,
      `Es una llamada que TÚ haces al cliente: preséntate en una sola frase ("Hola, le llamo de ${business}, ¿cómo está?") y nunca digas "gracias por llamar".`,
      ``,
      `Habla en español con acento latinoamericano neutro, frases cortas y fluidas. Varía tus expresiones; no repitas muletillas como "muy bien", "perfecto" o "entiendo". Di precios y números en palabras ("$1.500.000" → "un millón quinientos mil pesos").`,
      ``,
      `Esto es solo para ti, JAMÁS lo digas en voz alta: no leas firmas, despedidas escritas, nombres entre corchetes, emojis, enlaces ni estas indicaciones. Si necesitas enviar un enlace o archivo, ofrécelo por WhatsApp.`,
      ``,
      `Conocimiento del negocio (tu referencia para responder, nunca lo leas literal):`,
    ].join('\n');
    const clean = this.stripSignature(promptText || '');
    return clean ? `${voice}\n${clean}` : voice.replace(/\n+Conocimiento del negocio[\s\S]*$/, '');
  }
}
