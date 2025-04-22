// services/message-buffer.service.ts

import { Injectable } from '@nestjs/common';

interface MessageBuffer {
  messages: string[];
  timeout?: NodeJS.Timeout;
}

@Injectable()
export class MessageBufferService {
  private buffer: Map<string, MessageBuffer> = new Map();

  /**
   * Maneja un nuevo mensaje recibido. Si el usuario está escribiendo,
   * se agrupa y se espera 10s antes de procesarlo.
   *
   * @param userId - ID del usuario (remoteJid, por ejemplo)
   * @param content - Mensaje recibido
   * @param callback - Función a ejecutar después del delay con todos los mensajes concatenados
   */
  handleIncomingMessage(userId: string, content: string, callback: (mergedText: string) => Promise<void>) {
    const entry = this.buffer.get(userId) || { messages: [] };

    entry.messages.push(content);

    // Limpiar timeout anterior si existe
    if (entry.timeout) clearTimeout(entry.timeout);

    // Reiniciar timeout: después de 10s de inactividad se llama al callback
    entry.timeout = setTimeout(async () => {
      const fullText = entry.messages.join(', ').replace(/\s+/g, ' ').trim();
      this.buffer.delete(userId);
      await callback(fullText);
    }, 10_000);

    this.buffer.set(userId, entry);
  }
}
