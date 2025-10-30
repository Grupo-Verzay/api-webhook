import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) { }

  // Create or update a session based on remoteJid + instanceId
  async registerSession(userId: string, remoteJid: string, pushName: string, instanceId: string) {
    const existingSession = await this.prisma.session.findFirst({
      where: { remoteJid, userId },
    });

    if (existingSession) {
      return this.prisma.session.update({
        where: { id: existingSession.id },
        data: {
          pushName,
          updatedAt: new Date(),
        },
      });
    }

    return this.prisma.session.create({
      data: {
        userId,
        remoteJid,
        pushName,
        instanceId,
        status: true,
      },
    });
  }

  // Get a specific session by remoteJid and instanceId
  async getSession(remoteJid: string, instanceId: string, userId: string) {
    return this.prisma.session.findFirst({
      where: {
        remoteJid,
        instanceId,
        userId,
      },
    });
  }

  // Update state session by remoteJid y instanceId
  async updateSessionStatus(remoteJid: string, instanceId: string, status: boolean, userId: string) {
    return this.prisma.session.updateMany({
      where: { remoteJid, instanceId, userId },
      data: { status },
    });
  }

  // Consulta el estado del chat
  async isSessionActive(remoteJid: string, userId: string, instanceId: string): Promise<boolean> {
    const session = await this.prisma.session.findFirst({
      where: { remoteJid, userId,instanceId },
      select: { status: true },
    });
    return session?.status ?? false;
  }

  async registerSeguimientos(
    seguimientos: string,
    remoteJid: string,
    instanceId: string,
    userId: string,
  ) {
    try {
      const updatedSession = await this.prisma.session.updateMany({
        where: {
          remoteJid,
          instanceId,
          userId,
        },
        data: { seguimientos },
      });

      if (updatedSession.count === 0) {
        return null;
      }


      // Opcional: Puedes hacer un findUnique después si quieres retornar el objeto actualizado
      const session = await this.prisma.session.findFirst({
        where: { remoteJid, instanceId, userId },
      });

      return session;
    } catch (error) {
      return null;
    }
  }
}
