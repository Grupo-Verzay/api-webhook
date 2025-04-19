import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';

@Injectable()
export class PromptService {
  constructor(private readonly prisma: PrismaService) {}

  async getPromptUserId(userId: string): Promise<string> {
    const systemMessage = await this.prisma.systemMessage.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }, // Por si tiene varios, le traemos el último actualizado
    });

    return systemMessage?.message ?? 'Eres un asistente amigable y eficiente.';
  }
}
