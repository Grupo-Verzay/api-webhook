import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from 'src/database/prisma.service';
import { StageAutomationService } from 'src/modules/stage-automation/stage-automation.service';
import { ChatEventsGateway } from 'src/modules/realtime/chat-events.gateway';

@Injectable()
export class AutoAssignService {
  private readonly logger = new Logger(AutoAssignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Dispara (fire-and-forget) las automatizaciones del asesor recién asignado. */
  private triggerAdvisorAutomations(sessionId: number, advisorId: string): void {
    try {
      const svc = this.moduleRef.get(StageAutomationService, { strict: false });
      void svc.executeForAdvisor(sessionId, advisorId);
    } catch (err: any) {
      this.logger.warn(
        `[AUTO-ASSIGN] No se pudo disparar automatizaciones de asesor session=${sessionId}: ${err?.message}`,
      );
    }
  }

  /**
   * Notifica por tiempo real que el chat cambió (se asignó asesor) para que el
   * panel del dueño/asesor lo refresque AL INSTANTE, en vez de esperar al poll.
   * Sin `message` → el frontend hace refetch y ve el nuevo asesor.
   * Aditivo y nunca bloqueante (si el gateway no está, se ignora).
   */
  private emitAssignmentRealtime(
    ownerId: string,
    remoteJid?: string,
    instanceName?: string | null,
  ): void {
    if (!remoteJid) return;
    try {
      const gateway = this.moduleRef.get(ChatEventsGateway, { strict: false });
      gateway.emitChatChanged({ userId: ownerId, remoteJid, instanceName });
    } catch {
      // silencioso: nunca romper la asignación por un fallo de emisión.
    }
  }

  /**
   * Tries to auto-assign a newly created session to the advisor with the
   * fewest active sessions, respecting the owner's max-chats limit.
   * Uses a conditional UPDATE to prevent double-assignment race conditions.
   * Devuelve true si asignó (útil para el barrido de seguridad). Loguea el
   * motivo cuando NO asigna, para poder diagnosticar por qué un lead queda solo.
   */
  async tryAssign(
    sessionId: number,
    ownerId: string,
    remoteJid?: string,
    instanceName?: string | null,
  ): Promise<boolean> {
    try {
      // 1. Check owner settings
      const settings = await this.prisma.$queryRaw<
        { auto_assign_enabled: boolean; auto_assign_max_chats: number }[]
      >`
        SELECT auto_assign_enabled, auto_assign_max_chats
        FROM "User"
        WHERE id = ${ownerId}
        LIMIT 1
      `;

      if (!settings[0]) {
        this.logger.debug(
          `[AUTO-ASSIGN] session=${sessionId} owner=${ownerId}: owner no encontrado → no se asigna.`,
        );
        return false;
      }
      if (!settings[0].auto_assign_enabled) {
        this.logger.debug(
          `[AUTO-ASSIGN] session=${sessionId} owner=${ownerId}: auto-asignación deshabilitada → no se asigna.`,
        );
        return false;
      }

      const maxChats = settings[0].auto_assign_max_chats ?? 5;

      // 2. Find advisor with lowest active session count below the limit
      const candidates = await this.prisma.$queryRaw<{ id: string; active_count: number }[]>`
        WITH members AS (
          SELECT u.id, u.advisor_available
          FROM "User" u
          WHERE u.owner_id = ${ownerId}
            AND u.advisor_role IS NOT NULL

          UNION

          SELECT u.id, u.advisor_available
          FROM "linked_accounts" la
          JOIN "User" u ON u.id = la."linked_user_id"
          WHERE la."master_user_id" = ${ownerId}
        )
        SELECT m.id, COUNT(s.id)::int AS active_count
        FROM members m
        LEFT JOIN "Session" s
          ON s.assigned_advisor_id = m.id AND s.status = true
        WHERE m.advisor_available = true
        GROUP BY m.id
        HAVING COUNT(s.id)::int < ${maxChats}
        ORDER BY COUNT(s.id) ASC
        LIMIT 1
      `;

      if (candidates.length === 0) {
        this.logger.warn(
          `[AUTO-ASSIGN] session=${sessionId} owner=${ownerId}: SIN asesores elegibles ` +
            `(ninguno disponible y bajo el límite ${maxChats}). El lead queda sin asignar.`,
        );
        return false;
      }

      const advisorId = candidates[0].id;

      // 3. Assign only if the session is still unassigned (prevents race condition)
      const updated = await this.prisma.$executeRaw`
        UPDATE "Session"
        SET assigned_advisor_id = ${advisorId}
        WHERE id = ${sessionId}
          AND assigned_advisor_id IS NULL
      `;

      if (Number(updated) <= 0) {
        this.logger.debug(
          `[AUTO-ASSIGN] session=${sessionId}: la sesión ya estaba asignada (update 0 filas).`,
        );
        return false;
      }

      try {
        await this.prisma.$executeRaw`
          INSERT INTO "AssignmentLog" ("sessionId", "advisorId", "assignedBy", "action", "createdAt")
          VALUES (${sessionId}, ${advisorId}, ${ownerId}, 'auto_assigned', NOW())
        `;
      } catch (logError) {
        const logMessage =
          logError instanceof Error ? logError.message : String(logError);
        this.logger.warn(
          `[AUTO-ASSIGN] Session ${sessionId} assigned but history log failed: ${logMessage}`,
        );
      }

      this.logger.log(
        `[AUTO-ASSIGN] Session ${sessionId} assigned to advisor ${advisorId}`,
      );

      // Pipeline de asesores: dispara las automatizaciones de ese asesor.
      this.triggerAdvisorAutomations(sessionId, advisorId);
      // Tiempo real: que el panel muestre el asesor asignado al instante.
      this.emitAssignmentRealtime(ownerId, remoteJid, instanceName);
      return true;
    } catch (error) {
      this.logger.error(`[AUTO-ASSIGN] Error assigning session ${sessionId}`, error);
      return false;
    }
  }

  /**
   * Red de seguridad: asigna cualquier sesión ACTIVA que haya quedado SIN asesor
   * pese al tryAssign en tiempo real (p. ej. porque el backend se reinició justo
   * al llegar el mensaje, o un fallo transitorio). Se ejecuta periódicamente
   * desde AutoAssignSweepScheduler. Reutiliza tryAssign (mismos límites/reglas).
   * Excluye @lid (sesiones fantasma sin teléfono).
   */
  async sweepUnassigned(): Promise<{ scanned: number; assigned: number }> {
    // Solo leads RECIENTES (últimos 2 días) y newest-first. Motivos:
    // - La red de seguridad busca rescatar leads frescos cuyo tryAssign en tiempo
    //   real se perdió (reinicio/fallo transitorio); no mass-asignar backlog viejo.
    // - Con ASC + LIMIT, el backlog de sesiones viejas inasignables (owners sin
    //   capacidad) consumía el lote y los leads nuevos nunca se procesaban.
    const pending = await this.prisma.$queryRaw<
      { id: number; userId: string; remoteJid: string }[]
    >`
      SELECT s.id, s."userId", s."remoteJid"
      FROM "Session" s
      JOIN "User" u ON u.id = s."userId"
      WHERE s.assigned_advisor_id IS NULL
        AND s.status = true
        AND u.auto_assign_enabled = true
        AND lower(s."remoteJid") NOT LIKE '%@lid'
        AND s."createdAt" > NOW() - INTERVAL '2 days'
      ORDER BY s."createdAt" DESC
      LIMIT 500
    `;

    let assigned = 0;
    for (const row of pending) {
      const ok = await this.tryAssign(row.id, row.userId, row.remoteJid);
      if (ok) assigned++;
    }
    return { scanned: pending.length, assigned };
  }
}
