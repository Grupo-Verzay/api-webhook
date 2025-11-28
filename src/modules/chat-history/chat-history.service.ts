import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';

@Injectable()
export class ChatHistoryService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Guarda un mensaje en el historial.
     *
     * @param sessionId - ID de la sesión (ej: instance_name + remotejid)
     * @param content - Texto del mensaje
     */
    async saveMessage(sessionId: string, content: string, type: string): Promise<void> {
        const messageJson = {
            type,
            content: content,
            additional_kwargs: {},
            response_metadata: {},
        };

        await this.prisma.n8n_chat_histories.create({
            data: {
                session_id: sessionId,
                message: messageJson,
            },
        });
    }

    /**
     * Obtiene el historial de conversación de un usuario.
     *
     * @param sessionId - ID de la sesión (ej: instance_name + remotejid)
     * @returns {Promise<string[]>} - Lista de contenidos concatenados
     */
    async getChatHistory(sessionId: string): Promise<string[]> {
        const messages = await this.prisma.n8n_chat_histories.findMany({
            where: { session_id: sessionId },
            orderBy: { id: 'desc' }, // más recientes primero
            take: 10,
        });

        return messages
            .reverse() // revertimos para mostrar del más antiguo al más reciente
            .map((msg) => {
                if (msg.message && typeof msg.message === 'object' && 'content' in msg.message) {
                    return (msg.message as any).content ?? '';
                }
                return '';
            });
    }

    async registerExecutedIntention(sessionId: string, name: string, tipo: string) {
        const message = {
            type: 'intention',
            name,
            tipo,
            executedAt: new Date().toISOString()
        };

        await this.prisma.n8n_chat_histories.create({
            data: {
                session_id: sessionId,
                message
            }
        });
    }

    async hasIntentionBeenExecuted(sessionId: string, name: string): Promise<boolean> {
        const executed = await this.prisma.n8n_chat_histories.findMany({
            where: {
                session_id: sessionId,
                message: {
                    path: ['type'],
                    equals: 'intention'
                }
            }
        });

        if (!executed || executed.length === 0) {
            return false;
        }

        return executed.some((record) => {
            const msg = record.message as { type?: string; name?: string };
            return msg.name === name;
        });
    }
}
