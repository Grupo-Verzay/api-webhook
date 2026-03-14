import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';

@Injectable()
export class PromptService {
  constructor(private readonly prisma: PrismaService) { }

  async getPromptUserId(userId: string, agentId: string): Promise<string> {
    const systemMessages = await this.prisma.agentPrompt.findMany({
      where: { userId, agentId },
      orderBy: { createdAt: 'asc' }, // Opcional: 'asc' si quieres en orden antiguo a nuevo
      select: {
        promptText: true
      },
    });

    if (!systemMessages.length) {
      // Si no hay mensajes, devuelve un prompt base por defecto
      return 'Bienvenido a Quest\nEstoy aquí para ayudarte.';
    }

    const fullPrompt = systemMessages
      .map((sm) => `${sm.promptText}`)
      .join('\n\n'); // Doble salto de línea entre cada bloque

    return fullPrompt;
  }

  async getPromptPadre(userId: string): Promise<string> {
    const systemMessages = await this.prisma.systemMessage.findMany({
      where: {
        userId,
        typePrompt: "TRAINING",
      },
      orderBy: { createdAt: "asc" },
      select: {
        message: true,
      },
    });

    if (!systemMessages.length) {
      return "Bienvenido a Quest\nEstoy aquí para ayudarte.";
    }

    const fullPrompt = systemMessages.map((sm) => sm.message).join("\n\n");
    return fullPrompt;
  }
}

