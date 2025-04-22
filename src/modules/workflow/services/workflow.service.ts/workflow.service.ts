import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { NodeSenderService } from '../node-sender.service.ts/node-sender.service';
import { LoggerService } from 'src/core/logger/logger.service';
import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';


@Injectable()
export class WorkflowService {
    constructor(
        private prisma: PrismaService,
        private nodeSenderService: NodeSenderService,
        private logger: LoggerService, 
        private http: HttpService
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
    ) {
        const result = await this.prisma.workflow.findFirst({ where: { name: name_flujo } });

        if (!result) {
            this.logger.warn(`Workflow no encontrado: ${name_flujo}`, 'WorkflowService');
            throw new NotFoundException('Workflow no encontrado');
        }

        const nodes = await this.prisma.workflowNode.findMany({ where: { workflowId: result.id } });

        if (!nodes.length) {
            this.logger.warn(`No se encontraron nodos para el workflow: ${name_flujo}`, 'WorkflowService');
            throw new NotFoundException('No se encontraron nodos para este workflow');
        }

        this.logger.log(`Total de nodos a procesar: ${nodes.length}`, 'WorkflowService');

        for (const [index, node] of nodes.entries()) {
            try {
                this.logger.debug(`Procesando nodo ${index + 1}/${nodes.length} (ID: ${node.id})`, 'WorkflowService');

                if (node.tipo === 'text') {
                    const url = `${urlevo}/message/sendText/${instanceName}`;
                    await this.nodeSenderService.sendTextNode(url, apikey, remoteJid, node.message);
                    this.logger.log(`Texto enviado correctamente (nodo ID: ${node.id})`, 'WorkflowService');
                } else if (['image', 'video', 'document', 'audio'].includes(node.tipo)) {
                    const url = `${urlevo}/message/sendMedia/${instanceName}`;
                    await this.nodeSenderService.sendMediaNode(url, apikey, remoteJid, node.tipo, node.message, node.url as string);
                    this.logger.log(`${node.tipo} enviado correctamente (nodo ID: ${node.id})`, 'WorkflowService');
                } else {
                    this.logger.warn(`Tipo de nodo desconocido: ${node.tipo} (ID: ${node.id})`, 'WorkflowService');
                }
            } catch (error) {
                this.logger.error(`Error procesando nodo ID: ${node.id}`, error?.response?.data || error.message, 'WorkflowService');
                // Continúa procesando los siguientes nodos aunque haya error
            }
        }

        this.logger.log(`Workflow "${result.name}" ejecutado correctamente.`, 'WorkflowService');

        return {
            message: 'Workflow ejecutado',
            workflow: result.name,
            totalNodes: nodes.length
        };
    }

    async executeWorkflowNew(
        name_flujo: string,
        urlevo: string,
        apikey: string,
        instanceName: string,
        remoteJid: string,
    ) {
        // Paso 1: Buscar el workflow por nombre
        const result = await this.prisma.workflow.findFirst({
            where: {
                name: name_flujo,
            },
        });

        if (!result) {
            throw new NotFoundException('Workflow no encontrado');
        }

        // Paso 2: Buscar los WorkflowNode asociados
        const nodes = await this.prisma.workflowNode.findMany({
            where: {
                workflowId: result.id,  // <-- Aquí relacionamos por ID
            },
        });

        if (!nodes || nodes.length === 0) {
            throw new NotFoundException('No se encontraron nodos para este workflow');
        }

        // Paso 3: Recorrer los nodos
        for (const node of nodes) {

            // Aquí es donde harías la llamada a tu API de WhatsApp
            console.log('Procesando nodo', node);

            // ejemplo:
            // await this.whatsappApi.send(node.type, node.content, workflow.remoteJid);

            // Puedes condicionar según el tipo de nodo
            if (node.tipo === 'Texto') {

                // const url = `https://${workflow.urlevo}/message/sendText/${workflow.instanceName}`;
                const url = `${urlevo}/message/sendText/${instanceName}`;

                const body = {
                    number: remoteJid,
                    options: {
                        delay: 100,
                        presence: "composing"
                    },
                    text: node.message // <-- aquí va directamente "text", no "textMessage"
                };
                await firstValueFrom(this.http.post(url, body, { headers: { 'Content-Type': 'application/json', 'apikey': apikey } }));
                console.log(`✅ Texto enviado (nodo ${node.id})`);

                // Texto
                // Imagen
                // Video
                // Archivo/Documento
                // Audio
                
            } else if (node.tipo === 'Imagen' || node.tipo === 'Video' || node.tipo === 'Documento') {
                // const url = `https://${workflow.urlevo}/message/sendText/${workflow.instanceName}`;
                const url = `${urlevo}/message/sendMedia/${instanceName}`;

                const body = {
                    number: remoteJid,
                    mediatype: node.tipo, // Opciones: image, video o document
                    mimetype: node.tipo,
                    caption: node.message,
                    media: node.url
                    // fileName: "documento.pdf",
                };
                await firstValueFrom(this.http.post(url, body, { headers: { 'Content-Type': 'application/json', 'apikey': apikey } }));
                console.log(`✅ Texto enviado (nodo ${node.id})`);
            }
        }

        return { message: 'Workflow ejecutado', workflow: result.name, totalNodes: nodes.length };
    }

    /**
     * Obtiene todos los workflows disponibles en la base de datos.
     *
     * @returns {Promise<any[]>}
     */
    async getWorkflow() {
        this.logger.debug('Obteniendo lista de workflows disponibles...', 'WorkflowService');
        return this.prisma.workflow.findMany();
    }
}
