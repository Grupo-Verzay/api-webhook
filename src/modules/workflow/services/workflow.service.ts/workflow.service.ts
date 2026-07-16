import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { NodeSenderService } from '../node-sender.service.ts/node-sender.service';
import { LoggerService } from 'src/core/logger/logger.service';
import { convertDelayToSeconds } from 'src/modules/webhook/utils/convert-delay-to-seconds.helper';
import { Session, StageActionType, WorkflowNode } from '@prisma/client';
import { SessionService } from 'src/modules/session/session.service';
import { SessionTriggerService } from 'src/modules/session-trigger/session-trigger.service';
import { PrismaService } from 'src/database/prisma.service';
import { ChatHistoryService } from '../../../chat-history/chat-history.service';
import { buildChatHistorySessionId } from '../../../chat-history/chat-history-session.helper';
import type { AiAgentService } from '../../../ai-agent/ai-agent.service';
import { NotificationContactsService } from 'src/modules/ai-agent/services/notificacionService/notification-contacts.service';
import { normalizeContactFieldsConfig } from '../contact-fields.helper';


type NodeDB = WorkflowNode;
type EdgeDB = {
  sourceId: string;
  targetId: string;
  sourceHandle: string | null;
};

/**
 * Contador de envíos de contenido de UNA ejecución de flujo (compartido entre
 * todos los nodos de esa corrida). Permite saber si el cliente realmente
 * recibió algo: si se intentó enviar y NADA salió (p. ej. instancia
 * desconectada), se omite el seguimiento de inactividad.
 */
type FlowSendTracker = { attempted: number; sent: number; failed: number };

type NodeExecCtx = {
  urlevo: string;
  apikey: string;
  instanceName: string;
  remoteJid: string;
  userId: string;
  pushName?: string;
  /**
   * Canal de la instancia ('evolution' | 'baileys' | 'meta' | 'telegram').
   * Se usa para enrutar el envío de los nodos al adaptador correcto. Para
   * meta/telegram, `urlevo` es el phoneNumberId/sentinel y `apikey` el token.
   */
  instanceType?: string;
  /**
   * Contador de envíos compartido en la corrida (mismo objeto en todos los
   * nodos). Lo alimenta `recordFlowSend`; lo consulta el nodo de seguimiento.
   */
  flowSend?: FlowSendTracker;
};

type RunNodeOptions = {
  timeoutLabel: string; // "nodo" | "nodo básico"
  logPauseDiagnostics?: boolean; // logs extra del pause (pro=true, basic=false)
  warnMissingSessionForSeguimiento?: boolean; // pro=true, basic=false
};

interface getSessionInterface {
  remoteJid: string;
  instanceName: string;
  userId: string;
}

/**
 * Nodos de automatización de /workflow -> StageActionType del motor de
 * automatizaciones. Debe mantenerse igual al AUTOMATION_NODE_TO_STAGE_ACTION del
 * frontend (types/workflow-node.ts). Estos nodos no envían nada al cliente:
 * su config viaja como JSON en WorkflowNode.message y se ejecuta reutilizando
 * los handlers de StageAutomationService (los mismos del Kanban).
 */
const AUTOMATION_TIPO_MAP: Record<string, StageActionType> = {
  'tag-add': StageActionType.TAG_ADD,
  'tag-remove': StageActionType.TAG_REMOVE,
  'assign-advisor': StageActionType.ASSIGN,
  'create-task': StageActionType.TASK,
  'notify-advisor': StageActionType.NOTIFY_ADVISOR,
  'change-status': StageActionType.CHANGE_STATUS,
  'toggle-ai': StageActionType.TOGGLE_AI,
  webhook: StageActionType.WEBHOOK,
  'ai-call': StageActionType.AI_CALL,
};
@Injectable()
export class WorkflowService implements OnModuleInit {
  private aiAgentService!: AiAgentService;
  private whatsAppSenderFactory!: any;
  private chatStore!: any;
  private externalClientDataService!: any;
  private googleSheetsService!: any;
  private stageAutomationService!: any;

  constructor(
    private prisma: PrismaService,
    private nodeSenderService: NodeSenderService,
    private logger: LoggerService,
    private sessionService: SessionService,
    private readonly sessionTriggerService: SessionTriggerService,
    private readonly moduleRef: ModuleRef,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly notificationContactsService: NotificationContactsService,
  ) {}

  onModuleInit() {
    const { AiAgentService } = require('../../../ai-agent/ai-agent.service');
    this.aiAgentService = this.moduleRef.get(AiAgentService, { strict: false });
    try {
      const { WhatsAppSenderFactory } = require('../../../whatsapp/whatsapp-sender.factory');
      this.whatsAppSenderFactory = this.moduleRef.get(WhatsAppSenderFactory, { strict: false });
    } catch {
      // WhatsApp module no disponible
    }
    try {
      const { ChatStoreService } = require('../../../webhook/services/chat-store/chat-store.service');
      this.chatStore = this.moduleRef.get(ChatStoreService, { strict: false });
    } catch {
      // Store unificado no disponible
    }
    try {
      const { ExternalClientDataService } = require('../../../external-client-data/external-client-data.service');
      this.externalClientDataService = this.moduleRef.get(ExternalClientDataService, { strict: false });
    } catch {
      // Módulo de datos externos no disponible
    }
    try {
      const { GoogleSheetsService } = require('../../../google-sheets/google-sheets.service');
      this.googleSheetsService = this.moduleRef.get(GoogleSheetsService, { strict: false });
    } catch {
      // Módulo de Google Sheets no disponible
    }
    try {
      const {
        StageAutomationService,
      } = require('../../../stage-automation/stage-automation.service');
      this.stageAutomationService = this.moduleRef.get(StageAutomationService, {
        strict: false,
      });
    } catch {
      // Módulo de automatizaciones no disponible (nodos de automatización serán no-op)
    }
  }

  /**
   * Resuelve el canal de una instancia por nombre. Devuelve 'evolution' por
   * defecto si no se encuentra.
   */
  private async resolveInstanceType(instanceName: string, userId: string): Promise<string> {
    try {
      const inst = await this.prisma.instancia.findFirst({
        where: { instanceName, userId },
        select: { instanceType: true },
      });
      return inst?.instanceType ?? 'evolution';
    } catch {
      return 'evolution';
    }
  }

  private isChannelType(instanceType?: string): boolean {
    return instanceType === 'meta' || instanceType === 'telegram';
  }

  /**
   * Envío de TEXTO de un nodo, enrutando por canal:
   * meta/telegram → adaptador de canal (usa urlevo=serverUrl/apikey=token);
   * baileys (sin urlevo) → adaptador baileys; en otro caso → Evolution API.
   */
  private async wfSendText(ctx: NodeExecCtx, remoteJid: string, text: string): Promise<boolean> {
    const t = (text ?? '').trim();
    if (!t) return true;
    const { instanceType, urlevo, apikey, instanceName } = ctx;
    const factory = this.whatsAppSenderFactory;
    if (this.isChannelType(instanceType) && factory) {
      return factory
        .getSenderSync(instanceType)
        .sendText(instanceName, remoteJid, t, urlevo, apikey)
        .then(() => true)
        .catch(() => false);
    }
    if (!urlevo && factory) {
      return factory
        .getSenderSync('baileys')
        .sendText(instanceName, remoteJid, t)
        .then(() => true)
        .catch(() => false);
    }
    // Evolution: capturamos el messageId REAL (sendTextNodeReturnId) para persistir
    // el saliente con el marcador { sentByAi: true } SIN duplicar: el eco/resync de
    // Evolution trae ese MISMO id y el ON CONFLICT lo dedupe (y el frontend ya
    // preserva sentByAi). Antes no se persistía aquí y el saliente del flujo quedaba
    // atribuido al "Asesor" en vez de "🤖 Agente IA".
    const sentId = await this.nodeSenderService.sendTextNodeReturnId(
      `${urlevo}/message/sendText/${instanceName}`,
      apikey,
      remoteJid,
      t,
    );
    if (sentId && this.chatStore && ctx.userId) {
      void this.chatStore.persistMessage({
        userId: ctx.userId,
        instanceName: ctx.instanceName,
        instanceType: 'evolution',
        remoteJid,
        messageId: sentId,
        fromMe: true,
        messageType: 'conversation',
        content: t,
        raw: { sentByAi: true },
        messageTimestamp: Math.floor(Date.now() / 1000),
      });
    }
    return !!sentId;
  }

  /**
   * Registra el resultado de un envío de contenido del flujo en el contador de
   * la corrida y, si falló, lo deja como ERROR (antes se perdía en un warning y
   * el flujo seguía como si nada → el cliente no recibía el mensaje pero igual
   * se agendaba el seguimiento). No lanza: solo contabiliza y loguea.
   */
  private recordFlowSend(ctx: NodeExecCtx, node: WorkflowNode, ok: boolean): void {
    if (ctx.flowSend) {
      ctx.flowSend.attempted++;
      if (ok) ctx.flowSend.sent++;
      else ctx.flowSend.failed++;
    }
    if (!ok) {
      this.logger.error(
        `[UID=${ctx.userId}][I=${ctx.instanceName}][R=${ctx.remoteJid}] [flujo] ENVÍO FALLIDO nodo tipo="${node.tipo}" id="${node.id}". ` +
          `El cliente NO recibió este mensaje (revisar conexión/estado de la instancia "${ctx.instanceName}").`,
        undefined,
        'WorkflowService',
      );
    }
  }

