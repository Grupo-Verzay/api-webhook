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
      const greeting = `Saluda en español de forma breve y cálida ("Hola, gracias por llamar a ${business}") y pregunta en qué puedes ayudar. Una sola frase.`;

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

  private buildVoiceInstructions(promptText: string, business: string): string {
    const voice = [
      `Eres un asistente de VOZ que atiende llamadas telefónicas de ${business} en español. Estás HABLANDO por teléfono, no escribiendo.`,
      `Habla de forma natural, cálida y con frases CORTAS.`,
      `NO leas firmas, despedidas escritas, nombres entre corchetes [ ], emojis ni datos de contacto que aparezcan en las instrucciones: eso es solo para mensajes de texto, no para hablar.`,
      `Di los PRECIOS y NÚMEROS de forma hablada y natural (ejemplo: "$1.500.000" se dice "un millón quinientos mil pesos"; "10:30" se dice "diez y media"). Nunca leas símbolos, puntos ni comas.`,
      `NO leas URLs ni enlaces en voz alta. Si el cliente necesita un enlace, un archivo o una imagen, dile que se lo enviarás por WhatsApp.`,
      `Si no entiendes, pide amablemente que repitan. Si no puedes resolver algo, ofrécete a tomar el recado y los datos de contacto.`,
    ].join(' ');
    return promptText?.trim()
      ? `${voice}\n\n--- INFORMACIÓN DEL NEGOCIO (adáptala a una conversación hablada) ---\n${promptText.trim()}`
      : voice;
  }
}
