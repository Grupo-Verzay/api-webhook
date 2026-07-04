import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { SessionService } from 'src/modules/session/session.service';
import { SessionTriggerService } from 'src/modules/session-trigger/session-trigger.service';
import { AutoAssignService } from '../auto-assign/auto-assign.service';
import { getReactivateDate, UserWithPausar } from 'src/types/open-ai';

@Injectable()
export class SessionOrchestrationService {
  constructor(
    private readonly logger: LoggerService,
    private readonly sessionService: SessionService,
    private readonly sessionTriggerService: SessionTriggerService,
    private readonly autoAssignService: AutoAssignService,
  ) {}

  private scopedLogger(ctx: {
    userId?: string;
    instanceName?: string;
    remoteJid?: string;
  }) {
    const tag = `[UID=${ctx.userId ?? '-'}][I=${ctx.instanceName ?? '-'}][R=${ctx.remoteJid ?? '-'}]`;
    return {
      log: (msg: string, context = 'SessionOrchestrationService') =>
        this.logger.log(`${tag} ${msg}`, context),
      debug: (msg: string) =>
        this.logger.debug(`${tag} ${msg}`, 'SessionOrchestrationService'),
      warn: (msg: string, context = 'SessionOrchestrationService') =>
        this.logger.warn(`${tag} ${msg}`, context),
      error: (msg: string, err?: any, context = 'SessionOrchestrationService') =>
        this.logger.error(`${tag} ${msg}`, err, context),
    };
  }

  private async getReactivateDate({
    userWithRelations,
  }: getReactivateDate): Promise<string | null> {
    const logger = this.scopedLogger({ userId: userWithRelations?.id });
    if (!userWithRelations) {
      logger.error('Se esperaba el userWithRelations para reactivar el chat.');
      return null;
    }

    const minutesToReactivate = parseInt(userWithRelations.autoReactivate ?? '');
    if (isNaN(minutesToReactivate)) {
      logger.error(`Valor inválido para autoReactivate: "${userWithRelations.autoReactivate}"`);
      return null;
    }

    const futureDate = new Date(Date.now() + minutesToReactivate * 60000);
    return futureDate.toISOString();
  }

  async checkOrRegisterSession(
    remoteJid: string,
    instanceName: string,
    userId: string,
    pushName: string,
    userWithRelations: UserWithPausar,
    remoteJidAlt?: string,
    senderPn?: string,
  ): Promise<{ status: boolean; canonicalRemoteJid: string }> {
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // 1) Intentar con el JID principal (prioriza @s.whatsapp.net)
    let session = await this.sessionService.getSession(remoteJid, instanceName, userId);

    // 2) Si no existe y hay alternativo (ej: @lid), intentar con él
    if (!session && remoteJidAlt && remoteJidAlt !== remoteJid) {
      const sessionAlt = await this.sessionService.getSession(remoteJidAlt, instanceName, userId);

      if (sessionAlt) {
        logger.log(`[SESSION] Usuario ya registrado con JID alternativo: ${remoteJidAlt}`);

        if (sessionAlt.remoteJid !== remoteJid) {
          try {
            await this.sessionService.updateSessionRemoteJid(sessionAlt.id, remoteJid);
            logger.log(`[SESSION] remoteJid actualizado de ${sessionAlt.remoteJid} → ${remoteJid}`);
            sessionAlt.remoteJid = remoteJid;
          } catch (error) {
            logger.error('Error actualizando remoteJid de la sesión', error);
          }
        }

        session = sessionAlt;
      }
    }

    if (session) {
      if (
        session.remoteJid !== remoteJid ||
        ((session.remoteJidAlt ?? '') !== (remoteJidAlt ?? '') && Boolean(remoteJidAlt))
      ) {
        try {
          session = await this.sessionService.registerSession(
            userId, remoteJid, pushName, instanceName, remoteJidAlt, senderPn,
          );
        } catch (error) {
          logger.error('Error normalizando la sesión existente.', error);
        }
      }

      logger.log(`[SESSION] Usuario ya registrado: ${session.remoteJid}`);

      // Retry auto-assign si la sesión existe pero aún no tiene asesor asignado
      if (!session.assignedAdvisorId) {
        void this.autoAssignService.tryAssign(session.id, userId, session.remoteJid, instanceName);
      }

      const hasTrigger = await this.sessionTriggerService.findBySessionId(session.id.toString());
      const dateReactivate = await this.getReactivateDate({ userWithRelations });

      if (!hasTrigger) {
        if (dateReactivate) {
          await this.sessionTriggerService.create(session.id.toString(), dateReactivate);
          logger.log(`[TRIGGER] Reactivación programada para: ${dateReactivate}`);
        }
      } else {
        if (dateReactivate) {
          await this.sessionTriggerService.updateTimeBySessionId(session.id.toString(), dateReactivate);
          logger.log(`[TRIGGER] Fecha actualizada a: ${dateReactivate}`);
        }
      }

      return { status: session.status, canonicalRemoteJid: session.remoteJid };
    }

    // 3) Registrar usando el canon
    const newSession = await this.sessionService.registerSession(
      userId, remoteJid, pushName, instanceName, remoteJidAlt, senderPn,
    );
    logger.log(`✅ Registro exitoso para ${remoteJid}`);

    void this.autoAssignService.tryAssign(newSession.id, userId, remoteJid, instanceName);

    return { status: true, canonicalRemoteJid: remoteJid };
  }
}
