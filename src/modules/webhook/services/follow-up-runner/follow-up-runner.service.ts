import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Seguimiento } from '@prisma/client';

import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { AiAgentService } from 'src/modules/ai-agent/ai-agent.service';
import { ChatHistoryService } from 'src/modules/chat-history/chat-history.service';
import { buildChatHistorySessionId } from 'src/modules/chat-history/chat-history-session.helper';
import { isLegacyWorkflowSeguimiento } from 'src/modules/seguimientos/legacy-workflow-follow-up.helper';
import { SessionService } from 'src/modules/session/session.service';
import { WhatsAppSenderFactory } from 'src/modules/whatsapp/whatsapp-sender.factory';
import { WorkflowService } from 'src/modules/workflow/services/workflow.service.ts/workflow.service';
import { buildWhatsAppJidCandidates } from 'src/utils/whatsapp-jid.util';

@Injectable()
export class FollowUpRunnerService {
  private readonly timezoneOffset: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
    private readonly aiAgentService: AiAgentService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly sessionService: SessionService,
    private readonly factory: WhatsAppSenderFactory,
    private readonly workflowService: WorkflowService,
    private readonly configService: ConfigService,
  ) {
    this.timezoneOffset =
      this.configService.get<string>('FOLLOW_UP_TIMEZONE_OFFSET') ?? '-05:00';
  }

  private clean(value?: string | null) {
    return (value ?? '').trim();
  }

  /**
   * Ventana de envío por cuenta (horario + días) leída de columnas de User.
   * Se cachea por ejecución del runner para no repetir queries por seguimiento.
   * Los campos no viven en el modelo Prisma del backend → SQL crudo snake_case.
   */
  private sendWindowCache = new Map<
    string,
    {
      enabled: boolean;
      startHour: number;
      endHour: number;
      days: Set<number>;
      timezone: string;
    }
  >();

  private async getUserSendWindow(userId: string) {
    const key = this.clean(userId);
    if (!key) return null;
    const cached = this.sendWindowCache.get(key);
    if (cached) return cached;

    let win = {
      enabled: true,
      startHour: 9,
      endHour: 18,
      days: new Set([1, 2, 3, 4, 5, 6]),
      timezone: '',
    };
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{
          enabled: boolean | null;
          startHour: number | null;
          endHour: number | null;
          days: string | null;
          timezone: string | null;
        }>
      >`
        SELECT "follow_up_window_enabled" AS "enabled",
               "follow_up_send_start_hour" AS "startHour",
               "follow_up_send_end_hour" AS "endHour",
               "follow_up_send_days" AS "days",
               "timezone" AS "timezone"
        FROM "User" WHERE id = ${key} LIMIT 1
      `;
      const r = rows?.[0];
      if (r) {
        win = {
          enabled: r.enabled ?? true,
          startHour: Number.isFinite(r.startHour as number) ? Number(r.startHour) : 9,
          endHour: Number.isFinite(r.endHour as number) ? Number(r.endHour) : 18,
          days: new Set(
            (r.days ?? '1,2,3,4,5,6')
              .split(',')
              .map((d) => Number.parseInt(d.trim(), 10))
              .filter((d) => Number.isFinite(d)),
          ),
          timezone: this.clean(r.timezone),
        };
      }
    } catch {
      // columnas ausentes (aún no migradas) → ventana por defecto activa
    }
    this.sendWindowCache.set(key, win);
    return win;
  }

  /** Hora (0-23) y día de semana (0=Dom..6=Sáb) actuales en una zona horaria IANA. */
  private nowInTimezone(timezone: string): { hour: number; day: number } {
    const tz = this.clean(timezone) || undefined;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour12: false,
        weekday: 'short',
        hour: '2-digit',
      }).formatToParts(new Date());
      const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
      const wdStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
      let hour = Number.parseInt(hourStr, 10);
      if (!Number.isFinite(hour) || hour === 24) hour = 0;
      const map: Record<string, number> = {
        Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
      };
      return { hour, day: map[wdStr] ?? 0 };
    } catch {
      // Zona horaria inválida → usar hora del servidor
      const now = new Date();
      return { hour: now.getHours(), day: now.getDay() };
    }
  }

  /**
   * ¿El momento actual está dentro de la ventana de envío de la cuenta?
   * Si la cuenta no tiene ventana activa (o userId vacío) → siempre true.
   */
  private async isWithinSendWindow(userId: string): Promise<boolean> {
    const win = await this.getUserSendWindow(userId);
    if (!win || !win.enabled) return true;
    const { hour, day } = this.nowInTimezone(win.timezone);
    if (win.days.size && !win.days.has(day)) return false;
    // Ventana [start, end): 8..20 => envía de 8:00 a 19:59.
    return hour >= win.startHour && hour < win.endHour;
  }

  private buildRemoteJidCandidates(
    remoteJid: string,
    extras: Array<string | null | undefined> = [],
  ) {
    return buildWhatsAppJidCandidates(this.clean(remoteJid), extras);
  }

  private buildSeguimientoPairsForSession(session: {
    remoteJid: string;
    remoteJidAlt?: string | null;
    instanceId: string;
  }) {
    const pairs = new Map<string, { remoteJid: string; instancia: string }>();
    const instanceId = this.clean(session.instanceId);

    for (const alias of [session.remoteJid, session.remoteJidAlt]) {
      const remoteJid = this.clean(alias);
      if (!remoteJid || !instanceId) continue;

      pairs.set(`${instanceId}::${remoteJid}`, {
        remoteJid,
        instancia: instanceId,
      });
    }

    return Array.from(pairs.values());
  }

  private parseStoredIds(value?: string | null): number[] {
    if (!value || !value.trim()) return [];

    return value
      .split(/[-,]/)
      .map((item) => Number.parseInt(item.trim(), 10))
      .filter((item) => Number.isFinite(item));
  }

  private async findSessionByRemoteJid(remoteJid: string, instanceId: string) {
    const candidates = this.buildRemoteJidCandidates(remoteJid);

    return this.prisma.session.findFirst({
      where: {
        instanceId: this.clean(instanceId),
        OR: [
          { remoteJid: { in: candidates } },
          { remoteJidAlt: { in: candidates } },
        ],
      },
      select: {
        id: true,
        userId: true,
        remoteJid: true,
        remoteJidAlt: true,
        instanceId: true,
        pushName: true,
        seguimientos: true,
        inactividad: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private parseDelaySeconds(value?: string | null): number {
    const parsed = Number.parseInt((value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private parseScheduledTime(timeStr: string): Date | null {
    const trimmed = timeStr.trim();
    if (!trimmed) return null;

    // Formato nuevo: ISO 8601 UTC — "2026-05-15T17:30:00.000Z"
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const d = new Date(trimmed);
      return isNaN(d.getTime()) ? null : d;
    }

    // Formato legado: "dd/MM/yyyy HH:mm" guardado en timezone configurado
    const dateMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
    if (!dateMatch) return null;
    const [, day, month, year, hours, minutes] = dateMatch;
    return new Date(`${year}-${month}-${day}T${hours}:${minutes}:00${this.timezoneOffset}`);
  }

  private isDue(seguimiento: Pick<Seguimiento, 'createdAt' | 'time' | 'followUpAttempt' | 'updatedAt'>) {
    // Si ya fue intentado, aplicar cooldown de 1 min basado en updatedAt
    if ((seguimiento.followUpAttempt ?? 0) > 0) {
      const retryAt = seguimiento.updatedAt.getTime() + 60 * 1000;
      if (retryAt > Date.now()) return false;
    }
    const timeStr = (seguimiento.time ?? '').trim();
    const scheduled = this.parseScheduledTime(timeStr);
    if (scheduled) {
      return scheduled.getTime() <= Date.now();
    }
    // Legacy format: numeric seconds from createdAt
    const delaySeconds = this.parseDelaySeconds(timeStr);
    return seguimiento.createdAt.getTime() + delaySeconds * 1000 <= Date.now();
  }

  // Recordatorio creado después de su hora programada — nunca tuvo sentido enviarlo.
  private isBornDead(seguimiento: Pick<Seguimiento, 'createdAt' | 'time' | 'followUpAttempt' | 'updatedAt'>): boolean {
    const scheduled = this.parseScheduledTime((seguimiento.time ?? '').trim());
    if (!scheduled) return false;
    return seguimiento.createdAt.getTime() >= scheduled.getTime();
  }

  private getTipoBase(tipo?: string | null) {
    const raw = (tipo ?? '').trim().toLowerCase();
    return raw.startsWith('seguimiento-')
      ? raw.replace('seguimiento-', '')
      : raw;
  }

  private isLegacyWorkflowFollowUp(
    seguimiento: Pick<Seguimiento, 'idNodo' | 'tipo'>,
  ) {
    return isLegacyWorkflowSeguimiento(seguimiento);
  }

  private async buildRegistroResumen(sessionId: number): Promise<string> {
    const latestRegistro = await this.prisma.registro.findFirst({
      where: { sessionId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: {
        tipo: true,
        estado: true,
        resumen: true,
        detalles: true,
        nombre: true,
      },
    });

    if (!latestRegistro) return '';

    return JSON.stringify({
      tipo: latestRegistro.tipo,
      estado: latestRegistro.estado,
      nombre: latestRegistro.nombre,
      resumen: latestRegistro.resumen,
      detalles: latestRegistro.detalles,
    });
  }

  private async resolveFollowUpMessage(
    seguimiento: Seguimiento,
    session: {
      id: number;
      userId: string;
      pushName: string | null;
      remoteJid: string;
    },
  ) {
    const fallbackMessage = (seguimiento.mensaje ?? '').trim();
    if (seguimiento.followUpMode !== 'ai') return fallbackMessage;

    const sessionHistoryId = buildChatHistorySessionId(
      seguimiento.instancia ?? '',
      session.remoteJid || seguimiento.remoteJid || '',
    );

    return this.aiAgentService.generateFollowUpMessage({
      userId: session.userId,
      sessionId: sessionHistoryId,
      goal: seguimiento.followUpGoal ?? '',
      customPrompt: seguimiento.followUpPrompt ?? '',
      attempt: (seguimiento.followUpAttempt ?? 0) + 1,
      pushName: session.pushName ?? '',
      registroResumen: await this.buildRegistroResumen(session.id),
      fallbackMessage:
        fallbackMessage ||
        'Hola, sigo atento por si quieres retomar la conversacion.',
    });
  }

  private async sendSeguimiento(
    seguimiento: Seguimiento,
    finalMessage: string,
    targetRemoteJid?: string,
  ) {
    const serverUrl = (seguimiento.serverurl ?? '').trim();
    const instanceName = (seguimiento.instancia ?? '').trim();
    const remoteJid =
      this.clean(targetRemoteJid) || (seguimiento.remoteJid ?? '').trim();
    const apikey = (seguimiento.apikey ?? '').trim();
    const media = (seguimiento.media ?? '').trim();
    const tipoBase = this.getTipoBase(seguimiento.tipo);

    if (!instanceName || !remoteJid) {
      throw new Error('Seguimiento sin instancia o remoteJid.');
    }

    const sender = await this.factory.getSender(instanceName);

    if (tipoBase === 'text') {
      if (!finalMessage.trim())
        throw new Error('Follow-up de texto sin mensaje final.');
      const ok = await sender.sendText(instanceName, remoteJid, finalMessage, serverUrl, apikey);
      if (!ok) throw new Error('Error enviando follow-up de texto.');
      return;
    }

    if (['image', 'video', 'document'].includes(tipoBase)) {
      if (!media) throw new Error(`Follow-up ${tipoBase} sin media.`);
      const ok = await sender.sendMedia(instanceName, remoteJid, tipoBase, finalMessage, media, serverUrl, apikey);
      if (!ok) throw new Error(`Error enviando follow-up ${tipoBase}.`);
      return;
    }

    if (tipoBase === 'audio') {
      if (finalMessage.trim()) {
        const okText = await sender.sendText(instanceName, remoteJid, finalMessage, serverUrl, apikey);
        if (!okText) throw new Error('Error enviando texto previo al audio.');
      }

      if (!media) throw new Error('Follow-up de audio sin media.');
      const okAudio = await sender.sendAudio(instanceName, remoteJid, media, serverUrl, apikey);
      if (!okAudio) throw new Error('Error enviando follow-up de audio.');
      return;
    }

    throw new Error(
      `Tipo de seguimiento no soportado: ${seguimiento.tipo ?? 'unknown'}`,
    );
  }

  private async markSent(
    seguimientoId: number,
    sessionData: { userId: string; remoteJid: string; instanceId: string },
    finalMessage: string,
  ) {
    await this.prisma.seguimiento.delete({
      where: { id: seguimientoId },
    });

    await this.sessionService.removeSeguimientosFromSession(
      [seguimientoId],
      sessionData.remoteJid,
      sessionData.instanceId,
      sessionData.userId,
    );
  }

  private async markFailure(
    seguimiento: Seguimiento,
    sessionData: {
      userId: string;
      remoteJid: string;
      instanceId: string;
    } | null,
    errorReason?: string | null,
  ) {
    const nextAttempt = (seguimiento.followUpAttempt ?? 0) + 1;
    const maxAttempts = Math.max(seguimiento.followUpMaxAttempts ?? 1, 1);
    const exhausted = nextAttempt >= maxAttempts;
    const normalizedErrorReason = (errorReason ?? '').trim().slice(0, 500);

    if (exhausted) {
      await this.prisma.seguimiento.delete({ where: { id: seguimiento.id } });

      if (sessionData) {
        await this.sessionService.removeSeguimientosFromSession(
          [seguimiento.id],
          sessionData.remoteJid,
          sessionData.instanceId,
          sessionData.userId,
        );
      }
    } else {
      await this.prisma.seguimiento.update({
        where: { id: seguimiento.id },
        data: {
          followUpAttempt: nextAttempt,
          followUpStatus: 'pending',
          errorReason: normalizedErrorReason || null,
          ...(sessionData
            ? {
                remoteJid: sessionData.remoteJid,
                instancia: sessionData.instanceId,
              }
            : {}),
        },
      });
    }
  }

  /**
   * Marca el recordatorio (tabla Reminders) como enviado cuando el seguimiento
   * proviene de un recordatorio (`reminder-<id>`) o campaña (`camping-<id>-<n>`).
   * Deja evidencia persistente de "enviado" sin depender del seguimiento, que
   * sí se elimina/actualiza tras el envío.
   */
  private async markReminderSentIfApplicable(idNodo?: string | null) {
    const id = (idNodo ?? '').trim();
    let reminderId: string | null = null;

    if (id.startsWith('reminder-')) {
      reminderId = id.slice('reminder-'.length).trim();
    } else {
      const match = id.match(/^camping-(.+)-\d+$/);
      if (match) reminderId = match[1];
    }

    if (!reminderId) return;

    try {
      await this.prisma.reminders.update({
        where: { id: reminderId },
        data: { sentAt: new Date() },
      });
    } catch {
      // La fila de Reminders pudo haberse eliminado; ignorar.
    }
  }

  /**
   * Si el seguimiento proviene de un recordatorio con workflow asignado,
   * lo ejecuta después de enviar el mensaje de texto.
   */
  private async tryExecuteReminderWorkflow(
    seguimiento: Seguimiento,
    session: { userId: string; remoteJid: string; instanceId: string },
  ) {
    const idNodo = (seguimiento.idNodo ?? '').trim();
    if (!idNodo.startsWith('reminder-')) return;

    const reminderId = idNodo.replace('reminder-', '').trim();
    if (!reminderId) return;

    const reminder = await this.prisma.reminders.findUnique({
      where: { id: reminderId },
      select: { workflowId: true },
    });

    if (!reminder?.workflowId) return;

    const workflow = await this.prisma.workflow.findUnique({
      where: { id: reminder.workflowId },
      select: { name: true },
    });

    if (!workflow?.name) {
      this.logger.warn(
        `[REMINDER_WORKFLOW] Workflow id=${reminder.workflowId} no encontrado para reminder id=${reminderId}`,
        'FollowUpRunnerService',
      );
      return;
    }

    const serverUrl = (seguimiento.serverurl ?? '').trim();
    const instanceName = (seguimiento.instancia ?? '').trim();
    const apikey = (seguimiento.apikey ?? '').trim();

    this.logger.log(
      `[REMINDER_WORKFLOW] Ejecutando workflow "${workflow.name}" desde reminder id=${reminderId}`,
      'FollowUpRunnerService',
    );

    try {
      await this.workflowService.executeWorkflow(
        workflow.name,
        serverUrl,
        apikey,
        instanceName,
        session.remoteJid,
        session.userId,
      );
    } catch (err: any) {
      this.logger.error(
        `[REMINDER_WORKFLOW] Error ejecutando workflow "${workflow.name}": ${err?.message ?? err}`,
        err,
        'FollowUpRunnerService',
      );
    }
  }

  private async shouldAbortFollowUp(seguimientoId: number) {
    const current = await this.prisma.seguimiento.findUnique({
      where: { id: seguimientoId },
      select: { followUpStatus: true },
    });

    return !current || current.followUpStatus !== 'processing';
  }

  async recoverStuckProcessing(): Promise<number> {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000);
    const result = await this.prisma.seguimiento.updateMany({
      where: {
        followUpStatus: 'processing',
        updatedAt: { lte: cutoff },
      },
      data: { followUpStatus: 'pending' },
    });
    if (result.count > 0) {
      this.logger.warn(
        `[FOLLOW_UP] Recuperados ${result.count} seguimiento(s) atascados en 'processing' → reset a 'pending'.`,
        'FollowUpRunnerService',
      );
    }
    return result.count;
  }

  async cancelPendingFollowUpsOnReply(args: {
    userId: string;
    remoteJid: string;
    instanceName: string;
  }) {
    const { userId, remoteJid, instanceName } = args;
    const session = await this.findSessionByRemoteJid(remoteJid, instanceName);
    if (!session) return { count: 0, ids: [] as number[] };

    const storedInactividadIds = this.parseStoredIds(session.inactividad);
    if (!storedInactividadIds.length) return { count: 0, ids: [] as number[] };

    const remoteJidCandidates = this.buildSeguimientoPairsForSession(session).map(
      (item) => item.remoteJid,
    );
    const candidates = this.buildRemoteJidCandidates(remoteJid, remoteJidCandidates);

    const followUpsToDelete = await this.prisma.seguimiento.findMany({
      where: {
        id: { in: storedInactividadIds },
        instancia: instanceName,
        remoteJid: { in: candidates },
      },
      select: { id: true },
    });

    const ids = followUpsToDelete.map((item) => item.id);
    if (!ids.length) return { count: 0, ids: [] as number[] };

    await this.prisma.seguimiento.deleteMany({
      where: {
        id: { in: ids },
      },
    });

    await this.sessionService.removeSeguimientosFromSession(
      ids,
      session.remoteJid,
      session.instanceId,
      userId,
    );

    this.logger.log(
      `[INACTIVIDAD] Eliminados seguimientos por respuesta del cliente. session=${session.id} ids=[${ids.join(', ')}]`,
      'FollowUpRunnerService',
    );

    return { count: ids.length, ids };
  }

  async processDueFollowUps(
    limit = 25,
    scope?: { userId?: string; instanceId?: string; remoteJid?: string },
  ) {
    // Refresca la config de ventana por cuenta en cada corrida (evita cache stale
    // si el usuario cambia su horario en Ajustes).
    this.sendWindowCache.clear();

    const take = Math.max(limit * 20, 500);
    let scopedWhere:
      | {
          OR?: Array<{ remoteJid: string; instancia: string }>;
          instancia?: string;
        }
      | undefined;

    if (scope?.userId || scope?.instanceId || scope?.remoteJid) {
      const sessionWhere: {
        userId?: string;
        instanceId?: string;
        OR?: Array<
          { remoteJid: { in: string[] } } | { remoteJidAlt: { in: string[] } }
        >;
      } = {
        ...(scope?.userId ? { userId: scope.userId } : {}),
        ...(scope?.instanceId ? { instanceId: scope.instanceId } : {}),
      };

      if (scope?.remoteJid) {
        const candidates = this.buildRemoteJidCandidates(scope.remoteJid);
        sessionWhere.OR = [
          { remoteJid: { in: candidates } },
          { remoteJidAlt: { in: candidates } },
        ];
      }

      const sessions = await this.prisma.session.findMany({
        where: sessionWhere,
        select: {
          remoteJid: true,
          remoteJidAlt: true,
          instanceId: true,
        },
      });

      const sessionPairsMap = new Map<
        string,
        { remoteJid: string; instancia: string }
      >();
      for (const session of sessions) {
        for (const pair of this.buildSeguimientoPairsForSession(session)) {
          sessionPairsMap.set(`${pair.instancia}::${pair.remoteJid}`, pair);
        }
      }

      const sessionPairs = Array.from(sessionPairsMap.values());
      if (!sessionPairs.length) {
        return {
          scanned: 0,
          due: 0,
          sent: 0,
          failed: 0,
          skipped: 0,
        };
      }

      scopedWhere = { OR: sessionPairs };
    }

    const pending = await this.prisma.seguimiento.findMany({
      where: {
        followUpStatus: 'pending',
        ...(scopedWhere ?? {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
    });

    // Registros recientes (últimas 12 h) — pueden estar detrás de colas largas.
    const recentPending = await this.prisma.seguimiento.findMany({
      where: {
        followUpStatus: 'pending',
        ...(scopedWhere ?? {}),
        createdAt: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });

    // Registros creados hace más de 12 h que nunca fueron intentados.
    // Sin el take amplio, quedan atrapados si hay >500 registros más viejos delante de ellos.
    const backlogPending = await this.prisma.seguimiento.findMany({
      where: {
        followUpStatus: 'pending',
        followUpAttempt: 0,
        ...(scopedWhere ?? {}),
        createdAt: {
          lt: new Date(Date.now() - 12 * 60 * 60 * 1000),
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
    });

    const seenIds = new Set<number>();
    const merged = [...pending, ...recentPending, ...backlogPending].filter((seg) => {
      if (seenIds.has(seg.id)) return false;
      seenIds.add(seg.id);
      return true;
    });

    const due = merged
      .filter((seguimiento) => this.isDue(seguimiento))
      .slice(0, limit);
    const summary = {
      scanned: merged.length,
      due: due.length,
      sent: 0,
      failed: 0,
      skipped: 0,
    };

    for (const current of due) {
      if (this.isBornDead(current)) {
        await this.prisma.seguimiento.delete({ where: { id: current.id } });
        summary.skipped++;
        this.logger.log(
          `[FOLLOW_UP][id=${current.id}] Recordatorio vencido al crearse, eliminando sin enviar.`,
          'FollowUpRunnerService',
        );
        continue;
      }

      const lock = await this.prisma.seguimiento.updateMany({
        where: { id: current.id, followUpStatus: 'pending' },
        data: { followUpStatus: 'processing' },
      });

      if (lock.count === 0) {
        summary.skipped++;
        continue;
      }

      const seguimiento = await this.prisma.seguimiento.findUnique({
        where: { id: current.id },
      });

      if (!seguimiento) {
        summary.skipped++;
        continue;
      }

      const session = await this.findSessionByRemoteJid(
        seguimiento.remoteJid ?? '',
        seguimiento.instancia ?? '',
      );

      const loggerCtx = `[FOLLOW_UP][id=${seguimiento.id}][instance=${seguimiento.instancia ?? '-'}][remoteJid=${seguimiento.remoteJid ?? '-'}]`;

      // Si no hay sesión pero el seguimiento es estático con datos propios, intentar enviar directamente
      const canSendWithoutSession =
        !session &&
        (seguimiento.followUpMode ?? 'static') === 'static' &&
        (seguimiento.remoteJid ?? '').trim() !== '' &&
        (seguimiento.instancia ?? '').trim() !== '';

      if (!session && !canSendWithoutSession) {
        this.logger.warn(
          `${loggerCtx} sesion no encontrada.`,
          'FollowUpRunnerService',
        );
        await this.markFailure(
          seguimiento,
          null,
          'Sesion no encontrada para ejecutar el follow-up.',
        );
        summary.failed++;
        continue;
      }

      if (!session) {
        this.logger.warn(
          `${loggerCtx} sesion no encontrada — enviando directamente con datos del seguimiento.`,
          'FollowUpRunnerService',
        );
      }

      // Datos de contexto: usa la sesión si existe, o los datos del seguimiento como fallback
      const effectiveRemoteJid = session?.remoteJid ?? (seguimiento.remoteJid ?? '').trim();
      const effectiveUserId = session?.userId ?? '';
      const effectiveInstanceId = session?.instanceId ?? (seguimiento.instancia ?? '').trim();

      // Ventana de envío por cuenta (horario + días en su zona horaria). Si un flujo cae
      // fuera de la franja, se libera el lock (vuelve a 'pending') y se reintenta en la
      // próxima corrida del runner que caiga dentro del horario. No cuenta intento.
      const idNodo = (seguimiento.idNodo ?? '').trim();
      // La ventana de envío (horario laboral) aplica ÚNICAMENTE a los seguimientos de
      // FLUJO/WORKFLOW (nodos de /flow y /workflow), que se disparan de forma relativa a
      // la inactividad del cliente y por eso sí deben respetar el horario. Estos usan
      // `idNodo` = id del nodo del constructor (no vacío y sin prefijo de recordatorio).
      //
      // Todo lo demás tiene una hora exacta elegida por el usuario o debe salir de
      // inmediato, así que NO se pospone:
      //   - recordatorios: reminder-, appt-reminder-, booking-reminder-, booking-svc-reminder-, task-reminder-
      //   - confirmaciones: appt-confirm-, booking-confirm-, e idNodo vacío ("")
      //   - campañas: camping-
      const isReminderOrConfirm =
        idNodo === '' ||
        /^(?:appt|booking(?:-svc)?|task)-reminder-/.test(idNodo) ||
        idNodo.startsWith('reminder-') ||
        /^(?:appt|booking)-confirm-/.test(idNodo) ||
        /^camping-/.test(idNodo);
      const isFlowFollowUp = !isReminderOrConfirm;
      if (isFlowFollowUp && !(await this.isWithinSendWindow(effectiveUserId))) {
        await this.prisma.seguimiento.updateMany({
          where: { id: seguimiento.id, followUpStatus: 'processing' },
          data: { followUpStatus: 'pending' },
        });
        summary.skipped++;
        // DEBUG (no LOG): esta línea se emitía por cada seguimiento fuera de horario
        // (~178 por corrida, ~350/min) y tapaba todo lo demás en producción. El conteo
        // ya queda en el resumen por corrida del scheduler (due=/sent=/skipped=).
        // Se deja en DEBUG para poder reactivarla puntualmente al depurar.
        this.logger.debug(
          `${loggerCtx} fuera de la ventana de envío de la cuenta → pospuesto.`,
          'FollowUpRunnerService',
        );
        continue;
      }

      try {
        const finalMessage = await this.resolveFollowUpMessage(
          seguimiento,
          session ?? {
            id: 0,
            userId: effectiveUserId,
            pushName: null,
            remoteJid: effectiveRemoteJid,
          },
        );

        if (await this.shouldAbortFollowUp(seguimiento.id)) {
          summary.skipped++;
          continue;
        }

        await this.sendSeguimiento(
          seguimiento,
          finalMessage,
          effectiveRemoteJid,
        );

        // Marca el recordatorio como enviado (evidencia en la tabla Reminders).
        await this.markReminderSentIfApplicable(seguimiento.idNodo);

        // Si el recordatorio tiene un workflow asignado y hay sesión, ejecutarlo
        if (session) {
          await this.tryExecuteReminderWorkflow(seguimiento, {
            userId: session.userId,
            remoteJid: session.remoteJid,
            instanceId: session.instanceId,
          });
        }

        if (finalMessage.trim()) {
          const sessionHistoryId = buildChatHistorySessionId(
            seguimiento.instancia ?? '',
            effectiveRemoteJid,
          );
          await this.chatHistoryService.saveMessage(
            sessionHistoryId,
            finalMessage,
            'ia',
          );
        }

        await this.markSent(
          seguimiento.id,
          {
            userId: effectiveUserId,
            remoteJid: effectiveRemoteJid,
            instanceId: effectiveInstanceId,
          },
          finalMessage.trim(),
        );
        summary.sent++;
      } catch (error: any) {
        this.logger.error(
          `${loggerCtx} error procesando follow-up.`,
          error?.message || error,
          'FollowUpRunnerService',
        );
        await this.markFailure(
          seguimiento,
          session
            ? {
                userId: session.userId,
                remoteJid: session.remoteJid,
                instanceId: session.instanceId,
              }
            : {
                userId: effectiveUserId,
                remoteJid: effectiveRemoteJid,
                instanceId: effectiveInstanceId,
              },
          error?.message || String(error),
        );
        summary.failed++;
      }
    }

    return summary;
  }
}