  /** Envío de MEDIA (image/video/document) de un nodo, enrutando por canal. */
  private async wfSendMedia(
    ctx: NodeExecCtx,
    remoteJid: string,
    type: string,
    caption: string,
    mediaUrl: string,
  ): Promise<boolean> {
    if (!mediaUrl) return false;
    const { instanceType, urlevo, apikey, instanceName } = ctx;
    const factory = this.whatsAppSenderFactory;
    if (this.isChannelType(instanceType) && factory) {
      return factory
        .getSenderSync(instanceType)
        .sendMedia(instanceName, remoteJid, type, caption, mediaUrl, urlevo, apikey)
        .catch(() => false);
    }
    if (!urlevo && factory) {
      return factory
        .getSenderSync('baileys')
        .sendMedia(instanceName, remoteJid, type, caption, mediaUrl)
        .catch(() => false);
    }
    // Evolution: capturamos el id real y persistimos el saliente como Agente IA
    // (sin duplicar: el eco/resync trae el mismo id y el ON CONFLICT lo dedupe).
    const sent = await this.nodeSenderService.sendMediaNodeWithId(
      `${urlevo}/message/sendMedia/${instanceName}`,
      apikey,
      remoteJid,
      type,
      caption,
      mediaUrl,
    );
    if (sent.ok && sent.id && this.chatStore && ctx.userId) {
      void this.chatStore.persistMessage({
        userId: ctx.userId,
        instanceName: ctx.instanceName,
        instanceType: 'evolution',
        remoteJid,
        messageId: sent.id,
        fromMe: true,
        messageType: `${type}Message`,
        content: (caption ?? '').trim() || null,
        mediaUrl,
        raw: { sentByAi: true },
        messageTimestamp: Math.floor(Date.now() / 1000),
      });
    }
    return sent.ok;
  }

  /** Envío de AUDIO de un nodo, enrutando por canal. */
  private async wfSendAudio(ctx: NodeExecCtx, remoteJid: string, audioUrl: string): Promise<boolean> {
    if (!audioUrl) return false;
    const { instanceType, urlevo, apikey, instanceName } = ctx;
    const factory = this.whatsAppSenderFactory;
    if (this.isChannelType(instanceType) && factory) {
      return factory
        .getSenderSync(instanceType)
        .sendAudio(instanceName, remoteJid, audioUrl, urlevo, apikey)
        .catch(() => false);
    }
    if (!urlevo && factory) {
      return factory
        .getSenderSync('baileys')
        .sendAudio(instanceName, remoteJid, audioUrl)
        .catch(() => false);
    }
    // Evolution: id real + persistir como Agente IA (nota de voz). mediaUrl null:
    // el audio suele venir en base64 (pesado); el resync de Evolution completa el
    // archivo. Con messageType 'audioMessage' basta para no descartar el registro.
    const sent = await this.nodeSenderService.sendAudioNodeWithId(
      `${urlevo}/message/sendWhatsAppAudio/${instanceName}`,
      apikey,
      remoteJid,
      audioUrl,
    );
    if (sent.ok && sent.id && this.chatStore && ctx.userId) {
      void this.chatStore.persistMessage({
        userId: ctx.userId,
        instanceName: ctx.instanceName,
        instanceType: 'evolution',
        remoteJid,
        messageId: sent.id,
        fromMe: true,
        messageType: 'audioMessage',
        content: null,
        raw: { sentByAi: true },
        messageTimestamp: Math.floor(Date.now() / 1000),
      });
    }
    return sent.ok;
  }

  private async persistFlowOutboundMedia(
    ctx: NodeExecCtx,
    node: WorkflowNode,
    channel: string,
  ): Promise<void> {
    try {
      // Solo para canales (meta/telegram): en Evolution/Baileys el saliente ya
      // llega por webhook/store, así que persistirlo aquí duplicaba el mensaje en
      // el panel (una copia "Agente IA" + otra del eco del webhook atribuida al
      // asesor). Mismo criterio que persistFlowOutboundText.
      if (!this.isChannelType(ctx.instanceType)) return;
      if (!this.chatStore || !ctx.userId) {
        this.logger.warn(
          `[FlowPersist] media omitida (chatStore=${!!this.chatStore} userId=${!!ctx.userId})`,
          'WorkflowService',
        );
        return;
      }
      const mediaUrl = (node.url ?? '').toString().trim();
      if (!mediaUrl) return;
      const messageType = `${node.tipo}Message`; // image|video|document|audio -> *Message
      const caption = this.resolveNodeText(node.message, ctx.pushName).trim();
      await this.chatStore.persistMessage({
        userId: ctx.userId,
        instanceName: ctx.instanceName,
        instanceType: channel,
        remoteJid: ctx.remoteJid,
        fromMe: true,
        messageType,
        content: caption || null,
        mediaUrl,
        // Marca para que el panel muestre "Agente IA" (no "Asesor") en el saliente.
        raw: { sentByAi: true },
        messageTimestamp: Math.floor(Date.now() / 1000),
      });
    } catch (e: any) {
      this.logger.warn(`[FlowPersist] error media: ${e?.message}`, 'WorkflowService');
    }
  }

  /**
   * Persiste el TEXTO saliente de un nodo de flujo en el store unificado para que
   * el operador lo vea en el panel de Chats. Solo para canales (meta/telegram):
   * en Evolution los salientes de texto ya llegan por webhook (evita duplicados).
   */
  private async persistFlowOutboundText(ctx: NodeExecCtx, remoteJid: string, text: string): Promise<void> {
    try {
      const t = (text ?? '').trim();
      if (!t) return;
      if (!this.isChannelType(ctx.instanceType)) return; // Evolution/Baileys: no duplicar
      if (!this.chatStore || !ctx.userId) {
        this.logger.warn(
          `[FlowPersist] texto omitido (chatStore=${!!this.chatStore} userId=${!!ctx.userId})`,
          'WorkflowService',
        );
        return;
      }
      await this.chatStore.persistMessage({
        userId: ctx.userId,
        instanceName: ctx.instanceName,
        instanceType: ctx.instanceType,
        remoteJid,
        fromMe: true,
        messageType: 'conversation',
        content: t,
        // Marca para que el panel muestre "Agente IA" (no "Asesor") en el saliente.
        raw: { sentByAi: true },
        messageTimestamp: Math.floor(Date.now() / 1000),
      });
    } catch (e: any) {
      this.logger.warn(`[FlowPersist] error texto: ${e?.message}`, 'WorkflowService');
    }
  }

  /**
   * Persiste un TEXTO saliente marcado como "Agente IA" (raw.sentByAi=true), para
   * reuso desde otros emisores automáticos (automatizaciones de etapa/etiqueta,
   * recordatorios, follow-ups). En Evolution se debe pasar el messageId REAL para
   * que el eco/resync lo deduplique (no duplicar); en canales (meta/telegram) puede
   * ir sin id. Nunca lanza.
   */
  async persistOutboundAiText(params: {
    userId?: string | null;
    instanceName: string;
    instanceType?: string | null;
    remoteJid: string;
    messageId?: string | null;
    content: string;
  }): Promise<void> {
    try {
      const t = (params.content ?? '').trim();
      if (!t || !this.chatStore || !params.userId) return;
      await this.chatStore.persistMessage({
        userId: params.userId,
        instanceName: params.instanceName,
        instanceType: params.instanceType ?? 'evolution',
        remoteJid: params.remoteJid,
        ...(params.messageId ? { messageId: params.messageId } : {}),
        fromMe: true,
        messageType: 'conversation',
        content: t,
        raw: { sentByAi: true },
        messageTimestamp: Math.floor(Date.now() / 1000),
      });
    } catch (e: any) {
      this.logger.warn(`[AiOutboundPersist] error: ${e?.message}`, 'WorkflowService');
    }
  }

  /**
   * Envía un TEXTO por Evolution capturando el messageId REAL y lo persiste como
   * "Agente IA" SIN duplicar (el eco/resync dedupe por ese id). Devuelve true si se
   * envió. Reuso desde emisores automáticos (recordatorios, automatizaciones, etc.).
   */
  async sendEvolutionAiText(
    serverUrl: string,
    apikey: string,
    instanceName: string,
    remoteJid: string,
    userId: string | null | undefined,
    text: string,
  ): Promise<boolean> {
    const t = (text ?? '').trim();
    if (!t) return true;
    const sentId = await this.nodeSenderService.sendTextNodeReturnId(
      `${serverUrl}/message/sendText/${instanceName}`,
      apikey,
      remoteJid,
      t,
    );
    if (!sentId) return false;
    await this.persistOutboundAiText({
      userId,
      instanceName,
      instanceType: 'evolution',
      remoteJid,
      messageId: sentId,
      content: t,
    });
    return true;
  }

