import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AppointmentStatus, LeadStatus, StageActionType } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';
import { NodeSenderService } from 'src/modules/workflow/services/node-sender.service.ts/node-sender.service';
import { WorkflowService } from 'src/modules/workflow/services/workflow.service.ts/workflow.service';

const ADMIN_USER_ID = process.env.ADMIN_USER_ID ?? 'cm842kthc0000qd2l66nbnytv';

interface ExecCtx {
  sessionId: number;
  userId: string;
  remoteJid: string;
  serverUrl: string;
  instanceName: string;
  apikey: string;
}

function normalizeBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

@Injectable()
export class StageAutomationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
    private readonly nodeSenderService: NodeSenderService,
    private readonly workflowService: WorkflowService,
    private readonly http: HttpService,
  ) {}

  /** Construye el contexto de envío (instancia WhatsApp) para una sesión. */
  private async buildCtx(sessionId: number): Promise<ExecCtx | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        userId: true,
        remoteJid: true,
        user: {
          select: {
            apiKey: { select: { url: true, key: true } },
            instancias: {
              where: { instanceType: 'Whatsapp' },
              select: { instanceName: true, instanceId: true },
              take: 1,
            },
          },
        },
      },
    });

    if (!session) return null;

    const instance = session.user?.instancias[0];
    const serverUrl = session.user?.apiKey?.url?.trim();
    if (!instance || !serverUrl) {
      this.logger.warn(`[StageAutomation] Sin instancia para userId=${session.userId}`, 'StageAutomationService');
      return null;
    }

    // Apikey de Evolution: es la clave del ApiKey del owner (misma que usa el
    // resto del backend para autenticar contra Evolution, p. ej. instances.service),
    // NO el instanceId (un UUID de la instancia, que Evolution rechaza con 401 →
    // los envíos del flujo lanzado por automatización fallaban aunque la instancia
    // estuviera conectada). Fallback a instanceId por compatibilidad si faltara la clave.
    const apikey = session.user?.apiKey?.key?.trim() || instance.instanceId;

    return {
      sessionId,
      userId: session.userId,
      remoteJid: session.remoteJid,
      serverUrl: normalizeBase(serverUrl),
      instanceName: instance.instanceName,
      apikey,
    };
  }

  /** Ejecuta las acciones de un conjunto de automatizaciones sobre un contexto. */
  private async runAutomations(
    automations: { actions: { type: StageActionType; config: unknown; delayMinutes: number }[] }[],
    ctx: ExecCtx,
  ): Promise<void> {
    for (const automation of automations) {
      for (const action of automation.actions) {
        if (action.delayMinutes > 0) {
          setTimeout(() => void this.runAction(action, ctx), action.delayMinutes * 60_000);
        } else {
          await this.runAction(action, ctx);
        }
      }
    }
  }

  async executeForSession(sessionId: number, newStage: LeadStatus): Promise<void> {
    const ctx = await this.buildCtx(sessionId);
    if (!ctx) return;

    const automations = await this.prisma.stageAutomation.findMany({
      where: { userId: ctx.userId, stage: newStage, enabled: true },
      include: { actions: { orderBy: { order: 'asc' } } },
    });

    if (automations.length === 0) return;

    this.logger.log(
      `[StageAutomation] ${automations.length} automacion(es) para stage=${newStage} session=${sessionId}`,
      'StageAutomationService',
    );

    await this.runAutomations(automations, ctx);
  }

  /**
   * Ejecuta las automatizaciones configuradas para un asesor cuando se le
   * asigna (auto o manual) un contacto. Incluye las que aplican a "cualquier
   * asesor" (advisorId = null). Idempotencia: se dispara sólo con el asesor recibido.
   */
  async executeForAdvisor(sessionId: number, advisorId: string): Promise<void> {
    if (!advisorId) return;
    const ctx = await this.buildCtx(sessionId);
    if (!ctx) return;

    const automations = await this.prisma.advisorAutomation.findMany({
      where: {
        userId: ctx.userId,
        enabled: true,
        OR: [{ advisorId }, { advisorId: null }],
      },
      include: { actions: { orderBy: { order: 'asc' } } },
    });

    if (automations.length === 0) return;

    this.logger.log(
      `[AdvisorAutomation] ${automations.length} automacion(es) para advisor=${advisorId} session=${sessionId}`,
      'StageAutomationService',
    );

    await this.runAutomations(automations, ctx);
  }

  /**
   * Ejecuta las automatizaciones de una etiqueta cuando se asigna a un contacto.
   * Incluye las de "cualquier etiqueta" (tagId = null).
   */
  async executeForTag(sessionId: number, tagId: number): Promise<void> {
    if (!tagId) return;
    const ctx = await this.buildCtx(sessionId);
    if (!ctx) return;

    const automations = await this.prisma.tagAutomation.findMany({
      where: {
        userId: ctx.userId,
        enabled: true,
        OR: [{ tagId }, { tagId: null }],
      },
      include: { actions: { orderBy: { order: 'asc' } } },
    });

    if (automations.length === 0) return;

    this.logger.log(
      `[TagAutomation] ${automations.length} automacion(es) para tag=${tagId} session=${sessionId}`,
      'StageAutomationService',
    );

    await this.runAutomations(automations, ctx);
  }

  /** Ejecuta las automatizaciones de una cita cuando cambia a un estado. */
  async executeForAppt(sessionId: number, apptStatus: AppointmentStatus): Promise<void> {
    if (!apptStatus) return;
    const ctx = await this.buildCtx(sessionId);
    if (!ctx) return;

    const automations = await this.prisma.apptAutomation.findMany({
      where: { userId: ctx.userId, apptStatus, enabled: true },
      include: { actions: { orderBy: { order: 'asc' } } },
    });

    if (automations.length === 0) return;

    this.logger.log(
      `[ApptAutomation] ${automations.length} automacion(es) para status=${apptStatus} session=${sessionId}`,
      'StageAutomationService',
    );

    await this.runAutomations(automations, ctx);
  }

  /** Ejecuta las automatizaciones de un tipo de tarea cuando se crea una tarea de ese tipo. */
  async executeForTaskType(sessionId: number, taskType: string): Promise<void> {
    if (!taskType) return;
    const ctx = await this.buildCtx(sessionId);
    if (!ctx) return;

    const automations = await this.prisma.taskTypeAutomation.findMany({
      where: { userId: ctx.userId, taskType, enabled: true },
      include: { actions: { orderBy: { order: 'asc' } } },
    });

    if (automations.length === 0) return;

    this.logger.log(
      `[TaskTypeAutomation] ${automations.length} automacion(es) para taskType=${taskType} session=${sessionId}`,
      'StageAutomationService',
    );

    await this.runAutomations(automations, ctx);
  }

  /**
   * Ejecuta las automatizaciones de grupo de recordatorio cuando un recordatorio
   * se ejecuta/envía. El contexto se arma desde el propio recordatorio (no hay
   * sessionId garantizado): se resuelve la sesión por remoteJid+userId para las
   * acciones que la requieren; las de solo envío (mensaje/flujo/archivo) no la necesitan.
   */
  async executeForReminderGroup(params: {
    userId: string;
    remoteJid: string;
    serverUrl: string;
    instanceName: string;
    apikey: string;
    groups: string[];
  }): Promise<void> {
    const { userId, remoteJid, serverUrl, instanceName, apikey, groups } = params;
    if (!userId || !remoteJid || !instanceName || !serverUrl || !groups?.length) return;

    const automations = await this.prisma.reminderGroupAutomation.findMany({
      where: { userId, reminderGroup: { in: groups }, enabled: true },
      include: { actions: { orderBy: { order: 'asc' } } },
    });

    if (automations.length === 0) return;

    // Resolver sessionId por contacto (para acciones que mutan la sesión)
    const session = await this.prisma.session.findFirst({
      where: { remoteJid, userId },
      select: { id: true },
    });

    const ctx: ExecCtx = {
      sessionId: session?.id ?? 0,
      userId,
      remoteJid,
      serverUrl: normalizeBase(serverUrl),
      instanceName,
      apikey,
    };

    this.logger.log(
      `[ReminderGroupAutomation] ${automations.length} automacion(es) para grupos=${groups.join(',')} remoteJid=${remoteJid}`,
      'StageAutomationService',
    );

    await this.runAutomations(automations, ctx);
  }

  private async runAction(action: { type: StageActionType; config: unknown }, ctx: ExecCtx): Promise<void> {
    const cfg = action.config as Record<string, unknown>;
    try {
      switch (action.type) {
        case StageActionType.TAG_ADD:         await this.doTagAdd(cfg, ctx); break;
        case StageActionType.TAG_REMOVE:      await this.doTagRemove(cfg, ctx); break;
        case StageActionType.TASK:            await this.doTask(cfg, ctx); break;
        case StageActionType.ASSIGN:          await this.doAssign(cfg, ctx); break;
        case StageActionType.EXECUTE_FLOW:    await this.doExecuteFlow(cfg, ctx); break;
        case StageActionType.MESSAGE:         await this.doMessage(cfg, ctx); break;
        case StageActionType.REMINDER:        await this.doReminder(cfg, ctx); break;
        case StageActionType.NOTIFY_ADVISOR:  await this.doNotifyAdvisor(cfg, ctx); break;
        case StageActionType.TOGGLE_AI:       await this.doToggleAi(cfg, ctx); break;
        case StageActionType.SEND_FILE:       await this.doSendFile(cfg, ctx); break;
        case StageActionType.WEBHOOK:         await this.doWebhook(cfg, ctx); break;
        case StageActionType.CHANGE_STATUS:   await this.doChangeStatus(cfg, ctx); break;
      }
    } catch (err: any) {
      this.logger.error(
        `[StageAutomation] Error en acción ${action.type} session=${ctx.sessionId}`,
        err?.message,
        'StageAutomationService',
      );
    }
  }

  private async doTagAdd(cfg: Record<string, unknown>, ctx: ExecCtx) {
    const tagId = Number(cfg.tagId);
    await this.prisma.sessionTag.upsert({
      where: { sessionId_tagId: { sessionId: ctx.sessionId, tagId } },
      create: { sessionId: ctx.sessionId, tagId },
      update: {},
    });
    this.logger.log(`[StageAutomation] TAG_ADD tagId=${tagId} session=${ctx.sessionId}`, 'StageAutomationService');
  }

  private async doTagRemove(cfg: Record<string, unknown>, ctx: ExecCtx) {
    const tagId = Number(cfg.tagId);
    await this.prisma.sessionTag.deleteMany({ where: { sessionId: ctx.sessionId, tagId } });
    this.logger.log(`[StageAutomation] TAG_REMOVE tagId=${tagId} session=${ctx.sessionId}`, 'StageAutomationService');
  }

  private async doTask(cfg: Record<string, unknown>, ctx: ExecCtx) {
    const title = String(cfg.title ?? 'Tarea');
    const description = cfg.description ? String(cfg.description) : undefined;
    const advisorId = cfg.advisorId ? String(cfg.advisorId) : undefined;

    const targetId = advisorId ?? ctx.userId;
    const advisor = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { notificationNumber: true },
    });
    if (!advisor?.notificationNumber) return;

    const text = `📋 *Nueva tarea*\n\n*${title}*${description ? `\n\n${description}` : ''}\n\n_Contacto: ${ctx.remoteJid}_`;
    const sender = await this.getAdminSender();
    if (!sender) return;
    const sendUrl = `${sender.serverUrl}/message/sendText/${encodeURIComponent(sender.instanceName)}`;
    await this.nodeSenderService.sendTextNode(sendUrl, sender.apikey, advisor.notificationNumber, text);
    this.logger.log(`[StageAutomation] TASK notificado targetId=${targetId}`, 'StageAutomationService');
  }

  private async doAssign(cfg: Record<string, unknown>, ctx: ExecCtx) {
    const advisorId = String(cfg.advisorId);
    await this.prisma.session.update({
      where: { id: ctx.sessionId },
      data: { assignedAdvisorId: advisorId },
    });
    this.logger.log(`[StageAutomation] ASSIGN advisorId=${advisorId} session=${ctx.sessionId}`, 'StageAutomationService');
  }

  private async doExecuteFlow(cfg: Record<string, unknown>, ctx: ExecCtx) {
    const workflowName = String(cfg.workflowName);
    const sendUrl = `${ctx.serverUrl}/message/sendText/${encodeURIComponent(ctx.instanceName)}`;
    await this.workflowService.executeWorkflow(
      workflowName, sendUrl, ctx.apikey, ctx.instanceName, ctx.remoteJid, ctx.userId,
    );
    this.logger.log(`[StageAutomation] EXECUTE_FLOW workflow=${workflowName} session=${ctx.sessionId}`, 'StageAutomationService');
  }

  private async doMessage(cfg: Record<string, unknown>, ctx: ExecCtx) {
    const text = String(cfg.text ?? '');
    if (!text) return;
    const sendUrl = `${ctx.serverUrl}/message/sendText/${encodeURIComponent(ctx.instanceName)}`;
    await this.nodeSenderService.sendTextNode(sendUrl, ctx.apikey, ctx.remoteJid, text);
    this.logger.log(`[StageAutomation] MESSAGE enviado session=${ctx.sessionId}`, 'StageAutomationService');
  }

  private async doReminder(cfg: Record<string, unknown>, ctx: ExecCtx) {
    const text = String(cfg.text ?? '');
    const delayMin = Number(cfg.delayMinutes ?? 0);
    const scheduledFor = new Date(Date.now() + delayMin * 60_000);
    await this.prisma.reminders.create({
      data: {
        title: 'Recordatorio automático',
        description: text,
        serverUrl: ctx.serverUrl,
        instanceName: ctx.instanceName,
        apikey: ctx.apikey,
        remoteJid: ctx.remoteJid,
        userId: ctx.userId,
        isSchedule: true,
        time: scheduledFor.toISOString(),
      },
    });
    this.logger.log(`[StageAutomation] REMINDER programado at=${scheduledFor.toISOString()} session=${ctx.sessionId}`, 'StageAutomationService');
  }

  private async doNotifyAdvisor(cfg: Record<string, unknown>, ctx: ExecCtx) {
    const message = cfg.message ? String(cfg.message) : undefined;
    const session = await this.prisma.session.findUnique({
      where: { id: ctx.sessionId },
      select: { assignedAdvisorId: true },
    });
    const advisorId = session?.assignedAdvisorId ?? ctx.userId;
    const advisor = await this.prisma.user.findUnique({
      where: { id: advisorId },
      select: { notificationNumber: true },
    });
    if (!advisor?.notificationNumber) return;

    const text = message ?? `🔔 El lead *${ctx.remoteJid}* cambió de etapa.`;
    const sender = await this.getAdminSender();
    if (!sender) return;
    const sendUrl = `${sender.serverUrl}/message/sendText/${encodeURIComponent(sender.instanceName)}`;
    await this.nodeSenderService.sendTextNode(sendUrl, sender.apikey, advisor.notificationNumber, text);
    this.logger.log(`[StageAutomation] NOTIFY_ADVISOR notificado ${advisor.notificationNumber}`, 'StageAutomationService');
  }

  private async doToggleAi(cfg: Record<string, unknown>, ctx: ExecCtx) {
    const enabled = Boolean(cfg.enabled);
    await this.prisma.session.update({
      where: { id: ctx.sessionId },
      data: { agentDisabled: !enabled },
    });
    this.logger.log(`[StageAutomation] TOGGLE_AI enabled=${enabled} session=${ctx.sessionId}`, 'StageAutomationService');
  }

  private async doSendFile(cfg: Record<string, unknown>, ctx: ExecCtx) {
    const fileUrl = String(cfg.fileUrl ?? '');
    if (!fileUrl) return;
    const caption = cfg.caption ? String(cfg.caption) : '';
    const fileName = cfg.fileName ? String(cfg.fileName) : 'archivo';
    const sendUrl = `${ctx.serverUrl}/message/sendMedia/${encodeURIComponent(ctx.instanceName)}`;
    try {
      await firstValueFrom(
        this.http.post(sendUrl, {
          number: ctx.remoteJid,
          mediatype: 'document',
          media: fileUrl,
          caption,
          fileName,
        }, { headers: { apikey: ctx.apikey } }),
      );
      this.logger.log(`[StageAutomation] SEND_FILE enviado session=${ctx.sessionId}`, 'StageAutomationService');
    } catch (err: any) {
      this.logger.error(`[StageAutomation] SEND_FILE error`, err?.message, 'StageAutomationService');
    }
  }

  private async doWebhook(cfg: Record<string, unknown>, ctx: ExecCtx) {
    const url = String(cfg.url ?? '');
    if (!url) return;
    const method = String(cfg.method ?? 'POST');
    const headers = (cfg.headers as Record<string, string>) ?? {};
    const body = (cfg.body as Record<string, unknown>) ?? {};
    const payload = { ...body, sessionId: ctx.sessionId, remoteJid: ctx.remoteJid, userId: ctx.userId };
    try {
      await firstValueFrom(this.http.request({ method, url, headers, data: payload }));
      this.logger.log(`[StageAutomation] WEBHOOK enviado url=${url} session=${ctx.sessionId}`, 'StageAutomationService');
    } catch (err: any) {
      this.logger.error(`[StageAutomation] WEBHOOK error url=${url}`, err?.message, 'StageAutomationService');
    }
  }

  private async doChangeStatus(cfg: Record<string, unknown>, ctx: ExecCtx) {
    const status = String(cfg.status) as LeadStatus;
    await this.prisma.session.update({
      where: { id: ctx.sessionId },
      data: { leadStatus: status, leadStatusUpdatedAt: new Date(), leadStatusSourceHash: null },
    });
    this.logger.log(`[StageAutomation] CHANGE_STATUS status=${status} session=${ctx.sessionId}`, 'StageAutomationService');
  }

  private async getAdminSender() {
    const admin = await this.prisma.user.findUnique({
      where: { id: ADMIN_USER_ID },
      include: {
        apiKey: { select: { url: true } },
        instancias: {
          where: { instanceType: 'Whatsapp' },
          select: { instanceName: true, instanceId: true },
          take: 1,
        },
      },
    });
    const instance = admin?.instancias[0];
    const url = admin?.apiKey?.url?.trim();
    if (!instance || !url) return null;
    return { serverUrl: normalizeBase(url), instanceName: instance.instanceName, apikey: instance.instanceId };
  }
}
