import { Injectable } from '@nestjs/common';

interface MessageBuffer {
    messages: string[];
    timeout?: NodeJS.Timeout;
}

@Injectable()
export class MessageBufferService {
    private readonly buffer = new Map<string, MessageBuffer>();

    /**
     * Maneja un nuevo mensaje recibido. Si el usuario está escribiendo,
     * se agrupa y se espera un delay configurable antes de procesarlo.
     *
     * @param userId - ID del usuario (ej: remoteJid)
     * @param content - Mensaje recibido
     * @param delay - Tiempo en milisegundos antes de procesar (default: 10000)
     * @param callback - Función a ejecutar con el mensaje concatenado
     */
    handleIncomingMessage(
        userId: string,
        content: string,
        delay = 10000,
        callback: (mergedText: string) => Promise<void>,
    ): void {
        const entry = this.buffer.get(userId) || { messages: [] };

        entry.messages.push(content);

        if (entry.timeout) {
            clearTimeout(entry.timeout);
        }

        entry.timeout = setTimeout(async () => {
            const mergedText = entry.messages.join(' ').replace(/\s+/g, ' ').trim();
            this.buffer.delete(userId);
            await callback(mergedText);
        }, delay);

        this.buffer.set(userId, entry);
    }

    /**
     * Limpia manualmente los mensajes acumulados para un usuario.
     *
     * @param userId - ID del usuario
     */
    reset(userId: string): void {
        const entry = this.buffer.get(userId);
        if (entry?.timeout) clearTimeout(entry.timeout);
        this.buffer.delete(userId);
    }

    /**
     * Procesa de inmediato lo que haya acumulado un usuario (sin esperar el delay).
     *
     * @param userId - ID del usuario
     * @param callback - Función a ejecutar con los mensajes unidos
     */
    async flush(userId: string, callback: (mergedText: string) => Promise<void>): Promise<void> {
        const entry = this.buffer.get(userId);
        if (!entry) return;

        if (entry.timeout) clearTimeout(entry.timeout);

        const mergedText = entry.messages.join(', ').replace(/\s+/g, ' ').trim();
        this.buffer.delete(userId);
        await callback(mergedText);
    }
}