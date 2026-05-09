import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';

@Injectable()
export class AutoAssignService {
  private readonly logger = new Logger(AutoAssignService.name);

  constructor(private readonly prisma: PrismaService) {}

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
        SELECT u.id, COUNT(s.id)::int AS active_count
        FROM "User" u
        LEFT JOIN "Session" s
          ON s.assigned_advisor_id = u.id AND s.status = true
        WHERE u.owner_id = ${ownerId}
          AND u.advisor_role IS NOT NULL
        GROUP BY u.id
        HAVING COUNT(s.id)::int < ${maxChats}
        ORDER BY COUNT(s.id) ASC
        LIMIT 1
      `;

      if (candidates.length === 0) return;

      const advisorId = candidates[0].id;

      // 3. Assign only if the session is still unassigned (prevents race condition)
      await this.prisma.$executeRaw`
        UPDATE "Session"
        SET assigned_advisor_id = ${advisorId}
        WHERE id = ${sessionId}
          AND assigned_advisor_id IS NULL
      `;

      this.logger.log(
        `[AUTO-ASSIGN] Session ${sessionId} assigned to advisor ${advisorId}`,
      );
    } catch (error) {
      this.logger.error(`[AUTO-ASSIGN] Error assigning session ${sessionId}`, error);
    }
  }
}
