import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { NodeSenderService } from '../node-sender.service.ts/node-sender.service';
import { LoggerService } from 'src/core/logger/logger.service';
import { SeguimientosService } from 'src/modules/seguimientos/seguimientos.service';
import { convertDelayToSeconds } from 'src/modules/webhook/utils/convert-delay-to-seconds.helper';
import { Session } from '@prisma/client';
import { SessionService } from 'src/modules/session/session.service';
import { SessionTriggerService } from 'src/modules/session-trigger/session-trigger.service';


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
    ) {
        const result = await this.prisma.workflow.findFirst({
            where: { name: name_flujo, userId },
            orderBy: {
                createdAt: 'asc',
            },
        });

        console.log({ result: JSON.stringify(result) });

        if (!result) {
            this.logger.warn(`Workflow no encontrado: ${name_flujo}`, 'WorkflowService');
            throw new NotFoundException('Workflow no encontrado');
        }

        const nodes = await this.prisma.workflowNode.findMany({
            where: { workflowId: result.id },
            orderBy: { createdAt: 'asc' }, //TODO: Se debe agregar campo order a futuro.
        });

        if (!nodes.length) {
            this.logger.warn(
                `No se encontraron nodos para el workflow: ${name_flujo}`,
                'WorkflowService',
            );
            throw new NotFoundException('No se encontraron nodos para este workflow');
        }

        this.logger.log(
            `Iniciando ejecución de workflow "${result.name}" con ${nodes.length} nodos`,
            'WorkflowService',
        );

        for (const [index, node] of nodes.entries()) {
            this.logger.log(`Procesando nodo ${index + 1}/${nodes.length} (ID: ${node.id})`);

            try {
                const sendNode = async () => {
                    if (node.tipo === 'delay') {
                        const delayTime = node?.delay || 15000;
                        this.logger.log(
                            `Esperando ${delayTime}ms (nodo ID: ${node.id})`,
                            'WorkflowService',
                        );
                        await new Promise((res) => setTimeout(res, 15000));
                    } else if (node.tipo === 'text') {
                        const url = `${urlevo}/message/sendText/${instanceName}`;
                        await this.nodeSenderService.sendTextNode(url, apikey, remoteJid, node.message);
                        this.logger.log(
                            `Texto enviado correctamente (nodo ID: ${node.id})`,
                            'WorkflowService',
                        );
                    } else if (['image', 'video', 'document'].includes(node.tipo)) {
                        const url = `${urlevo}/message/sendMedia/${instanceName}`;

                        await this.nodeSenderService.sendMediaNode(
                            url,
                            apikey,
                            remoteJid,
                            node.tipo,
                            node.message,
                            node.url as string,
                        );
                        this.logger.log(
                            `${node.tipo} enviado correctamente (nodo ID: ${node.id})`,
                            'WorkflowService',
                        );
                    } else if (node.tipo === 'audio') {
                        const url = `${urlevo}/message/sendWhatsAppAudio/${instanceName}`;

                        await this.nodeSenderService.sendAudioNode(
                            url,
                            apikey,
                            remoteJid,
                            node.url as string,
                        );
                        this.logger.log(
                            `audio enviado correctamente (nodo ID: ${node.id})`,
                            'WorkflowService',
                        );

                        // 🔹 NUEVO: tipo "pause"
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
                            name_file: node.name_file,
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
                        this.logger.warn(
                            `Tipo de nodo desconocido: ${node.tipo} (ID: ${node.id})`,
                            'WorkflowService',
                        );
                    }
                };


                const TIMEOUT_MS = 15000;

                await Promise.race([
                    sendNode(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Tiempo de espera excedido')), TIMEOUT_MS),
                    ),
                ]);
            } catch (error) {
                this.logger.warn(
                    `Se excedío el tiempo de espera procesando nodo ID: ${node.id}, ${error?.response?.data || error.message
                    }`,
                    'WebhookService',
                );
                // Continúa con el siguiente nodo
            }
        }

        this.logger.log(`Workflow "${result.name}" ejecutado con éxito.`, 'WorkflowService');

        return {
            message: 'Workflow ejecutado',
            workflow: result.name,
            totalNodes: nodes.length,
        };
    }

    //registra el Id en inactividad
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

    /**
     * Obtiene todos los workflows disponibles en la base de datos.
     *
     * @returns {Promise<any[]>}
     */
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

    /**
     * Obtiene el campo seguimientos de Session y concatena el nuevo ID.
     */
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

    // 🔹 NUEVO: parsear la descripción como JSON con matchType y keyword
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


    /**
     * Busca el primer workflow del usuario cuya descripción coincida con el mensaje
     * Formatos soportados:
     *
     *  { "matchType": "Exacta", "keyword": "Zapatos" }
     *  { "matchType": "Contiene", "keyword": "hola" }
     *  { "matchType": "Contiene", "keyword": ["hola", "ola"] }
     */
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
