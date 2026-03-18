import { Injectable } from '@nestjs/common';
import { Seguimiento } from '@prisma/client';

import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { AiAgentService } from 'src/modules/ai-agent/ai-agent.service';
import { ChatHistoryService } from 'src/modules/chat-history/chat-history.service';
import { buildChatHistorySessionId } from 'src/modules/chat-history/chat-history-session.helper';
import { isLegacyWorkflowSeguimiento } from 'src/modules/seguimientos/legacy-workflow-follow-up.helper';
import { SessionService } from 'src/modules/session/session.service';
import { NodeSenderService } from 'src/modules/workflow/services/node-sender.service.ts/node-sender.service';
import { buildWhatsAppJidCandidates } from 'src/utils/whatsapp-jid.util';

@Injectable()
export class FollowUpRunnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
    private readonly aiAgentService: AiAgentService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly sessionService: SessionService,
    private readonly nodeSenderService: NodeSenderService,
  ) { }

  private clean(value?: string | null) {
    return (value ?? '').trim();
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
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private parseDelaySeconds(value?: string | null): number {
    const parsed = Number.parseInt((value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private isDue(seguimiento: Pick<Seguimiento, 'createdAt' | 'time'>) {
    const delaySeconds = this.parseDelaySeconds(seguimiento.time);
    return seguimiento.createdAt.getTime() + delaySeconds * 1000 <= Date.now();
  }

  private getTipoBase(tipo?: string | null) {
    const raw = (tipo ?? '').trim().toLowerCase();
    return raw.startsWith('seguimiento-') ? raw.replace('seguimiento-', '') : raw;
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
    session: { id: number; userId: string; pushName: string | null; remoteJid: string },
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
        fallbackMessage || 'Hola, sigo atento por si quieres retomar la conversacion.',
    });
  }

  private async sendSeguimiento(
    seguimiento: Seguimiento,
    finalMessage: string,
    targetRemoteJid?: string,
  ) {
    const serverUrl = (seguimiento.serverurl ?? '').trim();
    const instanceName = (seguimiento.instancia ?? '').trim();
    const remoteJid = this.clean(targetRemoteJid) || (seguimiento.remoteJid ?? '').trim();
    const apikey = (seguimiento.apikey ?? '').trim();
    const media = (seguimiento.media ?? '').trim();
    const tipoBase = this.getTipoBase(seguimiento.tipo);

    if (!serverUrl || !instanceName || !remoteJid || !apikey) {
      throw new Error('Seguimiento sin datos de conexion completos.');
    }

    if (tipoBase === 'text') {
      if (!finalMessage.trim()) throw new Error('Follow-up de texto sin mensaje final.');
      const ok = await this.nodeSenderService.sendTextNode(
        `${serverUrl}/message/sendText/${instanceName}`,
        apikey,
        remoteJid,
        finalMessage,
      );
      if (!ok) throw new Error('Error enviando follow-up de texto.');
      return;
    }

    if (['image', 'video', 'document'].includes(tipoBase)) {
      if (!media) throw new Error(`Follow-up ${tipoBase} sin media.`);
      const ok = await this.nodeSenderService.sendMediaNode(
        `${serverUrl}/message/sendMedia/${instanceName}`,
        apikey,
        remoteJid,
        tipoBase,
        finalMessage,
        media,
      );
      if (!ok) throw new Error(`Error enviando follow-up ${tipoBase}.`);
      return;
    }

    if (tipoBase === 'audio') {
      if (finalMessage.trim()) {
        const okText = await this.nodeSenderService.sendTextNode(
          `${serverUrl}/message/sendText/${instanceName}`,
          apikey,
          remoteJid,
          finalMessage,
        );
        if (!okText) throw new Error('Error enviando texto previo al audio.');
      }

      if (!media) throw new Error('Follow-up de audio sin media.');
      const okAudio = await this.nodeSenderService.sendAudioNode(
        `${serverUrl}/message/sendWhatsAppAudio/${instanceName}`,
        apikey,
        remoteJid,
        media,
      );
      if (!okAudio) throw new Error('Error enviando follow-up de audio.');
      return;
    }

    throw new Error(`Tipo de seguimiento no soportado: ${seguimiento.tipo ?? 'unknown'}`);
  }

  private async markSent(
    seguimientoId: number,
    sessionData: { userId: string; remoteJid: string; instanceId: string },
    finalMessage: string,
  ) {
    await this.prisma.seguimiento.update({
      where: { id: seguimientoId },
      data: {
        followUpStatus: 'sent',
        followUpAttempt: { increment: 1 },
        generatedMessage: finalMessage || null,
        errorReason: null,
        remoteJid: sessionData.remoteJid,
        instancia: sessionData.instanceId,
      },
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
    sessionData: { userId: string; remoteJid: string; instanceId: string } | null,
    errorReason?: string | null,
  ) {
    const nextAttempt = (seguimiento.followUpAttempt ?? 0) + 1;
    const maxAttempts = Math.max(seguimiento.followUpMaxAttempts ?? 1, 1);
    const nextStatus = nextAttempt >= maxAttempts ? 'failed' : 'pending';
    const normalizedErrorReason = (errorReason ?? '').trim().slice(0, 500);

    await this.prisma.seguimiento.update({
      where: { id: seguimiento.id },
      data: {
        followUpAttempt: nextAttempt,
        followUpStatus: nextStatus,
        errorReason: normalizedErrorReason || null,
        ...(sessionData
          ? {
              remoteJid: sessionData.remoteJid,
              instancia: sessionData.instanceId,
            }
          : {}),
      },
    });

    if (nextStatus === 'failed' && sessionData) {
      await this.sessionService.removeSeguimientosFromSession(
        [seguimiento.id],
        sessionData.remoteJid,
        sessionData.instanceId,
        sessionData.userId,
      );
    }
  }

  async cancelPendingFollowUpsOnReply(args: {
    userId: string;
    remoteJid: string;
    instanceName: string;
  }) {
    const { userId, remoteJid, instanceName } = args;
    const candidates = this.buildRemoteJidCandidates(remoteJid);
    const pending = await this.prisma.seguimiento.findMany({
      where: {
        remoteJid: { in: candidates },
        instancia: instanceName,
        followUpStatus: 'pending',
        followUpCancelOnReply: true,
      },
      select: { id: true, idNodo: true, tipo: true },
    });

    const legacyPending = pending.filter((item) =>
      this.isLegacyWorkflowFollowUp(item as Pick<Seguimiento, 'idNodo' | 'tipo'>),
    );

    if (!legacyPending.length) return { count: 0, ids: [] as number[] };

    const ids = legacyPending.map((item) => item.id);
    await this.prisma.seguimiento.updateMany({
      where: { id: { in: ids } },
      data: { followUpStatus: 'cancelled' },
    });

    await this.sessionService.removeSeguimientosFromSession(ids, remoteJid, instanceName, userId);
    return { count: ids.length, ids };
  }

  async processDueFollowUps(
    limit = 25,
    scope?: { userId?: string; instanceId?: string; remoteJid?: string },
  ) {
    const take = Math.max(limit * 4, 50);
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
        OR?: Array<{ remoteJid: { in: string[] } } | { remoteJidAlt: { in: string[] } }>;
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

      const sessionPairsMap = new Map<string, { remoteJid: string; instancia: string }>();
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

    const due = pending.filter((seguimiento) => this.isDue(seguimiento)).slice(0, limit);
    const summary = {
      scanned: pending.length,
      due: due.length,
      sent: 0,
      failed: 0,
      skipped: 0,
    };

    for (const current of due) {
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

      if (!session) {
        this.logger.warn(`${loggerCtx} sesion no encontrada.`, 'FollowUpRunnerService');
        await this.markFailure(seguimiento, null, 'Sesion no encontrada para ejecutar el follow-up.');
        summary.failed++;
        continue;
      }

      try {
        const finalMessage = await this.resolveFollowUpMessage(seguimiento, session);
        await this.sendSeguimiento(seguimiento, finalMessage, session.remoteJid);

        if (finalMessage.trim()) {
          const sessionHistoryId = buildChatHistorySessionId(
            seguimiento.instancia ?? '',
            session.remoteJid,
          );
          await this.chatHistoryService.saveMessage(sessionHistoryId, finalMessage, 'ia');
        }

        await this.markSent(
          seguimiento.id,
          {
            userId: session.userId,
            remoteJid: session.remoteJid,
            instanceId: session.instanceId,
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
        await this.markFailure(seguimiento, {
          userId: session.userId,
          remoteJid: session.remoteJid,
          instanceId: session.instanceId,
        }, error?.message || String(error));
        summary.failed++;
      }
    }

    return summary;
  }
}
