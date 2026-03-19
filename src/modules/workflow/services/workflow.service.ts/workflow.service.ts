import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { NodeSenderService } from '../node-sender.service.ts/node-sender.service';
import { LoggerService } from 'src/core/logger/logger.service';
import { convertDelayToSeconds } from 'src/modules/webhook/utils/convert-delay-to-seconds.helper';
import { Session, WorkflowNode } from '@prisma/client';
import { SessionService } from 'src/modules/session/session.service';
import { SessionTriggerService } from 'src/modules/session-trigger/session-trigger.service';
import { PrismaService } from 'src/database/prisma.service';
import { ChatHistoryService } from '../../../chat-history/chat-history.service';
import { buildChatHistorySessionId } from '../../../chat-history/chat-history-session.helper';
import type { AiAgentService } from '../../../ai-agent/ai-agent.service';

type NodeDB = WorkflowNode;
type EdgeDB = { sourceId: string; targetId: string; sourceHandle: string | null };

type NodeExecCtx = {
    urlevo: string;
    apikey: string;
    instanceName: string;
    remoteJid: string;
    userId: string;
};

type RunNodeOptions = {
    timeoutLabel: string; // "nodo" | "nodo bÃ¡sico"
    logPauseDiagnostics?: boolean; // logs extra del pause (pro=true, basic=false)
    warnMissingSessionForSeguimiento?: boolean; // pro=true, basic=false
};


interface getSessionInterface {
    remoteJid: string;
    instanceName: string;
    userId: string;
}
@Injectable()
export class WorkflowService implements OnModuleInit {
    private aiAgentService!: AiAgentService;

    constructor(
        private prisma: PrismaService,
        private nodeSenderService: NodeSenderService,
        private logger: LoggerService,
        private sessionService: SessionService,
        private readonly sessionTriggerService: SessionTriggerService,
        private readonly moduleRef: ModuleRef,
        private readonly chatHistoryService: ChatHistoryService,
    ) { }

    onModuleInit() {
        const { AiAgentService } = require('../../../ai-agent/ai-agent.service');
        this.aiAgentService = this.moduleRef.get(AiAgentService, { strict: false });
    }

    private readonly NODE_TIMEOUT_MS = 15000;

