import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';
import {
  buildWhatsAppJidCandidates,
  normalizeWhatsAppConversationJid,
  pickExplicitWhatsAppPhoneJid,
  pickObservedAlternateRemoteJid,
  pickPreferredWhatsAppRemoteJid,
} from 'src/utils/whatsapp-jid.util';

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
  ) {}

  private clean(value?: string | null) {
    return (value ?? '').trim();
  }

  private parseFlujos(raw: string): Array<{ id: string; name: string }> {
    const str = (raw ?? '').trim();
    if (!str) return [];

    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // legacy format: comma-separated names, use name as id fallback
    }

    return str
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ id: name, name }));
  }

  private buildRemoteJidCandidates(
    remoteJid: string,
    extras: Array<string | null | undefined> = [],
  ) {
    return buildWhatsAppJidCandidates(remoteJid, extras);
  }

  private resolvePreferredRemoteJid(values: Array<string | null | undefined>) {
    return (
      pickExplicitWhatsAppPhoneJid(values) ||
      pickPreferredWhatsAppRemoteJid(values) ||
      normalizeWhatsAppConversationJid(
        values.find((value) => value?.trim()) ?? '',
      ) ||
      values.find((value) => value?.trim())?.trim() ||
      ''
    );
  }

  private async findSessionByCandidates(
    userId: string,
    instanceId: string,
    candidates: string[],
  ) {
    return this.prisma.session.findFirst({
      where: {
        userId,
        instanceId,
        OR: [
          { remoteJid: { in: candidates } },
          { remoteJidAlt: { in: candidates } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

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
    senderPn?: string | null,
  ) {
    const isBadName = (n: string) =>
      n === '' || n === '.' || n.toLowerCase() === 'desconocido';

    const pn = this.clean(pushName);
    const observedAliases = [
      this.clean(remoteJid),
      this.clean(remoteJidAlt),
      this.clean(senderPn),
    ];
    const rj = this.resolvePreferredRemoteJid(observedAliases);
    const candidates = this.buildRemoteJidCandidates(rj, observedAliases);

    // Transacción serializable para evitar race condition entre dos webhooks
    // simultáneos del mismo contacto que harían doble-create.
    return this.prisma.$transaction(
      async (tx) => {
        const existingSession = await tx.session.findFirst({
          where: {
            userId,
            instanceId,
            OR: [
              { remoteJid: { in: candidates } },
              { remoteJidAlt: { in: candidates } },
            ],
          },
          orderBy: { updatedAt: 'desc' },
        });

        if (existingSession) {
          const nextPushName = !isBadName(pn) ? pn : existingSession.pushName;
          const nextAlt = pickObservedAlternateRemoteJid(rj, [
            ...observedAliases,
            existingSession.remoteJid,
            existingSession.remoteJidAlt,
          ]);

          return tx.session.update({
            where: { id: existingSession.id },
            data: {
              remoteJid: rj,
              remoteJidAlt: nextAlt,
              pushName: nextPushName,
              instanceId: this.clean(instanceId),
              updatedAt: new Date(),
            },
          });
        }

        return tx.session.create({
          data: {
            userId,
            remoteJid: rj,
            remoteJidAlt: pickObservedAlternateRemoteJid(rj, observedAliases),
            pushName: !isBadName(pn) ? pn : 'Desconocido',
            instanceId: this.clean(instanceId),
            status: true,
            updatedAt: new Date(),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  // Nuevo método para obtener el estado de agentDisabled
  async getAgentDisabled(
    remoteJid: string,
    instanceName: string,
    userId: string,
  ): Promise<boolean> {
    const rj = this.clean(remoteJid);
    const inst = this.clean(instanceName);
    const uid = this.clean(userId);
    const candidates = this.buildRemoteJidCandidates(rj);

    const session = await this.findSessionByCandidates(uid, inst, candidates);

    return !!session?.agentDisabled;
  }

  // Get a specific session by remoteJid and instanceId
  async getSession(remoteJid: string, instanceId: string, userId: string) {
    const candidates = this.buildRemoteJidCandidates(this.clean(remoteJid));
    return this.findSessionByCandidates(
      this.clean(userId),
      this.clean(instanceId),
      candidates,
    );
  }

  async updateSessionRemoteJid(id: number, newRemoteJid: string) {
    const current = await this.prisma.session.findUnique({
      where: { id },
      select: { remoteJid: true, remoteJidAlt: true },
    });

    return this.prisma.session.update({
      where: { id },
      data: {
        remoteJid: newRemoteJid,
        remoteJidAlt: current?.remoteJidAlt ?? current?.remoteJid ?? null,
      },
    });
  }

  // Update state session by remoteJid y instanceId
  async updateSessionStatus(
    remoteJid: string,
    instanceId: string,
    status: boolean,
    userId: string,
  ) {
    const candidates = this.buildRemoteJidCandidates(this.clean(remoteJid));
    return this.prisma.session.updateMany({
      where: {
        userId: this.clean(userId),
        instanceId: this.clean(instanceId),
        OR: [
          { remoteJid: { in: candidates } },
          { remoteJidAlt: { in: candidates } },
        ],
      },
      data: { status },
    });
  }

  async updateAgentDisabled(
    remoteJid: string,
    instanceId: string,
    agentDisabled: boolean,
    userId: string,
  ) {
    const candidates = this.buildRemoteJidCandidates(this.clean(remoteJid));
    return this.prisma.session.updateMany({
      where: {
        userId: this.clean(userId),
        instanceId: this.clean(instanceId),
        OR: [
          { remoteJid: { in: candidates } },
          { remoteJidAlt: { in: candidates } },
        ],
      },
      data: { agentDisabled },
    });
  }

  /**
   * Deshabilita la sesión de forma atómica: status=false y agentDisabled=true
   * en una única transacción para evitar estados inconsistentes si una de las
   * dos operaciones falla.
   */
  async disableSession(
    remoteJid: string,
    instanceId: string,
    userId: string,
  ): Promise<void> {
    const candidates = this.buildRemoteJidCandidates(this.clean(remoteJid));
    const where = {
      userId: this.clean(userId),
      instanceId: this.clean(instanceId),
      OR: [
        { remoteJid: { in: candidates } },
        { remoteJidAlt: { in: candidates } },
      ],
    };

    await this.prisma.session.updateMany({
      where,
      data: { status: false, agentDisabled: true },
    });
  }

  // Consulta el estado del chat
  async isSessionActive(
    remoteJid: string,
    userId: string,
    instanceId: string,
  ): Promise<boolean> {
    const session = await this.getSession(remoteJid, instanceId, userId);
    return session?.status ?? false;
  }

  async registerSeguimientos(
    seguimientos: string,
    remoteJid: string,
    instanceId: string,
    userId: string,
  ) {
    try {
      const candidates = this.buildRemoteJidCandidates(this.clean(remoteJid));
      const updatedSession = await this.prisma.session.updateMany({
        where: {
          userId: this.clean(userId),
          instanceId: this.clean(instanceId),
          OR: [
            { remoteJid: { in: candidates } },
            { remoteJidAlt: { in: candidates } },
          ],
        },
        data: { seguimientos },
      });

      if (updatedSession.count === 0) {
        return null;
      }

      const session = await this.getSession(remoteJid, instanceId, userId);

      return session;
    } catch (error) {
      return null;
    }
  }

  async registerWorkflow(
    workflow: { id: string; name: string },
    remoteJid: string,
    instanceId: string,
    userId: string,
  ) {
    try {
      const candidates = this.buildRemoteJidCandidates(this.clean(remoteJid));

      const existing = await this.prisma.session.findFirst({
        where: {
          userId: this.clean(userId),
          instanceId: this.clean(instanceId),
          OR: [
            { remoteJid: { in: candidates } },
            { remoteJidAlt: { in: candidates } },
          ],
        },
        select: { flujos: true },
      });

      const parsed = this.parseFlujos(existing?.flujos ?? '');
      const idx = parsed.findIndex((f) => f.id === workflow.id);

      if (idx !== -1) {
        parsed[idx].name = workflow.name;
      } else {
        parsed.push({ id: workflow.id, name: workflow.name });
      }

      const updatedSession = await this.prisma.session.updateMany({
        where: {
          userId: this.clean(userId),
          instanceId: this.clean(instanceId),
          OR: [
            { remoteJid: { in: candidates } },
            { remoteJidAlt: { in: candidates } },
          ],
        },
        data: { flujos: JSON.stringify(parsed) },
      });

      if (updatedSession.count === 0) {
        return null;
      }

      const session = await this.getSession(remoteJid, instanceId, userId);

      return session;
    } catch (error) {
      return null;
    }
  }

  /**
   * Limpia los seguimientos de INACTIVIDAD cuando el usuario ya respondió
   * y el agente ya envió su respuesta.
   *
   * Se ejecuta de ÚLTIMO después de responder al cliente.
   */
  async clearInactividadAfterAgentReply(
    userId: string,
    remoteJid: string,
    instanceId: string,
  ): Promise<void> {
    const session = await this.getSession(remoteJid, instanceId, userId);

    if (!session || !session.inactividad) {
      // No hay inactividad registrada para esta sesión
      return;
    }

    const parseIds = (value?: string | null): number[] => {
      if (!value || !value.trim()) return [];
      return (
        value
          // soporta ambos formatos: "1-2-3" o "1,2,3"
          .split(/[-,]/)
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !Number.isNaN(n))
      );
    };

    const buildString = (ids: number[]) =>
      ids.length ? ids.map((id) => id.toString()).join('-') : '';

    const inactividadIds = parseIds(session.inactividad);
    if (!inactividadIds.length) return;

    const todosSeguimientos = parseIds(session.seguimientos);

    // IDs que permanecerán como seguimientos normales (no eran de inactividad)
    const restantes = todosSeguimientos.filter(
      (id) => !inactividadIds.includes(id),
    );

    // 1) Eliminar o marcar los seguimientos de inactividad
    // Si tienes un campo estado en Seguimiento, cámbialo a updateMany
    await this.prisma.seguimiento.deleteMany({
      where: { id: { in: inactividadIds } },
    });

    // 2) Actualizar la sesión: limpiar inactividad y ajustar seguimientos
    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        inactividad: '',
        seguimientos: buildString(restantes),
      },
    });

    this.logger.log(
      `Inactividad limpiada para ${remoteJid} (instanceId: ${instanceId}). Eliminados seguimientos: [${inactividadIds.join(
        ', ',
      )}]`,
      'SessionService',
    );
  }

  async removeSeguimientosFromSession(
    ids: number[],
    remoteJid: string,
    instanceId: string,
    userId: string,
  ): Promise<void> {
    if (!ids.length) return;

    const session = await this.getSession(remoteJid, instanceId, userId);

    if (!session) return;

    const parseIds = (value?: string | null): number[] => {
      if (!value || !value.trim()) return [];
      return value
        .split(/[-,]/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n));
    };

    const buildString = (currentIds: number[]) =>
      currentIds.length ? currentIds.map((id) => id.toString()).join('-') : '';

    const removeSet = new Set(ids);
    const nextSeguimientos = parseIds(session.seguimientos).filter(
      (id) => !removeSet.has(id),
    );
    const nextInactividad = parseIds(session.inactividad).filter(
      (id) => !removeSet.has(id),
    );

    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        seguimientos: buildString(nextSeguimientos),
        inactividad: buildString(nextInactividad),
      },
    });
  }
}
