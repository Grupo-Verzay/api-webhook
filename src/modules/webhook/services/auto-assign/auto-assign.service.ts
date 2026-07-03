import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from 'src/database/prisma.service';
import { StageAutomationService } from 'src/modules/stage-automation/stage-automation.service';

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
   * Tries to auto-assign a newly created session to the advisor with the
   * fewest active sessions, respecting the owner's max-chats limit.
   * Uses a conditional UPDATE to prevent double-assignment race conditions.
   */
  async tryAssign(sessionId: number, ownerId: string): Promise<void> {
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

      if (!settings[0]?.auto_assign_enabled) return;

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

      if (candidates.length === 0) return;

      const advisorId = candidates[0].id;

      // 3. Assign only if the session is still unassigned (prevents race condition)
      const updated = await this.prisma.$executeRaw`
        UPDATE "Session"
        SET assigned_advisor_id = ${advisorId}
        WHERE id = ${sessionId}
          AND assigned_advisor_id IS NULL
      `;

      if (Number(updated) <= 0) return;

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
    } catch (error) {
      this.logger.error(`[AUTO-ASSIGN] Error assigning session ${sessionId}`, error);
    }
  }
}
