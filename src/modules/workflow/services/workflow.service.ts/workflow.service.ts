import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { NodeSenderService } from '../node-sender.service.ts/node-sender.service';
import { LoggerService } from 'src/core/logger/logger.service';
import { SeguimientosService } from 'src/modules/seguimientos/seguimientos.service';
import { convertDelayToSeconds } from 'src/modules/webhook/utils/convert-delay-to-seconds.helper';
import { Session, seguimientos } from '@prisma/client';
import { SessionService } from 'src/modules/session/session.service';

interface getSessionInterface {
    remoteJid: string
    instanceName: string
    userId: string
}
@Injectable()
export class WorkflowService {
    constructor(
        private prisma: PrismaService,
        private nodeSenderService: NodeSenderService,
        private seguimientosService: SeguimientosService,
        private logger: LoggerService,
        private sessionService: SessionService
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
        const result = await this.prisma.workflow.findFirst({ where: { name: name_flujo } });

        if (!result) {
            this.logger.warn(`Workflow no encontrado: ${name_flujo}`, 'WorkflowService');
            throw new NotFoundException('Workflow no encontrado');
        }

        const nodes = await this.prisma.workflowNode.findMany({
            where: { workflowId: result.id },
            orderBy: { id: 'asc' }, //TODO: Se debe agregar campo order a futuro.
        });

        if (!nodes.length) {
            this.logger.warn(`No se encontraron nodos para el workflow: ${name_flujo}`, 'WorkflowService');
            throw new NotFoundException('No se encontraron nodos para este workflow');
        }

        this.logger.log(`Iniciando ejecución de workflow "${result.name}" con ${nodes.length} nodos`, 'WorkflowService');

        for (const [index, node] of nodes.entries()) {
            this.logger.log(`Procesando nodo ${index + 1}/${nodes.length} (ID: ${node.id})`);

            try {
                const sendNode = async () => {
                    if (node.tipo === 'delay') {
                        const delayTime = node?.delay || 15000;
                        this.logger.log(`Esperando ${delayTime}ms (nodo ID: ${node.id})`, 'WorkflowService');
                        await new Promise(res => setTimeout(res, 15000));
                    } else if (node.tipo === 'text') {
                        const url = `${urlevo}/message/sendText/${instanceName}`;
                        await this.nodeSenderService.sendTextNode(url, apikey, remoteJid, node.message);
                        this.logger.log(`Texto enviado correctamente (nodo ID: ${node.id})`, 'WorkflowService');
                    } else if (['image', 'video', 'document', 'audio'].includes(node.tipo)) {
                        const url = `${urlevo}/message/sendMedia/${instanceName}`;
                        await this.nodeSenderService.sendMediaNode(url, apikey, remoteJid, node.tipo, node.message, node.url as string);
                        this.logger.log(`${node.tipo} enviado correctamente (nodo ID: ${node.id})`, 'WorkflowService');
                    } else if (node.tipo.startsWith('seguimiento-')) {
                        //TODO: INACTIVIDAD
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
                        // 1. Registrar seguimiento en la tabla Seguimientos
                        const { id } = await this.seguimientosService.createSeguimiento(seguimientoData);

                        // 2. Obtener la sesión actual
                        const res = await this.getSession({ remoteJid, instanceName, userId });
                        if (!res) {
                            this.logger.warn(`No se pudo registrar el seguimiento porque la sesión no existe: ${remoteJid}`, 'WorkflowService');
                            return;
                        }

                        // 3. Construir la nueva cadena de IDs de seguimiento
                        const seguimientos = this.buildSeguimientoID({
                            seguimientos: res.seguimientos,
                            current: id.toString(),
                        });

                        // 4. Registrar el nuevo ID de seguimiento en la sesión
                        await this.registerIdSeguimientoInSession(id.toString(), remoteJid, instanceName, userId, seguimientos);

                    } else {
                        this.logger.warn(`Tipo de nodo desconocido: ${node.tipo} (ID: ${node.id})`, 'WorkflowService');
                    }
                };

                const TIMEOUT_MS = 15000;

                await Promise.race([
                    sendNode(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Tiempo de espera excedido')), TIMEOUT_MS))
                ]);
            } catch (error) {
                this.logger.warn(`Se excedío el tiempo de espera procesando nodo ID: ${node.id}, ${error?.response?.data || error.message}`, 'WebhookService');
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
                    createdAt: "asc",
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
    *
    * @param {string} id - ID de seguimiento nuevo a agregar.
    * @param {string} remoteJid - RemoteJID de la sesión.
    * @param {string} instanceId - InstanceID de la sesión.
    * @param {string} userId - UserID del usuario.
    * @returns {Promise<void>}
    */
    private async registerIdSeguimientoInSession(
        id: string,
        remoteJid: string,
        instanceId: string,
        userId: string,
        seguimientos: string,
    ): Promise<void> {
        this.logger.log(`Almacenando nuevo ID de seguimiento: ${id} en sesión ${remoteJid}`, 'WorkflowService');
        try {
            await this.sessionService.registerSeguimientos(
                seguimientos,
                remoteJid,
                instanceId,
                userId,
            );
            this.logger.log(`ID de seguimiento ${id} almacenado exitosamente en sesión ${remoteJid}`, 'WorkflowService');
        } catch (error) {
            this.logger.error(`Error almacenando ID de seguimiento ${id} en sesión ${remoteJid}: ${error.message}`, 'WorkflowService');
        }
    }

    private async getSession({ remoteJid, instanceName, userId }: getSessionInterface): Promise<Session | null> {
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
        this.logger.log('Obteniendo lista de workflows disponibles by workflowId...', 'WorkflowService');
        try {
            const workflows = await this.prisma.workflow.findFirst({
                where: {
                    id: workflowId,
                },
                orderBy: {
                    createdAt: "asc",
                },
            });
            return workflows;
        } catch (error) {
            this.logger.error('Error al obtener los workflows:"', error, 'WorkflowService');
            return null;
        }
    }
}
