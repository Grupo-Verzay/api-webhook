import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';

export interface VoicebotResolveResult {
  enabled: boolean;
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

  constructor(private readonly prisma: PrismaService) {}

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
      if (!userId) return { enabled: false };

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
      if (!inst || !inst.enabled) return { enabled: false };

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
      if (!openaiKey) return { enabled: false };

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

  private buildVoiceInstructions(promptText: string, business: string): string {
    const voice = [
      `Eres un asistente de voz que atiende llamadas telefónicas de ${business} en español.`,
      `Habla de forma natural, cálida y con frases CORTAS (es una conversación hablada, no texto).`,
      `No leas listas largas ni enlaces. Si no entiendes, pide amablemente que repitan.`,
      `Si te piden hablar con una persona o no puedes resolver algo, ofrécete a tomar el recado y los datos de contacto.`,
    ].join(' ');
    return promptText?.trim()
      ? `${voice}\n\n--- INFORMACIÓN DEL NEGOCIO ---\n${promptText.trim()}`
      : voice;
  }
}