  /** Persiste un MEDIA/audio saliente marcado como "Agente IA". En Evolution pasar
   *  el messageId real para deduplicar con el eco/resync (no duplicar). Nunca lanza. */
  async persistOutboundAiMedia(params: {
    userId?: string | null;
    instanceName: string;
    instanceType?: string | null;
    remoteJid: string;
    messageId?: string | null;
    messageType: string;
    content?: string | null;
    mediaUrl?: string | null;
  }): Promise<void> {
    try {
      if (!this.chatStore || !params.userId) return;
      await this.chatStore.persistMessage({
        userId: params.userId,
        instanceName: params.instanceName,
        instanceType: params.instanceType ?? 'evolution',
        remoteJid: params.remoteJid,
        ...(params.messageId ? { messageId: params.messageId } : {}),
        fromMe: true,
        messageType: params.messageType,
        content: params.content ?? null,
        mediaUrl: params.mediaUrl ?? null,
        raw: { sentByAi: true },
        messageTimestamp: Math.floor(Date.now() / 1000),
      });
    } catch (e: any) {
      this.logger.warn(`[AiOutboundPersist] error media: ${e?.message}`, 'WorkflowService');
    }
  }

  private readonly NODE_TIMEOUT_MS = 15000;

  private async getRecentUserTextsForIntention(
    instanceName: string,
    remoteJid: string,
    limit: number,
  ): Promise<string[]> {
    const sessionHistoryId = buildChatHistorySessionId(instanceName, remoteJid);
    const chatHistory =
      await this.chatHistoryService.getChatHistory(sessionHistoryId);
    return chatHistory
      .slice(-limit)
      .map((t) => (t ?? '').trim())
      .filter(Boolean);
  }

