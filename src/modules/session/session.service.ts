import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma.service';

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) { }

  // Create or update a session based on remoteJid + instanceId
  async registerSession(userId: string, remoteJid: string, pushName: string, instanceId: string) {
    const existingSession = await this.prisma.session.findFirst({
      where: { remoteJid, instanceId },
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

  // Get all sessions for a user
  async getSessionsByUser(userId: string) {
    return this.prisma.session.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  //TODO: Quitar de aquí, esto va en instance services
  // Get a specific userId by instanceId
  async getUserId(instanceName: string) {
    return this.prisma.instancias.findFirst({
      where: {
        instanceName
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

  // Update the "inactivity" field of a session
  async updateInactivity(remoteJid: string, instanceId: string, text: string) {
    return this.prisma.session.updateMany({
      where: { remoteJid, instanceId },
      data: { inactividad: text },
    });
  }

  // Close a session (set status to false)
  async closeSession(remoteJid: string, instanceId: string) {
    return this.prisma.session.updateMany({
      where: { remoteJid, instanceId },
      data: { status: false },
    });
  }
}