    private async getRecentUserTextsForIntention(instanceName: string, remoteJid: string, limit: number): Promise<string[]> {
        const sessionHistoryId = buildChatHistorySessionId(instanceName, remoteJid);
        const chatHistory = await this.chatHistoryService.getChatHistory(sessionHistoryId);
        return chatHistory.slice(-limit).map(t => (t ?? '').trim()).filter(Boolean);
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
    ) {
        const result = await this.prisma.workflow.findFirst({
            where: { name: name_flujo, userId },
            orderBy: { createdAt: 'asc' },
        });

        if (!result) {
            this.logger.warn(`Workflow no encontrado: ${name_flujo}`, 'WorkflowService');
            throw new NotFoundException('Workflow no encontrado');
        }

        // obtener sesiÃ³n para sessionId (estado por conversaciÃ³n)
        const session = await this.getSession({ remoteJid, instanceName, userId });
        if (!session) {
            this.logger.warn(
                `No se encontrÃ³ sesiÃ³n para ejecutar workflow (${remoteJid}).`,
                'WorkflowService',
            );
            return { message: 'No session', workflow: result.name, totalNodes: 0 };
        }

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
                return { message: 'Skipped (lock active)', workflow: result.name, totalNodes: 0 };
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
                );
            }

            // =========================
            // PRO: estado por sesiÃ³n + workflow
            // =========================
            let state = await this.getOrCreateSessionWorkflowState(session.id, result.id);

            const { byId, outgoing, startNodeId } = await this.getWorkflowGraph(result.id);
            if (!startNodeId) {
                throw new NotFoundException('Workflow invÃ¡lido: no hay nodo inicial');
            }

            let currentId: string | undefined =
                state.intentionStatus === 'waiting' && state.currentNodeId
                    ? state.currentNodeId
                    : startNodeId;

            let executedCount = 0;

            while (currentId) {
                const node = byId.get(currentId);
                if (!node) break;

                this.logger.log(
                    `Procesando nodo pro (ID: ${node.id}, tipo: ${node.tipo})`,
                    'WorkflowService',
                );

                // ===========================
                // NODO INTENTION (PAUSA/ITERACIÃ“N)
                // ===========================
                if (node.tipo === 'intention') {
                    const intentionPrompt = ((node as any).intentionPrompt ?? '').trim();
                    const messageToUser = (node.message ?? '').trim();
                    const maxAttempts = Number((node as any).intentionMaxAttempts ?? 3);

                    const isWaitingHere =
                        state.intentionStatus === 'waiting' && state.currentNodeId === node.id;

                    if (!isWaitingHere) {
                        if (messageToUser) {
                            const url = `${urlevo}/message/sendText/${instanceName}`;
                            await this.nodeSenderService.sendTextNode(url, apikey, remoteJid, messageToUser);
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
                        return { message: 'Waiting user input', workflow: result.name, totalNodes: executedCount };
                    }

                    const prevData = (state.intentionData as any) ?? {};
                    //TODO: Se quema maxAttempts para no traer todo el historial, pero ideal serÃ­a marcar de alguna forma los mensajes relacionados a la intenciÃ³n (ej: con metadata) para traer solo esos. 
                    const recentUserTexts = await this.getRecentUserTextsForIntention(instanceName, remoteJid, 15);

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

                        const next = this.pickNextByHandle(outgoing.get(node.id) ?? [], 'yes');
                        if (!next) return { message: 'No YES branch', workflow: result.name, totalNodes: executedCount };

                        currentId = next.targetId;
                        continue;
                    }

                    const nextAttempts = (state.intentionAttempts ?? 0) + 1;

                    if (nextAttempts < maxAttempts) {
                        if (messageToUser) {
                            const url = `${urlevo}/message/sendText/${instanceName}`;
                            await this.nodeSenderService.sendTextNode(url, apikey, remoteJid, messageToUser);
                        }

                        state = await this.prisma.sessionWorkflowState.update({
                            where: { id: state.id },
                            data: {
                                intentionAttempts: nextAttempts,
                                lastPromptAt: new Date(),
                            },
                        });

                        return { message: 'Retry intention', workflow: result.name, totalNodes: executedCount };
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
                    if (!next) return { message: 'No NO branch', workflow: result.name, totalNodes: executedCount };

                    currentId = next.targetId;
                    continue;
                }

                await this.runNodeWithTimeout(
                    node,
                    { urlevo, apikey, instanceName, remoteJid, userId },
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
            }

            this.logger.log(`Workflow "${result.name}" ejecutado con Ã©xito.`, 'WorkflowService');

            return {
                message: 'Workflow ejecutado',
                workflow: result.name,
                totalNodes: executedCount,
            };
        } finally {
            await this.prisma.workflowExecutionLock.deleteMany({ where: { lockKey } });
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
                    setTimeout(() => reject(new Error('Tiempo de espera excedido')), timeoutMs),
                ),
            ]);
        } catch (error: any) {
            this.logger.warn(
                `Timeout procesando ${opts.timeoutLabel} ID: ${node.id}, ${error?.response?.data || error?.message}`,
                'WorkflowService',
            );
        }
    }

    private async sendNodeCommon(
        node: WorkflowNode,
        ctx: NodeExecCtx,
        opts: RunNodeOptions,
        session?: Session | null,
    ) {
        const { urlevo, apikey, instanceName, remoteJid, userId } = ctx;

        if (node.tipo === 'delay') {
            const delayTime = node?.delay || 15000;
            this.logger.log(`Esperando ${delayTime}ms (nodo ID: ${node.id})`, 'WorkflowService');
            await new Promise((res) => setTimeout(res, Number(delayTime)));
            return;
        }

        if (node.tipo === 'text') {
            const url = `${urlevo}/message/sendText/${instanceName}`;
            await this.nodeSenderService.sendTextNode(url, apikey, remoteJid, node.message);
            return;
        }

        if (['image', 'video', 'document'].includes(node.tipo)) {
            const url = `${urlevo}/message/sendMedia/${instanceName}`;
            await this.nodeSenderService.sendMediaNode(
                url,
                apikey,
                remoteJid,
                node.tipo,
                node.message,
                node.url as string,
            );
            return;
        }

        if (node.tipo === 'audio') {
            const url = `${urlevo}/message/sendWhatsAppAudio/${instanceName}`;
            await this.nodeSenderService.sendAudioNode(url, apikey, remoteJid, node.url as string);
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
            });
            return;
        }

        if (node.tipo === 'node_pause') {
            this.logger.log(
                `Nodo pause: pausando sesiÃ³n para ${remoteJid} en instancia ${instanceName}`,
                'WorkflowService',
            );

            await this.sessionService.updateSessionStatus(remoteJid, instanceName, false, userId);

            const s = session ?? (await this.getSession({ remoteJid, instanceName, userId }));
            const aiEnabled = (node as WorkflowNode & { aiEnabled?: boolean | null }).aiEnabled === true;

            if (!aiEnabled) {
                if (s) {
                    await this.clearSessionTriggerIfExists(
                        s.id,
                        `Nodo pause con IA desactivada. Se elimina SessionTrigger previo si existe (${remoteJid}).`,
                    );
                } else if (opts.logPauseDiagnostics) {
                    this.logger.log(
                        `Nodo pause con IA desactivada y sin sesiÃ³n disponible. No hay trigger para limpiar (${remoteJid}).`,
                        'WorkflowService',
                    );
                }
                return;
            }

            const rawDelay = node.delay ?? '';
            if (!rawDelay) {
                if (s) {
                    await this.clearSessionTriggerIfExists(
                        s.id,
                        `Nodo pause sin delay. Se elimina SessionTrigger previo si existe (${remoteJid}).`,
                    );
                }
                if (opts.logPauseDiagnostics) {
                    this.logger.log(
                        `Nodo pause sin delay definido. No se crea SessionTrigger (remoteJid=${remoteJid}).`,
                        'WorkflowService',
                    );
                }
                return;
            }

            const [unit, valueStr] = rawDelay.split('-');
            const value = parseInt(valueStr, 10);

            if (!['seconds', 'minutes', 'hours', 'days'].includes(unit) || isNaN(value)) {
                if (s) {
                    await this.clearSessionTriggerIfExists(
                        s.id,
                        `Nodo pause con delay invÃ¡lido "${rawDelay}". Se elimina SessionTrigger previo si existe.`,
                    );
                }
                if (opts.logPauseDiagnostics) {
                    this.logger.warn(
                        `Nodo pause con delay invÃ¡lido "${rawDelay}". No se crea SessionTrigger.`,
                        'WorkflowService',
                    );
                }
                return;
            }

            if (value <= 0) {
                if (s) {
                    await this.clearSessionTriggerIfExists(
                        s.id,
                        `Nodo pause con delay 0. Se elimina SessionTrigger previo si existe (${remoteJid}).`,
                    );
                }
                if (opts.logPauseDiagnostics) {
                    this.logger.log(
                        `Nodo pause con delay 0. Solo se pausa la sesiÃ³n, sin SessionTrigger.`,
                        'WorkflowService',
                    );
                }
                return;
            }

            if (!s) {
                if (opts.logPauseDiagnostics) {
                    this.logger.warn(
                        `Nodo pause: no se encontrÃ³ sesiÃ³n para crear SessionTrigger (${remoteJid}).`,
                        'WorkflowService',
                    );
                }
                return;
            }

            try {
                const reactivationDate = convertDelayToSeconds(rawDelay);
                const existingTrigger = await this.sessionTriggerService.findBySessionId(s.id.toString());

                if (!existingTrigger) {
                    await this.sessionTriggerService.create(s.id.toString(), reactivationDate);
                } else {
                    await this.sessionTriggerService.updateTimeBySessionId(s.id.toString(), reactivationDate);
                }

                if (opts.logPauseDiagnostics) {
                    this.logger.log(
                        `SessionTrigger configurado para sesiÃ³n ${s.id} con fecha ${reactivationDate} (delay=${rawDelay}, aiEnabled=${aiEnabled}).`,
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
            });
            return;
        }

        this.logger.warn(`Tipo de nodo desconocido: ${node.tipo} (ID: ${node.id})`, 'WorkflowService');
    }

    private async clearSessionTriggerIfExists(sessionId: number, reason: string) {
        const existingTrigger = await this.sessionTriggerService.findBySessionId(sessionId.toString());
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
    }) {
        const { node, session, urlevo, apikey, instanceName, remoteJid, userId } = args;

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { notificationNumber: true },
        });

        const notificationNumber = (user?.notificationNumber ?? '').trim();
        if (!notificationNumber || notificationNumber === '0000000000') {
            this.logger.warn(
                `Nodo notify sin notificationNumber configurado (userId=${userId}, nodeId=${node.id}).`,
                'WorkflowService',
            );
            return;
        }

        const activeSession = session ?? (await this.getSession({ remoteJid, instanceName, userId }));
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

        const url = `${urlevo}/message/sendText/${instanceName}`;
        const sent = await this.nodeSenderService.sendTextNode(
            url,
            apikey,
            notificationNumber,
            notifyMessage,
        );

        if (!sent) {
            this.logger.warn(
                `Nodo notify no pudo enviar mensaje a ${notificationNumber} (nodeId=${node.id}).`,
                'WorkflowService',
            );
            return;
        }

        this.logger.log(
            `Nodo notify enviado a ${notificationNumber} para cliente ${remoteJid} (nodeId=${node.id}).`,
            'WorkflowService',
        );
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
    ) {
        const nodes = await this.prisma.workflowNode.findMany({
            where: { workflowId: workflow.id },
            orderBy: [
                { order: 'asc' },
            ],
        });

        if (!nodes.length) {
            return { message: 'Workflow bÃ¡sico sin nodos', workflow: workflow.name, totalNodes: 0 };
        }

        let executedCount = 0;

        for (const node of nodes) {
            // En bÃ¡sico no existe intention. Si aparece, lo ignoramos.
            if (node.tipo === 'intention') {
                this.logger.warn(
                    `Workflow bÃ¡sico: nodo intention ignorado (ID: ${node.id})`,
                    'WorkflowService',
                );
                continue;
            }

            this.logger.log(
                `Procesando nodo bÃ¡sico (ID: ${node.id}, tipo: ${node.tipo}, order: ${node.order})`,
                'WorkflowService',
            );

            await this.runNodeWithTimeout(
                node,
                { urlevo, apikey, instanceName, remoteJid, userId },
                {
                    timeoutLabel: 'nodo bÃ¡sico',
                    logPauseDiagnostics: false,
                    warnMissingSessionForSeguimiento: false,
                },
                session,
            );
            executedCount++;
        }

        this.logger.log(`Workflow bÃ¡sico "${workflow.name}" ejecutado con Ã©xito.`, 'WorkflowService');

        return {
            message: 'Workflow bÃ¡sico ejecutado',
            workflow: workflow.name,
            totalNodes: executedCount,
        };
    }

    private async getOrCreateSessionWorkflowState(sessionId: number, workflowId: string) {
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
        intentionPrompt: string;   // prompt del modelo (interno)
        messageToUser: string;     // lo que el usuario vio (node.message)
        userText: string;          // respuesta actual
        recentUserTexts: string[]; // Ãºltimos N mensajes del usuario
    }): Promise<boolean> {
        const { userId, intentionPrompt, messageToUser, userText, recentUserTexts } = args;

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
                output_rule: 'Return ONLY JSON: {"ok": true} or {"ok": false}. No extra text.',
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
        const startNodeId = starts.length ? starts.sort((a, b) => {
            const ao = a.order ?? Number.MAX_SAFE_INTEGER;
            const bo = b.order ?? Number.MAX_SAFE_INTEGER;
            if (ao !== bo) return ao - bo;
            const ac = a.createdAt ? new Date(a.createdAt).getTime() : Number.MAX_SAFE_INTEGER;
            const bc = b.createdAt ? new Date(b.createdAt).getTime() : Number.MAX_SAFE_INTEGER;
            if (ac !== bc) return ac - bc;
            return a.id.localeCompare(b.id);
        })[0].id : undefined;

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
    }) {
        const { node, urlevo, apikey, instanceName, remoteJid, userId, warnMissingSession } = args;
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

        const delaySeguimiento = convertDelayToSeconds(node.delay ?? '') ?? 0;
        const seguimiento = await this.prisma.seguimiento.create({
            data: {
                idNodo: node.id,
                serverurl: urlevo,
                instancia: instanceName,
                apikey,
                remoteJid,
                mensaje: node.message ?? '',
                tipo: node.tipo,
                time: delaySeguimiento,
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
            `Seguimiento workflow programado (${seguimiento.id}) para ${remoteJid} con delay ${delaySeguimiento}.`,
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
        this.logger.log('Obteniendo lista de workflows disponibles by userId...', 'WorkflowService');

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
            this.logger.error('Error al obtener los workflows:"', error, 'WorkflowService');
            return [];
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
            `Almacenando nuevo ID de seguimiento: ${id} en sesiÃ³n ${remoteJid}`,
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
                `ID de seguimiento ${id} almacenado exitosamente en sesiÃ³n ${remoteJid}`,
                'WorkflowService',
            );
        } catch (error) {
            this.logger.error(
                `Error almacenando ID de seguimiento ${id} en sesiÃ³n ${remoteJid}: ${error.message}`,
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
            const session = await this.sessionService.getSession(remoteJid, instanceName, userId);

            if (!session) {
                return null;
            }

            return session;
        } catch (error) {
            this.logger.error(
                `Error obteniendo la sesiÃ³n de ${remoteJid} en la instancia ${instanceName}`,
                error?.message || error,
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
            // No habÃ­a seguimientos anteriores, retornamos solo el nuevo
            return current;
        }

        // Si ya habÃ­a seguimientos, concatenamos el nuevo al final
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
            this.logger.error('Error al obtener los workflows:"', error, 'WorkflowService');
            return null;
        }
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
                    `parseDescriptionConfig: no se encontraron keywords en descripciÃ³n: ${description}`,
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
                `DescripciÃ³n de workflow no es un JSON vÃ¡lido: ${description}`,
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
            const config = this.parseDescriptionConfig(wf.description as string | null);
            if (!config) continue;

            for (const kw of config.keywords) {
                const keyword = kw.trim().toLowerCase();
                if (!keyword) continue;

                let match = false;

                if (config.matchType === 'Exacta') {
                    // Coincidencia exacta (ignorando mayÃºsculas/minÃºsculas y espacios)
                    match = cleanText === keyword;
                } else {
                    // Contiene: si el texto incluye alguna de las palabras clave
                    match = cleanText.includes(keyword);
                }

                if (match) {
                    this.logger.log(
                        `Workflow por descripciÃ³n encontrado: "${wf.name}" (matchType=${config.matchType}, keyword="${kw}")`,
                        'WorkflowService',
                    );
                    return wf;
                }
            }
        }

        this.logger.log(
            `No se encontrÃ³ workflow por descripciÃ³n para el texto: "${cleanText}"`,
            'WorkflowService',
        );
        return null;
    }
}



