import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { NodeSenderService } from '../node-sender.service.ts/node-sender.service';
import { LoggerService } from 'src/core/logger/logger.service';
import { SeguimientosService } from 'src/modules/seguimientos/seguimientos.service';
import { convertDelayToSeconds } from 'src/modules/webhook/utils/convert-delay-to-seconds.helper';
import { Session, WorkflowNode } from '@prisma/client';
import { SessionService } from 'src/modules/session/session.service';
import { SessionTriggerService } from 'src/modules/session-trigger/session-trigger.service';

type NodeDB = WorkflowNode;
type EdgeDB = { sourceId: string; targetId: string; sourceHandle: string | null };

interface getSessionInterface {
    remoteJid: string;
    instanceName: string;
    userId: string;
}

@Injectable()
export class WorkflowService {
    constructor(
        private prisma: PrismaService,
        private nodeSenderService: NodeSenderService,
        private seguimientosService: SeguimientosService,
        private logger: LoggerService,
        private sessionService: SessionService,
        private readonly sessionTriggerService: SessionTriggerService,
    ) { }

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
            orderBy: {
                createdAt: 'asc',
            },
        });

        if (!result) {
            this.logger.warn(`Workflow no encontrado: ${name_flujo}`, 'WorkflowService');
            throw new NotFoundException('Workflow no encontrado');
        }

        // ✅ obtener sesión para sessionId (estado por conversación)
        const session = await this.getSession({ remoteJid, instanceName, userId });
        if (!session) {
            this.logger.warn(
                `No se encontró sesión para ejecutar workflow (${remoteJid}).`,
                'WorkflowService',
            );
            return { message: 'No session', workflow: result.name, totalNodes: 0 };
        }

        // ✅ estado por sesión + workflow
        let state = await this.getOrCreateSessionWorkflowState(session.id, result.id);

        // ✅ cargar grafo (nodos/edges)
        const { byId, outgoing, startNodeId } = await this.getWorkflowGraph(result.id);

        if (!startNodeId) {
            throw new NotFoundException('Workflow inválido: no hay nodo inicial');
        }

        // Si está esperando en un nodo intention, arrancamos desde ahí.
        // Si NO hay incomingText, no hacemos nada (ya se envió el prompt antes).
        let currentId: string | undefined =
            state.intentionStatus === 'waiting' && state.currentNodeId
                ? state.currentNodeId
                : startNodeId;

        let executedCount = 0;

        // ✅ ejecución por recorrido del grafo
        while (currentId) {
            const node = byId.get(currentId);
            if (!node) break;

            this.logger.log(`Procesando nodo (ID: ${node.id}, tipo: ${node.tipo})`, 'WorkflowService');

            // ===========================
            // ✅ NODO INTENTION (PAUSA/ITERACIÓN)
            // ===========================
            if (node.tipo === 'intention') {
                const promptToSend = (node as any).intentionPrompt?.trim() || node.message?.trim() || '';

                const maxAttempts = Number((node as any).intentionMaxAttempts ?? 3);

                // Si no está esperando aún en este intention -> envía prompt y pausa
                const isWaitingHere =
                    state.intentionStatus === 'waiting' && state.currentNodeId === node.id;

                if (!isWaitingHere) {
                    if (promptToSend) {
                        const url = `${urlevo}/message/sendText/${instanceName}`;
                        await this.nodeSenderService.sendTextNode(url, apikey, remoteJid, promptToSend);
                    }

                    state = await this.prisma.sessionWorkflowState.update({
                        where: { id: state.id },
                        data: {
                            currentNodeId: node.id,
                            intentionStatus: 'waiting',
                            intentionAttempts: 0,
                            lastPromptAt: new Date(),
                        },
                    });

                    this.logger.log(
                        `Intention pausado (node=${node.id}) -> waiting`,
                        'WorkflowService',
                    );

                    // ✅ pausa: no sigue con el resto del flujo
                    return { message: 'Workflow paused on intention', workflow: result.name, totalNodes: executedCount };
                }

                // Ya está esperando aquí: si no hay texto entrante, seguimos esperando
                const text = (incomingText ?? '').trim();
                if (!text) {
                    this.logger.log(
                        `Intention sigue esperando texto (node=${node.id})`,
                        'WorkflowService',
                    );
                    return { message: 'Waiting user input', workflow: result.name, totalNodes: executedCount };
                }

                // ✅ validar entrada (MVP)
                const ok = this.validateIntentionInput(text);

                // Si OK -> passed y seguir por YES
                if (ok) {
                    state = await this.prisma.sessionWorkflowState.update({
                        where: { id: state.id },
                        data: {
                            intentionStatus: 'passed',
                            currentNodeId: null,
                            intentionData: { text }, // MVP: luego extraes name/description
                        },
                    });

                    const next = this.pickNextByHandle(outgoing.get(node.id) ?? [], 'yes');
                    if (!next) {
                        this.logger.warn(`Intention sin rama YES (node=${node.id})`, 'WorkflowService');
                        return { message: 'No YES branch', workflow: result.name, totalNodes: executedCount };
                    }

                    currentId = next.targetId;
                    continue;
                }

                // Si NO OK -> attempts++ (si supera -> NO branch)
                const nextAttempts = (state.intentionAttempts ?? 0) + 1;

                if (nextAttempts < maxAttempts) {
                    // Reintenta: guarda attempts y reenvía prompt, pausa otra vez
                    if (promptToSend) {
                        const url = `${urlevo}/message/sendText/${instanceName}`;
                        await this.nodeSenderService.sendTextNode(url, apikey, remoteJid, promptToSend);
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

                // maxAttempts alcanzado -> failed y seguir por NO
                state = await this.prisma.sessionWorkflowState.update({
                    where: { id: state.id },
                    data: {
                        intentionStatus: 'failed',
                        currentNodeId: null,
                        intentionAttempts: nextAttempts,
                    },
                });

                const next = this.pickNextByHandle(outgoing.get(node.id) ?? [], 'no');
                if (!next) {
                    this.logger.warn(`Intention sin rama NO (node=${node.id})`, 'WorkflowService');
                    return { message: 'No NO branch', workflow: result.name, totalNodes: executedCount };
                }

                currentId = next.targetId;
                continue;
            }

            // ===========================
            // ✅ NODOS NORMALES (lo que ya tenías)
            // ===========================
            const sendNode = async () => {
                if (node.tipo === 'delay') {
                    const delayTime = node?.delay || 15000;
                    this.logger.log(`Esperando ${delayTime}ms (nodo ID: ${node.id})`, 'WorkflowService');
                    await new Promise((res) => setTimeout(res, Number(delayTime)));
                } else if (node.tipo === 'text') {
                    const url = `${urlevo}/message/sendText/${instanceName}`;
                    await this.nodeSenderService.sendTextNode(url, apikey, remoteJid, node.message);
                } else if (['image', 'video', 'document'].includes(node.tipo)) {
                    const url = `${urlevo}/message/sendMedia/${instanceName}`;
                    await this.nodeSenderService.sendMediaNode(
                        url, apikey, remoteJid, node.tipo, node.message, node.url as string,
                    );
                } else if (node.tipo === 'audio') {
                    const url = `${urlevo}/message/sendWhatsAppAudio/${instanceName}`;
                    await this.nodeSenderService.sendAudioNode(url, apikey, remoteJid, node.url as string);
                } else if (node.tipo === 'node_pause') {
                    // 1) Pausar la sesión
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

                    // 2) Leer el delay (ej: "minutes-5", "hours-1", "seconds-0")
                    const rawDelay = node.delay ?? '';

                    if (!rawDelay) {
                        this.logger.log(
                            `Nodo pause sin delay definido. No se crea SessionTrigger (remoteJid=${remoteJid}).`,
                            'WorkflowService',
                        );
                        return;
                    }

                    // 3) Parsear unit y value para saber si es 0 o mayor
                    const [unit, valueStr] = rawDelay.split('-');
                    const value = parseInt(valueStr, 10);

                    if (!['seconds', 'minutes', 'hours', 'days'].includes(unit) || isNaN(value)) {
                        this.logger.warn(
                            `Nodo pause con delay inválido "${rawDelay}". No se crea SessionTrigger.`,
                            'WorkflowService',
                        );
                        return;
                    }

                    // Si el valor es 0, NO se crea SessionTrigger
                    if (value <= 0) {
                        this.logger.log(
                            `Nodo pause con delay 0. Solo se pausa la sesión, sin SessionTrigger.`,
                            'WorkflowService',
                        );
                        return;
                    }

                    // 4) Buscar sesión para obtener sessionId
                    const session = await this.getSession({ remoteJid, instanceName, userId });
                    if (!session) {
                        this.logger.warn(
                            `Nodo pause: no se encontró sesión para crear SessionTrigger (${remoteJid}).`,
                            'WorkflowService',
                        );
                        return;
                    }

                    // 5) Usar convertDelayToSeconds para obtener la FECHA futura formateada
                    try {
                        const reactivationDate = convertDelayToSeconds(rawDelay); // "dd/mm/yyyy HH:MM"

                        await this.sessionTriggerService.create(
                            session.id.toString(),
                            reactivationDate,
                        );

                        this.logger.log(
                            `SessionTrigger creado para sesión ${session.id} con fecha ${reactivationDate} (delay=${rawDelay}).`,
                            'WorkflowService',
                        );
                    } catch (error) {
                        this.logger.error(
                            `Error al convertir delay "${rawDelay}" con convertDelayToSeconds en nodo pause`,
                            error,
                            'WorkflowService',
                        );
                    }

                } else if (node.tipo.startsWith('seguimiento-')) {
                    const delaySeguimiento = convertDelayToSeconds(node.delay ?? '');

                    const seguimientoData = {
                        idNodo: node.id,
                        serverurl: urlevo,
                        instancia: instanceName,
                        apikey,
                        remoteJid,
                        mensaje: node.message,
                        tipo: node.tipo,
                        media: node.url,
                        time: delaySeguimiento ?? '',
                        name_file: node.nameFile,
                        consecutivo: '',
                    };

                    const { id } = await this.seguimientosService.createSeguimiento(
                        seguimientoData,
                    );

                    const session = await this.getSession({ remoteJid, instanceName, userId });
                    if (!session) {
                        this.logger.warn(
                            `No se pudo registrar el seguimiento porque la sesión no existe: ${remoteJid}`,
                            'WorkflowService',
                        );
                        return;
                    }

                    const seguimientos = this.buildSeguimientoID({
                        seguimientos: session.seguimientos,
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
                            seguimientos: session.inactividad,
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
                } else {
                    this.logger.warn(`Tipo de nodo desconocido: ${node.tipo} (ID: ${node.id})`, 'WorkflowService');
                }
            };

            const TIMEOUT_MS = 15000;
            try {
                await Promise.race([
                    sendNode(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Tiempo de espera excedido')), TIMEOUT_MS),
                    ),
                ]);
            } catch (error) {
                this.logger.warn(
                    `Timeout procesando nodo ID: ${node.id}, ${error?.response?.data || error.message}`,
                    'WebhookService',
                );
            }

            executedCount++;

            // avanzar por edge normal (MVP: toma la primera salida)
            const outs = outgoing.get(node.id) ?? [];
            const next = outs[0];
            currentId = next?.targetId;
        }

        this.logger.log(`Workflow "${result.name}" ejecutado con éxito.`, 'WorkflowService');

        return {
            message: 'Workflow ejecutado',
            workflow: result.name,
            totalNodes: executedCount,
        };
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

    private validateIntentionInput(text: string) {
        // ✅ MVP simple: mínimo 2 palabras y 6 caracteres
        const t = text.trim();
        if (t.length < 6) return false;
        const words = t.split(/\s+/).filter(Boolean);
        return words.length >= 2;
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