import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { NodeSenderService } from '../node-sender.service.ts/node-sender.service';
import { LoggerService } from 'src/core/logger/logger.service';
import { SeguimientosService } from 'src/modules/seguimientos/seguimientos.service';
import { convertDelayToSeconds } from 'src/modules/webhook/utils/convert-delay-to-seconds.helper';
import { Prisma, Session, WorkflowNode } from '@prisma/client';
import { SessionService } from 'src/modules/session/session.service';
import { SessionTriggerService } from 'src/modules/session-trigger/session-trigger.service';
import { PrismaService } from 'src/database/prisma.service';

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
    timeoutLabel: string; // "nodo" | "nodo básico"
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
        private seguimientosService: SeguimientosService,
        private logger: LoggerService,
        private sessionService: SessionService,
        private readonly sessionTriggerService: SessionTriggerService,
        private readonly moduleRef: ModuleRef,
    ) { }

    onModuleInit() {
        const { AiAgentService } = require('../../../ai-agent/ai-agent.service');
        this.aiAgentService = this.moduleRef.get(AiAgentService, { strict: false });
    }

    private readonly NODE_TIMEOUT_MS = 15000;

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

        // obtener sesión para sessionId (estado por conversación)
        const session = await this.getSession({ remoteJid, instanceName, userId });
        if (!session) {
            this.logger.warn(
                `No se encontró sesión para ejecutar workflow (${remoteJid}).`,
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
                    `⏭ Workflow SKIPPED (lock activo). name=${result.name} remoteJid=${remoteJid}`,
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
            // PRO: estado por sesión + workflow
            // =========================
            let state = await this.getOrCreateSessionWorkflowState(session.id, result.id);

            const { byId, outgoing, startNodeId } = await this.getWorkflowGraph(result.id);
            if (!startNodeId) {
                throw new NotFoundException('Workflow inválido: no hay nodo inicial');
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
                // NODO INTENTION (PAUSA/ITERACIÓN)
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
                    const prevRecent: string[] = Array.isArray(prevData.recentUserTexts) ? prevData.recentUserTexts : [];
                    const recentUserTexts = [...prevRecent, text].slice(-maxAttempts);

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

            this.logger.log(`Workflow "${result.name}" ejecutado con éxito.`, 'WorkflowService');

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

        if (node.tipo === 'node_pause') {
            this.logger.log(
                `Nodo pause: pausando sesión para ${remoteJid} en instancia ${instanceName}`,
                'WorkflowService',
            );

            await this.sessionService.updateSessionStatus(remoteJid, instanceName, false, userId);

            const rawDelay = node.delay ?? '';
            if (!rawDelay) {
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
                if (opts.logPauseDiagnostics) {
                    this.logger.warn(
                        `Nodo pause con delay inválido "${rawDelay}". No se crea SessionTrigger.`,
                        'WorkflowService',
                    );
                }
                return;
            }

            if (value <= 0) {
                if (opts.logPauseDiagnostics) {
                    this.logger.log(
                        `Nodo pause con delay 0. Solo se pausa la sesión, sin SessionTrigger.`,
                        'WorkflowService',
                    );
                }
                return;
            }

            const s = session ?? (await this.getSession({ remoteJid, instanceName, userId }));
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
                await this.sessionTriggerService.create(s.id.toString(), reactivationDate);

                if (opts.logPauseDiagnostics) {
                    this.logger.log(
                        `SessionTrigger creado para sesión ${s.id} con fecha ${reactivationDate} (delay=${rawDelay}).`,
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
            const delaySeguimiento = convertDelayToSeconds(node.delay ?? '');

            const seguimientoData = Prisma.validator<Prisma.SeguimientoUncheckedCreateInput>()({
                idNodo: node.id,
                serverurl: urlevo,
                instancia: instanceName,
                apikey,
                remoteJid,
                mensaje: node.message,
                tipo: node.tipo,
                media: node.url,
                time: delaySeguimiento ?? '',
                nameFile: node.nameFile,
                consecutivo: '',
            });

            const { id } = await this.seguimientosService.createSeguimiento(seguimientoData);

            const s = session ?? (await this.getSession({ remoteJid, instanceName, userId }));
            if (!s) {
                if (opts.warnMissingSessionForSeguimiento) {
                    this.logger.warn(
                        `No se pudo registrar el seguimiento porque la sesión no existe: ${remoteJid}`,
                        'WorkflowService',
                    );
                }
                return;
            }

            const seguimientos = this.buildSeguimientoID({
                seguimientos: s.seguimientos,
                current: id.toString(),
            });

            await this.registerIdSeguimientoInSession(
                id.toString(),
                remoteJid,
                instanceName,
                userId,
                seguimientos,
            );

            if (node.inactividad) {
                const nuevosIdsInactividad = this.buildSeguimientoID({
                    seguimientos: s.inactividad,
                    current: id.toString(),
                });

                await this.registerIdsInactividadInSession(
                    id.toString(),
                    remoteJid,
                    instanceName,
                    userId,
                    nuevosIdsInactividad,
                );
            }

            return;
        }

        this.logger.warn(`Tipo de nodo desconocido: ${node.tipo} (ID: ${node.id})`, 'WorkflowService');
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
            return { message: 'Workflow básico sin nodos', workflow: workflow.name, totalNodes: 0 };
        }

        let executedCount = 0;

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
                { urlevo, apikey, instanceName, remoteJid, userId },
                {
                    timeoutLabel: 'nodo básico',
                    logPauseDiagnostics: false,
                    warnMissingSessionForSeguimiento: false,
                },
                session,
            );
            executedCount++;
        }

        this.logger.log(`Workflow básico "${workflow.name}" ejecutado con éxito.`, 'WorkflowService');

        return {
            message: 'Workflow básico ejecutado',
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
        recentUserTexts: string[]; // últimos N mensajes del usuario
    }): Promise<boolean> {
        const { userId, intentionPrompt, messageToUser, userText, recentUserTexts } = args;

        // Fallback si no hay prompt
        if (!intentionPrompt) {
            const t = userText.trim();
            if (t.length < 2) return false;
            return true;
        }

        try {
            // 👇 La idea: el intentionPrompt manda, y nosotros solo forzamos salida booleana.
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
                `Error almacenando ID de seguimiento ${id} en sesión ${remoteJid}: ${error.message}`,
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
                `Error obteniendo la sesión de ${remoteJid} en la instancia ${instanceName}`,
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

            // 🔹 matchType: case-insensitive ("Exacta", "exacta", "EXACTA")
            const rawMatchType = (parsed.matchType as string) || 'Contiene';
            const normalizedMatchType = rawMatchType.toString().toLowerCase();

            const matchType: 'Contiene' | 'Exacta' =
                normalizedMatchType === 'exacta' ? 'Exacta' : 'Contiene';

            // 🔹 Aceptar "keyword" o "keywords"
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
            const config = this.parseDescriptionConfig(wf.description as string | null);
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