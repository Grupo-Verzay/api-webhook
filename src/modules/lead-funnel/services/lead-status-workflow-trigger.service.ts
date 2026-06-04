import { Injectable, Logger } from '@nestjs/common';
import { LeadStatus } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { WorkflowService } from 'src/modules/workflow/services/workflow.service.ts/workflow.service';

@Injectable()
export class LeadStatusWorkflowTriggerService {
  private readonly logger = new Logger(LeadStatusWorkflowTriggerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workflowService: WorkflowService,
  ) {}

  async triggerForLeadStatus(args: {
    sessionId: number;
    userId: string;
    leadStatus: LeadStatus;
  }): Promise<void> {
    const { sessionId, userId, leadStatus } = args;

    // 1. Buscar configuración de flujo para este estado
    const config = await this.prisma.leadStatusWorkflowConfig.findUnique({
      where: { userId_leadStatus: { userId, leadStatus } },
      include: { workflow: { select: { id: true, name: true } } },
    });

    if (!config) return; // No hay flujo configurado para este estado

    // 2. Verificar si ya se ejecutó este estado para esta sesión (disparo único)
    const alreadyExecuted = await this.prisma.leadStatusWorkflowExecution.findUnique({
      where: { sessionId_leadStatus: { sessionId, leadStatus } },
    });

    if (alreadyExecuted) {
      this.logger.debug(
        `[LEAD_WORKFLOW] Estado ${leadStatus} ya fue disparado para sesión ${sessionId}. Omitiendo.`,
      );
      return;
    }

    // 3. Cargar datos de la sesión e instancia
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        remoteJid: true,
        pushName: true,
        instanceId: true,
      },
    });

    if (!session) {
      this.logger.warn(`[LEAD_WORKFLOW] Sesión ${sessionId} no encontrada.`);
      return;
    }

    const instancia = await this.prisma.instancia.findFirst({
      where: { instanceId: session.instanceId },
      select: {
        instanceName: true,
        serverUrl: true,
        apikey: true,
      },
    });

    if (!instancia?.serverUrl || !instancia?.apikey) {
      this.logger.warn(
        `[LEAD_WORKFLOW] Sin credenciales de instancia para sesión ${sessionId}.`,
      );
      return;
    }

    // 4. Cancelar Seguimientos pendientes de esta sesión (mensajes del flujo anterior)
    await this.cancelPendingFollowUps(session.remoteJid, sessionId);

    // 5. Registrar ejecución ANTES de disparar (evita doble disparo ante fallos parciales)
    await this.prisma.leadStatusWorkflowExecution.create({
      data: { sessionId, userId, leadStatus, workflowId: config.workflowId },
    });

    // 6. Disparar el flujo
    try {
      await this.workflowService.executeWorkflow(
        config.workflow.name,
        instancia.serverUrl,
        instancia.apikey,
        instancia.instanceName,
        session.remoteJid,
        userId,
        undefined,
        session.pushName ?? undefined,
      );
      this.logger.log(
        `[LEAD_WORKFLOW] Flujo "${config.workflow.name}" disparado para ${session.remoteJid} → ${leadStatus}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[LEAD_WORKFLOW] Error ejecutando flujo "${config.workflow.name}": ${err?.message}`,
      );
    }
  }

  private async cancelPendingFollowUps(remoteJid: string, sessionId: number): Promise<void> {
    try {
      // Cancelar Seguimientos pendientes (mensajes programados del flujo anterior)
      const cancelled = await this.prisma.seguimiento.updateMany({
        where: { remoteJid, followUpStatus: 'pending' },
        data: { followUpStatus: 'failed' },
      });

      // Cancelar CrmFollowUps pendientes de esta sesión
      const cancelledCrm = await this.prisma.crmFollowUp.updateMany({
        where: { sessionId, status: 'PENDING' },
        data: { status: 'FAILED' },
      });

      if (cancelled.count > 0 || cancelledCrm.count > 0) {
        this.logger.log(
          `[LEAD_WORKFLOW] Cancelados ${cancelled.count} seguimientos y ${cancelledCrm.count} CRM follow-ups para ${remoteJid}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(`[LEAD_WORKFLOW] Error cancelando follow-ups: ${err?.message}`);
    }
  }
}
