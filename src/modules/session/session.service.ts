import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) { }

  /**
   * Crea o actualiza una sesión.
   * Evita sesiones duplicadas cuando el mismo contacto aparece con dos JIDs distintos
   * (por ejemplo: 573001234567@jid y 573001234567@s.whatsapp.net).
   *
   * @param userId        ID del usuario dueño de la instancia
   * @param remoteJid     JID "prioritario" que vas a usar (según tu diagrama)
   * @param pushName      Nombre que llega del evento
   * @param instanceId    ID de la instancia de Evolution
   * @param remoteJidAlt  JID alternativo (ej: el otro dominio). Puede ser undefined.
   */
  async registerSession(
    userId: string,
    remoteJid: string,
    pushName: string,
    instanceId: string,
    remoteJidAlt?: string | null,
  ) {
    // Construimos la lista de JIDs posibles para buscar una sesión existente
    const jidsToSearch: string[] = [remoteJid];

    if (remoteJidAlt && remoteJidAlt.trim() !== '') {
      jidsToSearch.push(remoteJidAlt.trim());
    }

    const existingSession = await this.prisma.session.findFirst({
      where: {
        userId,
        remoteJid: { in: jidsToSearch },
      },
    });

    if (existingSession) {
      // Si ya existe, solo actualizamos la sesión en vez de crear otra.
      // Guardamos el remoteJid "prioritario" que estás usando en este momento.
      return this.prisma.session.update({
        where: { id: existingSession.id },
        data: {
          remoteJid,      // ahora se actualiza al JID prioritario actual
          pushName,
          instanceId,
          updatedAt: new Date(),
        },
      });
    }

    // Si no existe ninguna sesión para ninguno de los JIDs, la creamos.
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
        userId,
      },
    });
  }

  async updateSessionRemoteJid(id: number, newRemoteJid: string) {
    return this.prisma.session.update({
      where: { id },
      data: { remoteJid: newRemoteJid },
    });
  }

  // Update state session by remoteJid y instanceId
  async updateSessionStatus(remoteJid: string, instanceId: string, status: boolean, userId: string) {
    return this.prisma.session.updateMany({
      where: { remoteJid, userId },
      data: { status },
    });
  }

  // Consulta el estado del chat
  async isSessionActive(remoteJid: string, userId: string, instanceId: string): Promise<boolean> {
    const session = await this.prisma.session.findFirst({
      where: { remoteJid, userId },
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

      const session = await this.prisma.session.findFirst({
        where: { remoteJid, instanceId, userId },
      });

      return session;
    } catch (error) {
      return null;
    }
  }

  async registerWorkflow(
    flujos: string,
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
        data: { flujos },
      });

      if (updatedSession.count === 0) {
        return null;
      }

      const session = await this.prisma.session.findFirst({
        where: { remoteJid, instanceId, userId },
      });

      return session;
    } catch (error) {
      return null;
    }
  }
}