  /**
   * Ejecuta un workflow enviando los nodos correspondientes (texto, imagen, video, etc).
   *
   * @param {string} name_flujo - Camillas.
   * @param {string} urlevo - https://conexion-1.verzay.co.
   * @param {string} apikey - 66C994B1-F828-4241-9A09-9DA3C05CDF2D.
   * @param {string} instanceName - Instancia-121.
   * @param {string} remoteJid - 573107964105@s.whatsapp.net.
   * @param {userId} userId - cm8tdvkcd0000q0vgshc1wweu.
   * @returns {Promise<{ message: string; workflow: string; totalNodes: number }>}
   */
  async executeWorkflow(
    name_flujo: string,
    urlevo: string,
    apikey: string,
    instanceName: string,
    remoteJid: string,
    userId: string,
    incomingText?: string,
    pushName?: string,
  ) {
    const result = await this.prisma.workflow.findFirst({
      where: { name: name_flujo, userId },
      orderBy: { createdAt: 'asc' },
    });

    if (!result) {
      this.logger.warn(
        `Workflow no encontrado: ${name_flujo}`,
        'WorkflowService',
      );
      throw new NotFoundException('Workflow no encontrado');
    }

    // obtener sesión para sessionId (estado por conversación)
    const session = await this.getSession({ remoteJid, instanceName, userId });
    if (!session) {
      this.logger.warn(
        `No se encontró sesión para ejecutar workflow (${remoteJid}).`,
        'WorkflowService',
      );
      return { message: 'No session', workflow: result.name, totalNodes: 0 };
    }

    // Canal de la instancia (para enrutar el envío de nodos al adaptador correcto).
    const instanceType = await this.resolveInstanceType(instanceName, userId);

    // =========================
    // LOCK (CORRECTO)
    // =========================
    const lockKey = `${userId}:${instanceName}:${remoteJid}:${result.id}`;
    const ttlMs = 15000;

    // limpia locks viejos
    await this.prisma.workflowExecutionLock.deleteMany({
      where: {
        lockKey,
        createdAt: { lt: new Date(Date.now() - ttlMs) },
      },
    });

    // intenta adquirir lock
    try {
      await this.prisma.workflowExecutionLock.create({
        data: {
          userId,
          instanceName,
          remoteJid,
          workflowId: result.id,
          lockKey,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        this.logger.warn(
          `â­ Workflow SKIPPED (lock activo). name=${result.name} remoteJid=${remoteJid}`,
          'WorkflowService',
        );
        return {
          message: 'Skipped (lock active)',
          workflow: result.name,
          totalNodes: 0,
        };
      }
      throw e;
    }

    // EJECUTA y libera lock al final (SIEMPRE)
    try {
      const isPro = !!result.isPro;

      if (!isPro) {
        return await this.executeBasicWorkflow(
          result,
          urlevo,
          apikey,
          instanceName,
          remoteJid,
          userId,
          session,
          pushName,
          instanceType,
        );
      }

      // =========================
      // PRO: estado por sesión + workflow
      // =========================
      let state = await this.getOrCreateSessionWorkflowState(
        session.id,
        result.id,
      );

      const { byId, outgoing, startNodeId } = await this.getWorkflowGraph(
        result.id,
      );
      if (!startNodeId) {
        throw new NotFoundException('Workflow inválido: no hay nodo inicial');
      }

      let currentId: string | undefined =
        state.intentionStatus === 'waiting' && state.currentNodeId
          ? state.currentNodeId
          : startNodeId;

      let executedCount = 0;
      // Contador de envíos compartido por toda la corrida del flujo (se consulta
      // en el nodo de seguimiento para no agendarlo si no se entregó nada).
      const flowSend: FlowSendTracker = { attempted: 0, sent: 0, failed: 0 };

      while (currentId) {
        const node = byId.get(currentId);
        if (!node) break;

        this.logger.log(
          `Procesando nodo pro (ID: ${node.id}, tipo: ${node.tipo})`,
          'WorkflowService',
        );

        // ===========================
        // NODO INTENTION (PAUSA/ITERACIÓN)
        // ===========================
        if (node.tipo === 'intention') {
          const intentionPrompt = ((node as any).intentionPrompt ?? '').trim();
          const messageToUser = (node.message ?? '').trim();
          const maxAttempts = Number((node as any).intentionMaxAttempts ?? 3);

          const isWaitingHere =
            state.intentionStatus === 'waiting' &&
            state.currentNodeId === node.id;

          if (!isWaitingHere) {
            if (messageToUser) {
              await this.wfSendText(
                { urlevo, apikey, instanceName, remoteJid, userId, instanceType },
                remoteJid,
                messageToUser,
              );
            }

            state = await this.prisma.sessionWorkflowState.update({
              where: { id: state.id },
              data: {
                currentNodeId: node.id,
                intentionStatus: 'waiting',
                intentionAttempts: 0,
                lastPromptAt: new Date(),
                intentionData: {
                  ...((state.intentionData as any) ?? {}),
                  lastQuestion: messageToUser,
                  recentUserTexts: [],
                },
              },
            });

            return {
              message: 'Workflow paused on intention',
              workflow: result.name,
              totalNodes: executedCount,
            };
          }

          const text = (incomingText ?? '').trim();
          if (!text) {
            return {
              message: 'Waiting user input',
              workflow: result.name,
              totalNodes: executedCount,
            };
          }

          const prevData = (state.intentionData as any) ?? {};
          //TODO: Se quema maxAttempts para no traer todo el historial, pero ideal sería marcar de alguna forma los mensajes relacionados a la intención (ej: con metadata) para traer solo esos.
          const recentUserTexts = await this.getRecentUserTextsForIntention(
            instanceName,
            remoteJid,
            15,
          );

          state = await this.prisma.sessionWorkflowState.update({
            where: { id: state.id },
            data: {
              intentionData: {
                ...prevData,
                lastQuestion: messageToUser,
                recentUserTexts,
              },
            },
          });

          const ok = await this.validateIntentionInput({
            userId,
            intentionPrompt,
            messageToUser,
            userText: text,
            recentUserTexts,
          });

          if (ok) {
            const dataNow = (state.intentionData as any) ?? {};
            state = await this.prisma.sessionWorkflowState.update({
              where: { id: state.id },
              data: {
                intentionStatus: 'passed',
                currentNodeId: null,
                intentionData: {
                  ...dataNow,
                  finalText: text,
                },
              },
            });

            const next = this.pickNextByHandle(
              outgoing.get(node.id) ?? [],
              'yes',
            );
            if (!next)
              return {
                message: 'No YES branch',
                workflow: result.name,
                totalNodes: executedCount,
              };

            currentId = next.targetId;
            continue;
          }

          const nextAttempts = (state.intentionAttempts ?? 0) + 1;

          if (nextAttempts < maxAttempts) {
            if (messageToUser) {
              const url = `${urlevo}/message/sendText/${instanceName}`;
              await this.nodeSenderService.sendTextNode(
                url,
                apikey,
                remoteJid,
                messageToUser,
              );
            }

            state = await this.prisma.sessionWorkflowState.update({
              where: { id: state.id },
              data: {
                intentionAttempts: nextAttempts,
                lastPromptAt: new Date(),
              },
            });

            return {
              message: 'Retry intention',
              workflow: result.name,
              totalNodes: executedCount,
            };
          }

          state = await this.prisma.sessionWorkflowState.update({
            where: { id: state.id },
            data: {
              intentionStatus: 'failed',
              currentNodeId: null,
              intentionAttempts: nextAttempts,
            },
          });

          const next = this.pickNextByHandle(outgoing.get(node.id) ?? [], 'no');
          if (!next)
            return {
              message: 'No NO branch',
              workflow: result.name,
              totalNodes: executedCount,
            };

          currentId = next.targetId;
          continue;
        }

        await this.runNodeWithTimeout(
          node,
          { urlevo, apikey, instanceName, remoteJid, userId, instanceType, flowSend },
          {
            timeoutLabel: 'nodo',
            logPauseDiagnostics: true,
            warnMissingSessionForSeguimiento: true,
          },
          session,
        );

        executedCount++;

        const outs = outgoing.get(node.id) ?? [];
        if (outs.length > 1) {
          this.logger.warn(
            `Nodo ${node.id} (${node.tipo}) tiene ${outs.length} salidas. outs=${JSON.stringify(outs)}`,
            'WorkflowService',
          );
        }

        const next =
          this.pickNextByHandle(outs, 'out') ??
          outs.find((e) => (e.sourceHandle ?? 'out') !== 'default') ??
          outs[0] ??
          null;

        currentId = next?.targetId;

        if (currentId) {
          await new Promise((res) => setTimeout(res, 5000));
        }
      }

      this.logger.log(
        `Workflow "${result.name}" ejecutado con éxito.`,
        'WorkflowService',
      );

      return {
        message: 'Workflow ejecutado',
        workflow: result.name,
        totalNodes: executedCount,
      };
    } finally {
      await this.prisma.workflowExecutionLock.deleteMany({
        where: { lockKey },
      });
    }
  }

  private async runNodeWithTimeout(
    node: WorkflowNode,
    ctx: NodeExecCtx,
    opts: RunNodeOptions,
    session?: Session | null,
  ) {
    const send = () => this.sendNodeCommon(node, ctx, opts, session);

    // Si es delay, el timeout debe cubrir el delay completo (+1s buffer)
    const timeoutMs =
      node.tipo === 'delay'
        ? Math.max(this.NODE_TIMEOUT_MS, Number(node.delay ?? 0) + 1000)
        : this.NODE_TIMEOUT_MS;

    try {
      await Promise.race([
        send(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Tiempo de espera excedido')),
            timeoutMs,
          ),
        ),
      ]);
    } catch (error: any) {
      this.logger.warn(
        `Timeout procesando ${opts.timeoutLabel} ID: ${node.id}, ${error?.response?.data || error?.message}`,
        'WorkflowService',
      );
    }
  }

  private resolveNodeText(text: string | null | undefined, pushName?: string): string {
    if (!text) return '';
    const name = (pushName ?? '').trim();
    const isValidName = name && name.toLowerCase() !== 'desconocido';
    if (isValidName) {
      return text.replace(/\{nombre\}/gi, name);
    }
    // Sin nombre: eliminar {nombre} + coma/espacio que le siguen y capitalizar
    const cleaned = text.replace(/\{nombre\}[,\s]*/gi, '').trim();
    return cleaned.length > 0 ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : cleaned;
  }

  /**
   * Ejecuta el nodo "Guardar ficha + Sheets": toma los datos conocidos del lead,
   * opcionalmente extrae con IA los campos configurados de la ficha desde la
   * conversación, los guarda (merge) en ExternalClientData y los sincroniza a
   * Google Sheets. Nunca lanza: un fallo aquí no debe romper el flujo.
   */
  private async executeGuardarFichaNode(node: WorkflowNode, ctx: NodeExecCtx): Promise<void> {
    const { instanceName, remoteJid, userId, pushName } = ctx;
    try {
      if (!userId || !remoteJid) return;

      const phone = remoteJid.split('@')[0].split(':')[0].replace(/\D/g, '');
      const session = await this.getSession({ remoteJid, instanceName, userId }).catch(() => null);

      // Campos configurados (habilitados) de la ficha de la cuenta.
      const fields = await this.getEnabledContactFields(userId);

      // Extracción IA opcional (cuando el nodo tiene aiEnabled).
      let extracted: Record<string, unknown> = {};
      if (node.aiEnabled && fields.length && this.aiAgentService) {
        extracted = await this.extractContactFields(
          userId,
          instanceName,
          remoteJid,
          fields,
          node.message,
          (session as any)?.id ?? null,
        );
      }

      // Nombre: preferir el que el CLIENTE dio en la conversación; si no, el de
      // WhatsApp/sesión (el pushName suele ser el nombre del negocio, no del cliente).
      const extractedName = (extracted['__nombre'] ?? '').toString().trim();
      delete extracted['__nombre'];
      const name = (
        extractedName ||
        (session as any)?.customName ||
        pushName ||
        (session as any)?.pushName ||
        ''
      )
        .toString()
        .trim();

      // Ficha a guardar = extraídos + teléfono (siempre conocido).
      const fichaData: Record<string, unknown> = { ...extracted };
      if (phone && !fichaData['telefono']) fichaData['telefono'] = phone;

      // Estado: el lead llegó hasta este nodo → marca de flujo completado.
      const estadoKey = this.pickFieldKeyByLabels(fields, ['estado', 'status', 'etapa']);
      if (estadoKey) fichaData[estadoKey] = 'Lead flujo completado';

      // País: derivado del código del número de teléfono (no de lo que diga el cliente).
      const paisKey = this.pickFieldKeyByLabels(fields, ['pais', 'country']);
      if (paisKey) {
        const country = this.countryFromPhone(phone);
        if (country) fichaData[paisKey] = country;
      }

      // 1. Guardar/fusionar en la ficha (ExternalClientData).
      if (this.externalClientDataService) {
        await this.externalClientDataService.upsert(userId, remoteJid, fichaData, 'flujo');
      }

      // 2. Sincronizar a Google Sheets (no bloquea el flujo).
      void this.syncFichaToSheets(userId, phone, name, fields, fichaData);

      this.logger.log(
        `[UID=${userId}][I=${instanceName}][R=${remoteJid}] [guardar-ficha] OK tel=${phone} ia=${!!node.aiEnabled} ` +
          `camposConfig=${fields.length} extraidos=[${Object.keys(extracted).join(',') || 'ninguno'}] ` +
          `guardados=${Object.keys(fichaData).length} extSvc=${!!this.externalClientDataService} aiSvc=${!!this.aiAgentService}`,
        'WorkflowService',
      );
    } catch (err: any) {
      this.logger.error(
        `[UID=${userId}][I=${instanceName}][R=${remoteJid}] [guardar-ficha] Error: ${err?.message ?? err}`,
        undefined,
        'WorkflowService',
      );
    }
  }

  /** Lee los campos de contacto habilitados de la cuenta (config en User). */
  private async getEnabledContactFields(
    userId: string,
  ): Promise<{ key: string; label: string }[]> {
    let raw: unknown = null;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ contactFieldsConfig: unknown }>>`
        SELECT "contact_fields_config" AS "contactFieldsConfig" FROM "User" WHERE id = ${userId} LIMIT 1
      `;
      raw = rows?.[0]?.contactFieldsConfig ?? null;
    } catch {
      // sin config: se usan los defaults
    }
    return normalizeContactFieldsConfig(raw)
      .filter((f) => f.enabled)
      .sort((a, b) => a.order - b.order)
      .map((f) => ({ key: f.key, label: f.label }));
  }

  /** Devuelve la clave del primer campo cuya etiqueta (normalizada) coincida. */
  private pickFieldKeyByLabels(
    fields: { key: string; label: string }[],
    candidates: string[],
  ): string | null {
    const norm = (s: string) =>
      (s ?? '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const wanted = new Set(candidates.map(norm));
    const found = fields.find((f) => wanted.has(norm(f.label)));
    return found?.key ?? null;
  }

  /** Deriva el país a partir del código telefónico internacional del número. */
  private countryFromPhone(phone: string): string {
    const digits = (phone ?? '').replace(/\D/g, '');
    if (!digits) return '';
    // Prefijos ordenados de más largo a más corto para desambiguar (ej. 1809 vs 1).
    const map: Array<[string, string]> = [
      ['1809', 'R. Dominicana'], ['1829', 'R. Dominicana'], ['1849', 'R. Dominicana'],
      ['591', 'Bolivia'], ['593', 'Ecuador'], ['595', 'Paraguay'], ['598', 'Uruguay'],
      ['502', 'Guatemala'], ['503', 'El Salvador'], ['504', 'Honduras'], ['505', 'Nicaragua'],
      ['506', 'Costa Rica'], ['507', 'Panamá'], ['509', 'Haití'],
      ['51', 'Perú'], ['52', 'México'], ['53', 'Cuba'], ['54', 'Argentina'], ['55', 'Brasil'],
      ['56', 'Chile'], ['57', 'Colombia'], ['58', 'Venezuela'],
      ['34', 'España'], ['1', 'Estados Unidos'],
    ];
    for (const [prefix, country] of map) {
      if (digits.startsWith(prefix)) return country;
    }
    return '';
  }

  /**
   * Construye la conversación para la extracción combinando: (1) las respuestas
   * capturadas en los flujos de preguntas (SessionWorkflowState.intentionData:
   * lastQuestion + finalText) — clave porque los flujos guionados NO siempre
   * pasan por el agente IA / n8nChatHistory — y (2) el historial del agente IA.
   */
  private async buildConversationForExtraction(
    sessionId: number | null | undefined,
    instanceName: string,
    remoteJid: string,
  ): Promise<string> {
    const parts: string[] = [];

    if (sessionId) {
      try {
        const states = await this.prisma.sessionWorkflowState.findMany({
          where: { sessionId },
          orderBy: { updatedAt: 'asc' },
          select: { intentionData: true },
        });
        for (const st of states) {
          const d = ((st.intentionData as any) ?? {}) as {
            lastQuestion?: string;
            finalText?: string;
            recentUserTexts?: unknown;
          };
          const q = (d.lastQuestion ?? '').toString().trim();
          const a = (d.finalText ?? '').toString().trim();
          if (q) parts.push(`Negocio: ${q}`);
          if (a) parts.push(`Cliente: ${a}`);
          if (Array.isArray(d.recentUserTexts)) {
            for (const r of d.recentUserTexts) {
              const t = (r ?? '').toString().trim();
              if (t && t !== a) parts.push(`Cliente: ${t}`);
            }
          }
        }
      } catch {
        // sin estados de workflow
      }
    }

    try {
      const sessionHistoryId = buildChatHistorySessionId(instanceName, remoteJid);
      const history = await this.chatHistoryService.getChatHistory(sessionHistoryId);
      for (const t of history.slice(-20)) {
        const s = (t ?? '').toString().trim();
        if (s) parts.push(s);
      }
    } catch {
      // sin historial del agente
    }

    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of parts) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out.slice(-40).join('\n').trim();
  }

  /** Extrae con IA los campos pedidos desde la conversación reciente. */
  private async extractContactFields(
    userId: string,
    instanceName: string,
    remoteJid: string,
    fields: { key: string; label: string }[],
    customInstruction?: string | null,
    sessionId?: number | null,
  ): Promise<Record<string, unknown>> {
    try {
      const recent = await this.buildConversationForExtraction(sessionId, instanceName, remoteJid);
      this.logger.log(
        `[I=${instanceName}][R=${remoteJid}] [guardar-ficha] extracción: chars=${recent.length} campos=${fields.length} sessionId=${sessionId ?? '-'}`,
        'WorkflowService',
      );
      if (!recent) {
        this.logger.warn('[guardar-ficha] Sin conversación para extraer (historial e intenciones vacíos).', 'WorkflowService');
        return {};
      }

      // Normaliza un identificador (minúsculas, sin acentos ni espacios extra) para
      // poder mapear lo que devuelva la IA sin importar mayúsculas/acentos.
      const norm = (s: string) =>
        (s ?? '')
          .toString()
          .toLowerCase()
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .trim();

      // Campos MANUALES: son un juicio comercial del asesor (ej. "Interés":
      // interesado/descartado), NO los deduce la IA. Se excluyen de la extracción
      // para no pisar lo que el equipo marca a mano (el campo sigue en la ficha/Sheets).
      const MANUAL_LABELS = new Set(['interes', 'interés'].map(norm));
      const aiFields = fields.filter((f) => !MANUAL_LABELS.has(norm(f.label)));

      // La clave de tus campos suele ser auto-generada (ej. "nuevo_campo_1"), que no
      // significa nada para la IA → le pedimos que use la ETIQUETA legible ("Rubro")
      // como clave del JSON, y luego mapeamos etiqueta→clave real. Aceptamos también
      // que devuelva la clave cruda, por robustez.
      const resolver = new Map<string, string>();
      for (const f of aiFields) {
        resolver.set(norm(f.label), f.key);
        resolver.set(norm(f.key), f.key);
      }
      // Campo reservado: el NOMBRE que el cliente da en la conversación (no es un
      // campo de la ficha, se usa como nombre del contacto en Sheets/ficha).
      resolver.set(norm('Nombre del cliente'), '__nombre');
      resolver.set(norm('nombre'), '__nombre');

      const fieldList = ['- Nombre del cliente', ...aiFields.map((f) => `- ${f.label}`)].join('\n');
      const extra = (customInstruction ?? '').trim();
      const systemPrompt = [
        'Eres un extractor de datos. A partir de la conversación entre un negocio y un cliente, extrae SOLO los siguientes datos DEL CLIENTE:',
        fieldList,
        '',
        'Reglas estrictas:',
        '- Devuelve un objeto JSON cuyas claves sean EXACTAMENTE las etiquetas listadas (tal cual, con sus tildes).',
        '- "Nombre del cliente" es el nombre de la PERSONA. "Empresa" es solo el nombre del negocio/compañía si lo menciona; NUNCA pongas el nombre de la persona en Empresa.',
        '- Si un dato NO fue dicho explícitamente por el cliente, NO incluyas esa clave (no inventes ni supongas).',
        '- Todos los valores como string.',
        '- No incluyas el teléfono (ya lo tenemos).',
        extra ? `\nContexto del negocio: ${extra}` : '',
      ].join('\n');

      const result = await this.aiAgentService.extractJson({
        userId,
        systemPrompt,
        userJson: { conversacion: recent },
      });
      this.logger.log(
        `[I=${instanceName}][R=${remoteJid}] [guardar-ficha] extractJson => ${result ? JSON.stringify(result).slice(0, 300) : 'null (modelo del usuario sin configurar o respuesta inválida)'}`,
        'WorkflowService',
      );
      if (!result) return {};

      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(result)) {
        const fieldKey = resolver.get(norm(k));
        if (!fieldKey || fieldKey === 'telefono') continue;
        if (v != null && String(v).trim() !== '') {
          out[fieldKey] = String(v).trim();
        }
      }
      return out;
    } catch (err: any) {
      this.logger.warn(
        `[guardar-ficha] Extracción IA falló: ${err?.message ?? err}`,
        'WorkflowService',
      );
      return {};
    }
  }

  /** Sincroniza la ficha a Google Sheets (mismas columnas que el panel de Chats). */
  private async syncFichaToSheets(
    userId: string,
    phone: string,
    name: string,
    fields: { key: string; label: string }[],
    fichaData: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (!this.googleSheetsService || !phone) return;

      let config: string | null = null;
      try {
        const rows = await this.prisma.$queryRaw<Array<{ googleSheetsWebhookUrl: string | null }>>`
          SELECT "google_sheets_webhook_url" AS "googleSheetsWebhookUrl" FROM "User" WHERE id = ${userId} LIMIT 1
        `;
        config = rows?.[0]?.googleSheetsWebhookUrl ?? null;
      } catch {
        return;
      }
      if (!config) return;

      const spreadsheetId = this.extractSheetId(config);
      if (!spreadsheetId) return;

      // Marcador para las columnas que quedan vacías (dato no capturado): deja la fila
      // visualmente uniforme en Sheets. La ficha en la app queda vacía (editable).
      const PLACEHOLDER = '--------•--------•--------';
      const headers = ['Teléfono', 'Nombre', ...fields.map((f) => f.label), 'Actualizado'];
      const row = [
        phone,
        name ?? '',
        ...fields.map((f) => {
          const v = String(fichaData[f.key] ?? '').trim();
          return v || PLACEHOLDER;
        }),
        new Date().toLocaleString('es-CO'),
      ];

      await this.googleSheetsService.upsertContactRow(spreadsheetId, headers, phone, row);
    } catch (err: any) {
      this.logger.warn(
        `[guardar-ficha] Sync a Sheets falló: ${err?.message ?? err}`,
        'WorkflowService',
      );
    }
  }

  /** Extrae el spreadsheetId de una URL de Google Sheets o lo devuelve si ya es id. */
  private extractSheetId(input: string): string | null {
    if (!input) return null;
    const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    if (/^[a-zA-Z0-9_-]{30,}$/.test(input.trim())) return input.trim();
    return null;
  }

  private async sendNodeCommon(
    node: WorkflowNode,
    ctx: NodeExecCtx,
    opts: RunNodeOptions,
    session?: Session | null,
  ) {
    const { urlevo, apikey, instanceName, remoteJid, userId, pushName } = ctx;

    this.logger.log(`[UID=${userId}][I=${instanceName}][R=${remoteJid}] [nodo] ejecutando tipo="${node.tipo}" id="${node.id}"`, 'WorkflowService');

    if (node.tipo === 'delay') {
      const delayTime = node?.delay || 15000;
      this.logger.log(
        `Esperando ${delayTime}ms (nodo ID: ${node.id})`,
        'WorkflowService',
      );
      await new Promise((res) => setTimeout(res, Number(delayTime)));
      return;
    }

    // Nodo "Guardar ficha + Sheets": no envía nada al cliente; captura datos,
    // los guarda en la ficha (ExternalClientData) y los sincroniza a Google Sheets.
    if (node.tipo === 'guardar-ficha') {
      await this.executeGuardarFichaNode(node, ctx);
      return;
    }

    // Nodos de AUTOMATIZACIÓN (tags, asignar/notificar asesor, tarea, cambiar
    // estado, toggle IA, webhook, llamada IA). Tampoco envían nada al cliente:
    // reutilizan los handlers del Kanban (StageAutomationService). La config va
    // como JSON en node.message.
    const automationType = AUTOMATION_TIPO_MAP[node.tipo];
    if (automationType) {
      if (!this.stageAutomationService) {
        this.logger.warn(
          `[nodo][automatizacion] StageAutomationService no disponible (tipo="${node.tipo}" id="${node.id}")`,
          'WorkflowService',
        );
        return;
      }

      const s =
        session ?? (await this.getSession({ remoteJid, instanceName, userId }));
      if (!s) {
        this.logger.warn(
          `[nodo][automatizacion] Sin sesión para ejecutar tipo="${node.tipo}" (${remoteJid})`,
          'WorkflowService',
        );
        return;
      }

      let cfg: Record<string, unknown> = {};
      try {
        cfg = node.message ? JSON.parse(node.message) : {};
      } catch {
        cfg = {};
      }

      await this.stageAutomationService.runActionForSession(
        automationType,
        cfg,
        s.id,
      );
      return;
    }

    // Envío enrutado por canal (meta/telegram → adaptador de canal; baileys →
    // adaptador baileys; en otro caso → Evolution API). Ver wfSend* helpers.
    if (node.tipo === 'text') {
      const text = this.resolveNodeText(node.message, pushName);
      const ok = await this.wfSendText(ctx, remoteJid, text);
      if (text.trim()) this.recordFlowSend(ctx, node, ok);
      await this.persistFlowOutboundText(ctx, remoteJid, text);
      return;
    }

    if (['image', 'video', 'document'].includes(node.tipo)) {
      const url = (node.url ?? '').trim();
      const caption = this.resolveNodeText(node.message, pushName).trim();
      const ok = await this.wfSendMedia(ctx, remoteJid, node.tipo, caption, url);
      if (url) this.recordFlowSend(ctx, node, ok);
      if (ok) await this.persistFlowOutboundMedia(ctx, node, ctx.instanceType ?? 'evolution');
      return;
    }

    if (node.tipo === 'audio') {
      const url = (node.url ?? '').trim();
      const ok = await this.wfSendAudio(ctx, remoteJid, url);
      if (url) this.recordFlowSend(ctx, node, ok);
      if (ok) await this.persistFlowOutboundMedia(ctx, node, ctx.instanceType ?? 'evolution');
      return;
    }

    if (node.tipo === 'nodo-notify') {
      await this.sendWorkflowNotification({
        node,
        session,
        urlevo,
        apikey,
        instanceName,
        remoteJid,
        userId,
        instanceType: ctx.instanceType,
      });
      return;
    }

    if (node.tipo === 'node_pause') {
      this.logger.log(
        `Nodo pause: pausando sesión para ${remoteJid} en instancia ${instanceName}`,
        'WorkflowService',
      );

      await this.sessionService.updateSessionStatus(
        remoteJid,
        instanceName,
        false,
        userId,
      );

      const s =
        session ?? (await this.getSession({ remoteJid, instanceName, userId }));
      const aiEnabled =
        (node as WorkflowNode & { aiEnabled?: boolean | null }).aiEnabled ===
        true;

      // "Activar IA": opt-in de IA por contacto. Con aiEnabled=true, la IA
      // responderá a ESTE contacto cuando la sesión se reactive, aunque el
      // interruptor global "Estado del agente" esté apagado. Con aiEnabled=false
      // se retira el opt-in (pausar sin continuar con IA). Es por sesión; no
      // toca la config global ni a otros contactos.
      await this.sessionService.setAiOptIn(
        remoteJid,
        instanceName,
        aiEnabled,
        userId,
      );

      if (!aiEnabled) {
        if (s) {
          await this.clearSessionTriggerIfExists(
            s.id,
            `Nodo pause con IA desactivada. Se elimina SessionTrigger previo si existe (${remoteJid}).`,
          );
        } else if (opts.logPauseDiagnostics) {
          this.logger.log(
            `Nodo pause con IA desactivada y sin sesión disponible. No hay trigger para limpiar (${remoteJid}).`,
            'WorkflowService',
          );
        }
        return;
      }

      const rawDelay = node.delay ?? '';
      if (!rawDelay) {
        // "Activar IA" SIN delay = activar la IA de INMEDIATO. La sesión se pausó
        // arriba; la reactivamos ya (status=true) para que la IA responda al
        // próximo mensaje sin espera. El opt-in (aiOptIn) ya quedó puesto arriba.
        await this.sessionService.updateSessionStatus(
          remoteJid,
          instanceName,
          true,
          userId,
        );
        if (s) {
          await this.clearSessionTriggerIfExists(
            s.id,
            `Nodo pause sin delay + IA activada. Reactivación inmediata; se elimina SessionTrigger previo si existe (${remoteJid}).`,
          );
        }
        if (opts.logPauseDiagnostics) {
          this.logger.log(
            `Nodo pause "Activar IA" sin delay → IA activada de inmediato (sesión reactivada). remoteJid=${remoteJid}`,
            'WorkflowService',
          );
        }
        return;
      }

      const [unit, valueStr] = rawDelay.split('-');
      const value = parseInt(valueStr, 10);

      if (
        !['seconds', 'minutes', 'hours', 'days'].includes(unit) ||
        isNaN(value)
      ) {
        if (s) {
          await this.clearSessionTriggerIfExists(
            s.id,
            `Nodo pause con delay inválido "${rawDelay}". Se elimina SessionTrigger previo si existe.`,
          );
        }
        if (opts.logPauseDiagnostics) {
          this.logger.warn(
            `Nodo pause con delay inválido "${rawDelay}". No se crea SessionTrigger.`,
            'WorkflowService',
          );
        }
        return;
      }

      if (value <= 0) {
        // delay 0 + IA activada = activar de inmediato (reactivamos la sesión ya).
        await this.sessionService.updateSessionStatus(
          remoteJid,
          instanceName,
          true,
          userId,
        );
        if (s) {
          await this.clearSessionTriggerIfExists(
            s.id,
            `Nodo pause con delay 0 + IA activada. Reactivación inmediata; se elimina SessionTrigger previo si existe (${remoteJid}).`,
          );
        }
        if (opts.logPauseDiagnostics) {
          this.logger.log(
            `Nodo pause "Activar IA" con delay 0 → IA activada de inmediato (sesión reactivada). remoteJid=${remoteJid}`,
            'WorkflowService',
          );
        }
        return;
      }

      if (!s) {
        if (opts.logPauseDiagnostics) {
          this.logger.warn(
            `Nodo pause: no se encontró sesión para crear SessionTrigger (${remoteJid}).`,
            'WorkflowService',
          );
        }
        return;
      }

      try {
        const reactivationDate = convertDelayToSeconds(rawDelay);
        const existingTrigger =
          await this.sessionTriggerService.findBySessionId(s.id.toString());

        if (!existingTrigger) {
          await this.sessionTriggerService.create(
            s.id.toString(),
            reactivationDate,
          );
        } else {
          await this.sessionTriggerService.updateTimeBySessionId(
            s.id.toString(),
            reactivationDate,
          );
        }

        if (opts.logPauseDiagnostics) {
          this.logger.log(
            `SessionTrigger configurado para sesión ${s.id} con fecha ${reactivationDate} (delay=${rawDelay}, aiEnabled=${aiEnabled}).`,
            'WorkflowService',
          );
        }
      } catch (error: any) {
        this.logger.error(
          `Error al convertir delay "${rawDelay}" con convertDelayToSeconds en nodo pause`,
          error,
          'WorkflowService',
        );
      }

      return;
    }

    if (node.tipo.startsWith('seguimiento-')) {
      await this.scheduleWorkflowSeguimiento({
        node,
        urlevo,
        apikey,
        instanceName,
        remoteJid,
        userId,
        warnMissingSession: opts.warnMissingSessionForSeguimiento,
        flowSend: ctx.flowSend,
      });
      return;
    }

    this.logger.warn(
      `Tipo de nodo desconocido: ${node.tipo} (ID: ${node.id})`,
      'WorkflowService',
    );
  }

  private async clearSessionTriggerIfExists(sessionId: number, reason: string) {
    const existingTrigger = await this.sessionTriggerService.findBySessionId(
      sessionId.toString(),
    );
    if (!existingTrigger) {
      return;
    }

    await this.sessionTriggerService.delete(existingTrigger.id);
    this.logger.log(reason, 'WorkflowService');
  }

  private async sendWorkflowNotification(args: {
    node: WorkflowNode;
    session?: Session | null;
    urlevo: string;
    apikey: string;
    instanceName: string;
    remoteJid: string;
    userId: string;
    instanceType?: string;
  }) {
    const { node, session, urlevo, apikey, instanceName, remoteJid, userId, instanceType } =
      args;

    const phones = await this.notificationContactsService.getActiveNumbers(userId);

    if (phones.length === 0) {
      this.logger.warn(
        `Nodo notify sin números de notificación configurados (userId=${userId}, nodeId=${node.id}).`,
        'WorkflowService',
      );
      return;
    }

    const activeSession =
      session ?? (await this.getSession({ remoteJid, instanceName, userId }));
    const latestRegistro = activeSession
      ? await this.prisma.registro.findFirst({
          where: { sessionId: activeSession.id },
          orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
          select: {
            tipo: true,
            estado: true,
            resumen: true,
            detalles: true,
            nombre: true,
          },
        })
      : null;

    const notifyMessage = this.buildWorkflowNotificationMessage({
      remoteJid,
      pushName: activeSession?.pushName ?? latestRegistro?.nombre ?? '',
      latestRegistro,
      customMessage: node.message ?? '',
    });

    const notifyCtx: NodeExecCtx = {
      urlevo,
      apikey,
      instanceName,
      remoteJid,
      userId,
      instanceType,
    };
    const results = await Promise.all(
      phones.map((phone) =>
        this.wfSendText(notifyCtx, phone, notifyMessage)
          .then(() => true)
          .catch(() => false),
      ),
    );

    const failed = phones.filter((_, i) => !results[i]);
    if (failed.length > 0) {
      this.logger.warn(
        `Nodo notify no pudo enviar a ${failed.join(', ')} (nodeId=${node.id}).`,
        'WorkflowService',
      );
    }

    const sent = phones.filter((_, i) => results[i]);
    if (sent.length > 0) {
      this.logger.log(
        `Nodo notify enviado a [${sent.join(', ')}] para cliente ${remoteJid} (nodeId=${node.id}).`,
        'WorkflowService',
      );
    }
  }

  private buildWorkflowNotificationMessage(args: {
    remoteJid: string;
    pushName?: string | null;
    latestRegistro?: {
      tipo: string;
      estado: string | null;
      resumen: string | null;
      detalles: string | null;
      nombre: string | null;
    } | null;
    customMessage?: string | null;
  }) {
    const { remoteJid, pushName, latestRegistro, customMessage } = args;

    const clientPhone = remoteJid.split('@')[0] ?? remoteJid;
    const lines: string[] = [
      '✅ *Tienes una nueva notificación del workflow*',
      '',
      `👤 *Cliente:* ${pushName?.trim() || 'Sin nombre'}`,
      `📱 *WhatsApp del usuario:* +${clientPhone}`,
    ];

    if (latestRegistro?.tipo) {
      lines.push(`📌 *Tipo de registro:* ${latestRegistro.tipo}`);
    }

    if (latestRegistro?.estado) {
      lines.push(`📍 *Estado:* ${latestRegistro.estado}`);
    }

    const detail =
      latestRegistro?.resumen?.trim() ||
      latestRegistro?.detalles?.trim() ||
      customMessage?.trim();

    if (detail) {
      lines.push('', '📝 *Descripción:*', detail);
    }

    return lines.join('\n');
  }

  async continuePausedWorkflow(
    urlevo: string,
    apikey: string,
    instanceName: string,
    remoteJid: string,
    userId: string,
    incomingText: string,
  ): Promise<boolean> {
    const session = await this.getSession({ remoteJid, instanceName, userId });
    if (!session) return false;

    const waiting = await this.prisma.sessionWorkflowState.findFirst({
      where: {
        sessionId: session.id,
        intentionStatus: 'waiting',
        currentNodeId: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!waiting) return false;

    const workflow = await this.prisma.workflow.findUnique({
      where: { id: waiting.workflowId },
    });

    if (!workflow) return false;

    await this.executeWorkflow(
      workflow.name,
      urlevo,
      apikey,
      instanceName,
      remoteJid,
      userId,
      incomingText,
    );

    return true;
  }

  private async executeBasicWorkflow(
    workflow: any,
    urlevo: string,
    apikey: string,
    instanceName: string,
    remoteJid: string,
    userId: string,
    session: Session,
    pushName?: string,
    instanceType?: string,
  ) {
    const nodes = await this.prisma.workflowNode.findMany({
      where: { workflowId: workflow.id },
      orderBy: [{ order: 'asc' }],
    });

    if (!nodes.length) {
      return {
        message: 'Workflow básico sin nodos',
        workflow: workflow.name,
        totalNodes: 0,
      };
    }

    let executedCount = 0;
    // Contador de envíos compartido por toda la corrida (se consulta en el nodo
    // de seguimiento para no agendarlo si el flujo no entregó nada).
    const flowSend: FlowSendTracker = { attempted: 0, sent: 0, failed: 0 };

    for (const node of nodes) {
      // En básico no existe intention. Si aparece, lo ignoramos.
      if (node.tipo === 'intention') {
        this.logger.warn(
          `Workflow básico: nodo intention ignorado (ID: ${node.id})`,
          'WorkflowService',
        );
        continue;
      }

      this.logger.log(
        `Procesando nodo básico (ID: ${node.id}, tipo: ${node.tipo}, order: ${node.order})`,
        'WorkflowService',
      );

      await this.runNodeWithTimeout(
        node,
        { urlevo, apikey, instanceName, remoteJid, userId, pushName, instanceType, flowSend },
        {
          timeoutLabel: 'nodo básico',
          logPauseDiagnostics: false,
          warnMissingSessionForSeguimiento: false,
        },
        session,
      );
      executedCount++;

      const isLast = node === nodes[nodes.length - 1];
      if (!isLast) {
        await new Promise((res) => setTimeout(res, 5000));
      }
    }

    this.logger.log(
      `Workflow básico "${workflow.name}" ejecutado con éxito.`,
      'WorkflowService',
    );

    return {
      message: 'Workflow básico ejecutado',
      workflow: workflow.name,
      totalNodes: executedCount,
    };
  }

  private async getOrCreateSessionWorkflowState(
    sessionId: number,
    workflowId: string,
  ) {
    return this.prisma.sessionWorkflowState.upsert({
      where: {
        sessionId_workflowId: { sessionId, workflowId },
      },
      create: {
        sessionId,
        workflowId,
        intentionStatus: 'idle',
        intentionAttempts: 0,
      },
      update: {},
    });
  }

  private async validateIntentionInput(args: {
    userId: string;
    intentionPrompt: string; // prompt del modelo (interno)
    messageToUser: string; // lo que el usuario vio (node.message)
    userText: string; // respuesta actual
    recentUserTexts: string[]; // últimos N mensajes del usuario
  }): Promise<boolean> {
    const {
      userId,
      intentionPrompt,
      messageToUser,
      userText,
      recentUserTexts,
    } = args;

    // Fallback si no hay prompt
    if (!intentionPrompt) {
      const t = userText.trim();
      if (t.length < 2) return false;
      return true;
    }

    try {
      // ðŸ‘‡ La idea: el intentionPrompt manda, y nosotros solo forzamos salida booleana.
      const system = intentionPrompt;

      const userPayload = {
        question_shown_to_user: messageToUser,
        recent_user_messages: recentUserTexts,
        current_user_message: userText,
        output_rule:
          'Return ONLY JSON: {"ok": true} or {"ok": false}. No extra text.',
      };

      const raw = await this.aiAgentService.classifyBoolean({
        userId,
        systemPrompt: system,
        userJson: userPayload,
      });

      return raw === true;
    } catch (e: any) {
      this.logger.warn(
        `validateIntentionInput AI error: ${e?.message ?? e}`,
        'WorkflowService',
      );
      return false;
    }
  }

  private pickNextByHandle(edges: EdgeDB[], handle: 'yes' | 'no' | 'out') {
    return edges.find((e) => (e.sourceHandle ?? 'out') === handle) ?? null;
  }

  private async getWorkflowGraph(workflowId: string) {
    const [nodes, edges] = await Promise.all([
      this.prisma.workflowNode.findMany({ where: { workflowId } }),
      this.prisma.workflowEdge.findMany({
        where: { workflowId },
        select: { sourceId: true, targetId: true, sourceHandle: true },
      }),
    ]);

    const byId = new Map<string, NodeDB>(nodes.map((n) => [n.id, n]));

    const outgoing = new Map<string, EdgeDB[]>();
    const inDegree = new Map<string, number>();

    for (const n of nodes) inDegree.set(n.id, 0);

    for (const e of edges as any as EdgeDB[]) {
      outgoing.set(e.sourceId, [...(outgoing.get(e.sourceId) ?? []), e]);
      inDegree.set(e.targetId, (inDegree.get(e.targetId) ?? 0) + 1);
    }

    const starts = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
    const startNodeId = starts.length
      ? starts.sort((a, b) => {
          const ao = a.order ?? Number.MAX_SAFE_INTEGER;
          const bo = b.order ?? Number.MAX_SAFE_INTEGER;
          if (ao !== bo) return ao - bo;
          const ac = a.createdAt
            ? new Date(a.createdAt).getTime()
            : Number.MAX_SAFE_INTEGER;
          const bc = b.createdAt
            ? new Date(b.createdAt).getTime()
            : Number.MAX_SAFE_INTEGER;
          if (ac !== bc) return ac - bc;
          return a.id.localeCompare(b.id);
        })[0].id
      : undefined;

    return { byId, outgoing, startNodeId };
  }

  private async scheduleWorkflowSeguimiento(args: {
    node: WorkflowNode;
    urlevo: string;
    apikey: string;
    instanceName: string;
    remoteJid: string;
    userId: string;
    warnMissingSession?: boolean;
    flowSend?: FlowSendTracker;
  }) {
    const {
      node,
      urlevo,
      apikey,
      instanceName,
      remoteJid,
      userId,
      warnMissingSession,
      flowSend,
    } = args;

    // Si el flujo intentó enviar contenido y NADA se entregó (p. ej. la instancia
    // estaba desconectada), NO agendar el seguimiento de inactividad: el cliente
    // no recibió ningún mensaje, así que preguntarle luego "¿tienes dudas?" es
    // incoherente y confunde (síntoma reportado: audios que no salen pero el
    // seguimiento sí queda registrado).
    if (
      node.inactividad &&
      flowSend &&
      flowSend.attempted > 0 &&
      flowSend.sent === 0
    ) {
      this.logger.error(
        `Seguimiento de inactividad NO agendado para ${remoteJid}: el flujo no logró entregar ningún mensaje ` +
          `(intentos=${flowSend.attempted}, fallidos=${flowSend.failed}). Revisar la conexión de la instancia "${instanceName}".`,
        undefined,
        'WorkflowService',
      );
      return;
    }

    const session = await this.getSession({ remoteJid, instanceName, userId });

    if (!session) {
      if (warnMissingSession) {
        this.logger.warn(
          `Nodo seguimiento: no se encontró sesión para ${remoteJid}.`,
          'WorkflowService',
        );
      }
      return;
    }

    // Guard de idempotencia: si ya existe un seguimiento pendiente para este mismo nodo
    // y sesión, no crear duplicado (puede ocurrir si el workflow re-ejecuta el nodo).
    const existingPending = await this.prisma.seguimiento.findFirst({
      where: {
        idNodo: node.id,
        instancia: instanceName,
        remoteJid,
        followUpStatus: { in: ['pending', 'processing'] },
      },
      select: { id: true },
    });

    if (existingPending) {
      this.logger.log(
        `Seguimiento inactividad para nodo ${node.id} ya está pendiente (id=${existingPending.id}). Saltando creación duplicada.`,
        'WorkflowService',
      );
      return;
    }

    const seguimiento = await this.prisma.seguimiento.create({
      data: {
        idNodo: node.id,
        serverurl: urlevo,
        instancia: instanceName,
        apikey,
        remoteJid,
        mensaje: node.message ?? '',
        tipo: node.tipo,
        time: convertDelayToSeconds(node.delay ?? ''),
        media: node.url ?? null,
        followUpMode: 'static',
        followUpStatus: 'pending',
      },
    });

    const seguimientoId = seguimiento.id.toString();
    const nextSeguimientos = this.buildSeguimientoID({
      seguimientos: session.seguimientos,
      current: seguimientoId,
    });

    await this.registerIdSeguimientoInSession(
      seguimientoId,
      remoteJid,
      instanceName,
      userId,
      nextSeguimientos,
    );

    if (node.inactividad) {
      const nextInactividad = this.buildSeguimientoID({
        seguimientos: session.inactividad,
        current: seguimientoId,
      });

      await this.registerIdsInactividadInSession(
        seguimientoId,
        remoteJid,
        instanceName,
        userId,
        nextInactividad,
      );
    }

    this.logger.log(
      `Seguimiento workflow programado (${seguimiento.id}) para ${remoteJid} con delay ${node.delay ?? ''}.`,
      'WorkflowService',
    );
  }

  private async registerIdsInactividadInSession(
    seguimientoId: string,
    remoteJid: string,
    instanceName: string,
    userId: string,
    inactividad: string,
  ) {
    await this.prisma.session.updateMany({
      where: { userId, remoteJid, instanceId: instanceName },
      data: { inactividad },
    });

    this.logger.log(
      `Registrado seguimiento de inactividad ${seguimientoId} en Session.inactividad (${remoteJid})`,
      'WorkflowService',
    );
  }

  async getWorkflow(userId: string) {
    this.logger.log(
      'Obteniendo lista de workflows disponibles by userId...',
      'WorkflowService',
    );

    if (!userId) {
      return [];
    }

    try {
      const workflows = await this.prisma.workflow.findMany({
        where: {
          userId,
        },
        orderBy: {
          createdAt: 'asc',
        },
      });
      return workflows;
    } catch (error) {
      this.logger.error(
        'Error al obtener los workflows:"',
        (error as any)?.message || String(error),
        'WorkflowService',
      );
      return [];
    }
  }

  async findWorkflowByName(userId: string, name: string) {
    try {
      return await this.prisma.workflow.findFirst({
        where: {
          userId,
          name: { equals: name, mode: 'insensitive' },
        },
      });
    } catch {
      return null;
    }
  }

  async getFunnelFlows(userId: string) {
    try {
      return await this.prisma.workflow.findMany({
        where: { userId, isFunnelStep: true },
        orderBy: { order: 'asc' },
      });
    } catch {
      return [];
    }
  }

  async findWelcomeWorkflow(userId: string, fallbackName: string) {
    try {
      const byToggle = await this.prisma.workflow.findFirst({
        where: { userId, triggerOnNewSession: true },
      });
      if (byToggle) return byToggle;

      return await this.prisma.workflow.findFirst({
        where: { userId, name: { equals: fallbackName, mode: 'insensitive' } },
      });
    } catch {
      return null;
    }
  }

  private async registerIdSeguimientoInSession(
    id: string,
    remoteJid: string,
    instanceId: string,
    userId: string,
    seguimientos: string,
  ): Promise<void> {
    this.logger.log(
      `Almacenando nuevo ID de seguimiento: ${id} en sesión ${remoteJid}`,
      'WorkflowService',
    );
    try {
      await this.sessionService.registerSeguimientos(
        seguimientos,
        remoteJid,
        instanceId,
        userId,
      );
      this.logger.log(
        `ID de seguimiento ${id} almacenado exitosamente en sesión ${remoteJid}`,
        'WorkflowService',
      );
    } catch (error) {
      this.logger.error(
        `Error almacenando ID de seguimiento ${id} en sesión ${remoteJid}: ${(error as any)?.message || String(error)}`,
        'WorkflowService',
      );
    }
  }

  private async getSession({
    remoteJid,
    instanceName,
    userId,
  }: getSessionInterface): Promise<Session | null> {
    try {
      const session = await this.sessionService.getSession(
        remoteJid,
        instanceName,
        userId,
      );

      if (!session) {
        return null;
      }

      return session;
    } catch (error) {
      this.logger.error(
        `Error obteniendo la sesión de ${remoteJid} en la instancia ${instanceName}`,
        (error as any)?.message || String(error),
        'WorkflowService',
      );
      return null;
    }
  }

  private buildSeguimientoID({
    seguimientos,
    current,
  }: {
    seguimientos: string | null;
    current: string;
  }): string {
    if (!seguimientos || seguimientos.trim() === '') {
      // No había seguimientos anteriores, retornamos solo el nuevo
      return current;
    }

    // Si ya había seguimientos, concatenamos el nuevo al final
    return `${seguimientos}-${current}`;
  }

  async getWorkflowByWorkflowId(workflowId: string) {
    this.logger.log(
      'Obteniendo lista de workflows disponibles by workflowId...',
      'WorkflowService',
    );
    try {
      const workflows = await this.prisma.workflow.findFirst({
        where: {
          id: workflowId,
        },
        orderBy: {
          createdAt: 'asc',
        },
      });
      return workflows;
    } catch (error) {
      this.logger.error(
        'Error al obtener los workflows:"',
        (error as any)?.message || String(error),
        'WorkflowService',
      );
      return null;
    }
  }

  async getWorkflowNodes(workflowId: string) {
    return this.prisma.workflowNode.findMany({
      where: { workflowId },
      orderBy: { order: 'asc' },
    });
  }

  private parseDescriptionConfig(
    description: string | null,
  ): { matchType: 'Contiene' | 'Exacta'; keywords: string[] } | null {
    if (!description) return null;

    try {
      const parsed = JSON.parse(description);

      if (!parsed || typeof parsed !== 'object') return null;

      // ðŸ”¹ matchType: case-insensitive ("Exacta", "exacta", "EXACTA")
      const rawMatchType = (parsed.matchType as string) || 'Contiene';
      const normalizedMatchType = rawMatchType.toString().toLowerCase();

      const matchType: 'Contiene' | 'Exacta' =
        normalizedMatchType === 'exacta' ? 'Exacta' : 'Contiene';

      // ðŸ”¹ Aceptar "keyword" o "keywords"
      const rawKeyword = (parsed.keyword ?? parsed.keywords) as
        | string
        | string[]
        | undefined;

      let keywords: string[] = [];

      if (typeof rawKeyword === 'string') {
        if (rawKeyword.trim() !== '') {
          keywords = [rawKeyword];
        }
      } else if (Array.isArray(rawKeyword)) {
        keywords = rawKeyword.filter(
          (k) => typeof k === 'string' && k.trim() !== '',
        );
      }

      if (keywords.length === 0) {
        this.logger.warn(
          `parseDescriptionConfig: no se encontraron keywords en descripción: ${description}`,
          'WorkflowService',
        );
        return null;
      }

      return {
        matchType,
        keywords,
      };
    } catch (error) {
      this.logger.warn(
        `Descripción de workflow no es un JSON válido: ${description}`,
        'WorkflowService',
      );
      return null;
    }
  }

  async findWorkflowByDescriptionMatch(userId: string, text: string) {
    const cleanText = (text || '').trim().toLowerCase();
    if (!cleanText) return null;

    // Solo workflows que tengan description
    const workflows = await this.prisma.workflow.findMany({
      where: {
        userId,
        description: {
          not: null,
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    for (const wf of workflows) {
      const config = this.parseDescriptionConfig(wf.description);
      if (!config) continue;

      for (const kw of config.keywords) {
        const keyword = kw.trim().toLowerCase();
        if (!keyword) continue;

        let match = false;

        if (config.matchType === 'Exacta') {
          // Coincidencia exacta (ignorando mayúsculas/minúsculas y espacios)
          match = cleanText === keyword;
        } else {
          // Contiene: si el texto incluye alguna de las palabras clave
          match = cleanText.includes(keyword);
        }

        if (match) {
          this.logger.log(
            `Workflow por descripción encontrado: "${wf.name}" (matchType=${config.matchType}, keyword="${kw}")`,
            'WorkflowService',
          );
          return wf;
        }
      }
    }

    this.logger.log(
      `No se encontró workflow por descripción para el texto: "${cleanText}"`,
      'WorkflowService',
    );
    return null;
  }
}
