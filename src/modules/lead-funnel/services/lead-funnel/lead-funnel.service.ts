import { Injectable, Logger } from '@nestjs/common';
import { TipoRegistro } from '@prisma/client';

import { ClassifyMessageDto } from '../../dto/classify-message.dto';
import { LeadClassifierIaService } from '../lead-classifier-ia/lead-classifier-ia.service';
import { RegistroService } from '../registro/registro.service';
import { LeadStatusIaService } from '../lead-status-ia.service';
import { CrmFollowUpPlannerService } from '../crm-follow-up-planner.service';
import { CrmFollowUpRunnerService } from '../crm-follow-up-runner.service';

type LeadFunnelResult =
  | {
      ok: true;
      action: 'CREATED_REGISTRO';
      sessionDbId: number;
      tipo: TipoRegistro;
      estado?: string;
      registroId?: number;
      resumen?: string;
    }
  | {
      ok: true;
      action: 'UPDATED_SINTESIS';
      sessionDbId: number;
      sintesisLength: number;
    }
  | {
      ok: true;
      action: 'SKIPPED';
      reason: string;
      sessionDbId: number;
    }
  | {
      ok: false;
      action: 'ERROR';
      sessionDbId: number;
      step: 'CLASSIFY' | 'CREATE_REGISTRO' | 'UPDATE_SINTESIS';
      error: string;
    };

@Injectable()
export class LeadFunnelService {
  private readonly logger = new Logger(LeadFunnelService.name);

  constructor(
    private readonly classifier: LeadClassifierIaService,
    private readonly registroService: RegistroService,
    private readonly leadStatusIaService: LeadStatusIaService,
    private readonly crmFollowUpPlannerService: CrmFollowUpPlannerService,
    private readonly crmFollowUpRunnerService: CrmFollowUpRunnerService,
  ) {}

  async processIncomingText(input: ClassifyMessageDto): Promise<LeadFunnelResult> {
    const sessionDbId = input.sessionDbId;

    this.logger.debug(
      `[processIncomingText] start sessionDbId=${sessionDbId} userId=${input.userId} instanceId=${input.instanceId} remoteJid=${input.remoteJid}`,
    );
    this.logger.debug(`[processIncomingText] text="${(input.text ?? '').toString().slice(0, 180)}"`);

    try {
      await this.crmFollowUpRunnerService.cancelPendingOnReply({
        remoteJid: input.remoteJid,
        instanceId: input.instanceId,
      });
    } catch (cancelError: any) {
      this.logger.warn(
        `[CRM_FOLLOW_UP_CANCEL] sessionDbId=${sessionDbId} error=${cancelError?.message || cancelError}`,
      );
    }

    let result: any;
    try {
      this.logger.debug(`[CLASSIFY] calling classifier.classify() sessionDbId=${sessionDbId}`);
      result = await this.classifier.classify(input);
      this.logger.debug(`[CLASSIFY] result=${JSON.stringify(result)}`);
    } catch (err: any) {
      const msg = err?.message || String(err);
      this.logger.error(`[CLASSIFY] error sessionDbId=${sessionDbId}: ${msg}`, err?.stack || err);
      return {
        ok: false,
        action: 'ERROR',
        sessionDbId,
        step: 'CLASSIFY',
        error: msg,
      };
    }

    if (result.kind === 'REGISTRO' && result.tipo === 'REPORTE') {
      this.logger.debug(`[FIX] kind=REGISTRO tipo=REPORTE => treating as REPORTE sessionDbId=${sessionDbId}`);
      result = {
        kind: 'REPORTE',
        sintesis: result.sintesis ?? result.resumen ?? '',
      };
    }

    if (!result || !result.kind) {
      this.logger.debug(`[SKIP] classifier returned empty/invalid result sessionDbId=${sessionDbId}`);
      return {
        ok: true,
        action: 'SKIPPED',
        sessionDbId,
        reason: 'CLASSIFIER_EMPTY_OR_INVALID',
      };
    }

    if (result.kind === 'REGISTRO') {
      if (!result.tipo) {
        this.logger.debug(`[SKIP] kind=REGISTRO but tipo missing sessionDbId=${sessionDbId}`);
        return {
          ok: true,
          action: 'SKIPPED',
          sessionDbId,
          reason: 'REGISTRO_MISSING_TIPO',
        };
      }

      const payload = {
        sessionId: sessionDbId,
        tipo: result.tipo as TipoRegistro,
        estado: result.estado,
        resumen: result.resumen,
        detalles: result.detalles,
        lead: result.lead,
        nombre: result.nombre,
        meta: result.meta,
        fecha: new Date(),
      };

      this.logger.debug(`[CREATE_REGISTRO] payload=${JSON.stringify(payload)}`);

      try {
        const created = await this.registroService.createRegistro(payload as any);

        if (!created.ok) {
          this.logger.error(`[CREATE_REGISTRO] failed sessionDbId=${sessionDbId} error=${created.error}`);
          return {
            ok: false,
            action: 'ERROR',
            sessionDbId,
            step: 'CREATE_REGISTRO',
            error: created.error,
          };
        }

        this.logger.debug(
          `[CREATE_REGISTRO] success sessionDbId=${sessionDbId} registroId=${created.registroId}`,
        );
        this.logger.log(`Registro creado: tipo=${payload.tipo} estado=${payload.estado ?? '-'} sessionId=${sessionDbId}`);

        return {
          ok: true,
          action: 'CREATED_REGISTRO',
          sessionDbId,
          tipo: payload.tipo,
          estado: payload.estado,
          registroId: created.registroId,
          resumen: payload.resumen,
        };
      } catch (err: any) {
        const msg = err?.message || String(err);
        this.logger.error(`[CREATE_REGISTRO] exception sessionDbId=${sessionDbId}: ${msg}`, err?.stack || err);
        return {
          ok: false,
          action: 'ERROR',
          sessionDbId,
          step: 'CREATE_REGISTRO',
          error: msg,
        };
      }
    }

    const sintesis = result.sintesis ?? result.resumen ?? '';
    if (!sintesis || !sintesis.trim()) {
      this.logger.debug(`[SKIP] kind=REPORTE but sintesis empty sessionDbId=${sessionDbId}`);
      return {
        ok: true,
        action: 'SKIPPED',
        sessionDbId,
        reason: 'REPORTE_EMPTY_SINTESIS',
      };
    }

    this.logger.debug(`[UPDATE_SINTESIS] sessionDbId=${sessionDbId} sintesisLength=${sintesis.length}`);

    try {
      await this.registroService.upsertReporte(sessionDbId, sintesis);
      this.logger.debug(`[UPDATE_SINTESIS] success sessionDbId=${sessionDbId}`);

      try {
        const leadStatusResult = await this.leadStatusIaService.refreshFromLatestReporte({
          sessionId: sessionDbId,
          userId: input.userId,
        });

        if (leadStatusResult.applied) {
          await this.crmFollowUpPlannerService.syncFromLeadStatus({
            sessionId: sessionDbId,
            userId: input.userId,
            leadStatus: leadStatusResult.leadStatus,
            summary: leadStatusResult.summary,
            sourceHash: leadStatusResult.sourceHash,
            sourceReportId: leadStatusResult.sourceReportId,
          });
        }
      } catch (leadStatusError: any) {
        this.logger.warn(
          `[LEAD_STATUS] sessionDbId=${sessionDbId} error=${leadStatusError?.message || leadStatusError}`,
        );
      }

      this.logger.log(`Sintesis actualizada sessionId=${sessionDbId}`);

      return {
        ok: true,
        action: 'UPDATED_SINTESIS',
        sessionDbId,
        sintesisLength: sintesis.length,
      };
    } catch (err: any) {
      const msg = err?.message || String(err);
      this.logger.error(`[UPDATE_SINTESIS] error sessionDbId=${sessionDbId}: ${msg}`, err?.stack || err);
      return {
        ok: false,
        action: 'ERROR',
        sessionDbId,
        step: 'UPDATE_SINTESIS',
        error: msg,
      };
    }
  }
}
