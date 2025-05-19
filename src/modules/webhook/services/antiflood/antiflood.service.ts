// src/modules/webhook/services/antiflood.service.ts
import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';

interface MessageTracker {
    timestamps: number[];
}

interface TimestampEntry {
    lastTimestamp: number;
    deltas: number[]; // diferencias entre envíos
}

@Injectable()
export class AntifloodService {
    constructor(
        private readonly logger: LoggerService,
    ) {
    }

    private messageTimestamps = new Map<string, TimestampEntry>();

    private readonly patternThreshold = 2; // ¿Cuántos deltas similares para detectar patrón?
    private readonly toleranceMs = 300;    // Margen de diferencia entre intervalos
    private readonly maxHistory = 10;      // Limitar historial por usuario

    private messageMap: Map<string, MessageTracker> = new Map();
    private readonly limit = 5; // max mensajes
    private readonly interval = 2000; //  segundos
    private readonly botIndicators = [
        'estoy aquí para ayudarte',
        'en qué puedo ayudarte',
        'asistente virtual',
        'puedo ayudarte con',
        '¡hola! soy tu asistente',
        'soy un bot',
        'soy tu asistente',
        'respuesta generada automáticamente',
        'respuesta automática',
        'automatizado',
        'no soy humano',
        'mi función es ayudarte',
        '¿en qué más te puedo ayudar?',
        'permíteme ayudarte',
        'gracias por comunicarte',
        'tu asistente de confianza',
        'aquí para resolver tus dudas',
        'estoy aquí las 24 horas',
        'estoy entrenado para responder',
        'basado en inteligencia artificial',
        'estoy diseñado para brindarte información',
        'este es un mensaje automático'
    ];

    private readonly botEmojis = /👋|🤖|😊|💬|🧠/;

    /**
     * Registra un nuevo mensaje y evalúa si hay un patrón robótico de sincronía
     */
    isSynchronizedPatternv1(remoteJid: string): boolean {
        const now = Date.now();
        const entry = this.messageTimestamps.get(remoteJid) ?? { lastTimestamp: now, deltas: [] };

        this.logger.debug(`entry ===> ${JSON.stringify(entry)} MODULE: isSynchronizedPattern`);
        this.logger.debug(`now ===> ${now} MODULE: isSynchronizedPattern`);


        const delta = now - entry.lastTimestamp;
        entry.lastTimestamp = now;

        this.logger.debug(`delta ===> ${delta} MODULE: isSynchronizedPattern`);

        // Guardamos el nuevo delta
        if (entry.deltas.length >= this.maxHistory) {
            entry.deltas.shift(); // eliminamos el más antiguo
        }
        entry.deltas.push(delta);

        this.messageTimestamps.set(remoteJid, entry);

        if (entry.deltas.length < this.patternThreshold) {
            return false;
        }

        // Verificamos si los deltas son similares entre sí (± tolerancia)
        const promedio = entry.deltas.reduce((a, b) => a + b, 0) / entry.deltas.length;
        this.logger.debug(`promedio ===> ${promedio} MODULE: isSynchronizedPattern`);

        const todosSimilares = entry.deltas.every((d) => Math.abs(d - promedio) < this.toleranceMs);
        this.logger.debug(`todosSimilares ===> ${todosSimilares} MODULE: isSynchronizedPattern`);
        return todosSimilares;
    }

    median(values: number[]): number {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0
            ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    registerMessageTimestamp(remoteJid: string) {
        const now = Date.now();
        const entry = this.messageMap.get(remoteJid) || { timestamps: [] };
        this.logger.debug(`now ===> ${entry} MODULE: registerMessageTimestamp`);

        entry.timestamps.push(now);

        // Solo guardamos los últimos 10
        if (entry.timestamps.length > 10) {
            entry.timestamps.shift();
        }

        this.messageMap.set(remoteJid, entry);
    }

    isSynchronizedPattern(remoteJid: string): boolean {
        const entry = this.messageMap.get(remoteJid);
        this.logger.debug(`entry ===> ${JSON.stringify(entry)} MODULE: isSynchronizedPattern`);
        if (!entry || entry.timestamps.length < 5) return false;

        const deltas = entry.timestamps
            .map((t, i, arr) => (i === 0 ? 0 : t - arr[i - 1]))
            .filter((d) => d > 0);

        this.logger.debug(`deltas ===> ${JSON.stringify(deltas)} MODULE: isSynchronizedPattern`);

        if (deltas.length < 5) return false;

        const ref = this.median(deltas);
        const tolerance = 2000;

        const todosSimilares = deltas.every(
            (delta) => Math.abs(delta - ref) <= tolerance
        );

        this.logger.debug(`todosSimilares ===> ${JSON.stringify(todosSimilares)} MODULE: isSynchronizedPattern`);

        if (todosSimilares) {
            this.logger.warn(
                `🚨 Patrón sincronizado detectado para ${remoteJid} (intervalo promedio ≈ ${ref}ms)`,
                'AntifloodService',
            );
        }

        return todosSimilares;
    }


    /**
     * Registra un mensaje para un usuario y evalúa si está haciendo flood.
     * @param remoteJid ID del cliente
     */
    isFlooding(remoteJid: string): boolean {
        const now = Date.now();
        const entry = this.messageMap.get(remoteJid) || { timestamps: [] };
        console.log({ entry })
        console.log({ now })

        // Eliminar mensajes fuera del intervalo
        entry.timestamps = entry.timestamps.filter(ts => now - ts < this.interval);
        entry.timestamps.push(now);

        this.messageMap.set(remoteJid, entry);

        return entry.timestamps.length > this.limit;
    }

    /**
     * Limpia el registro de un usuario
     */
    clear(remoteJid: string) {
        this.messageMap.delete(remoteJid);
    }


    /**
    * Detecta si un mensaje probablemente fue enviado por otro agente de inteligencia artificial.
    * Ideal para antiflood o prevención de bucles IA-IA.
    */
    isMessageFromIA(content: string): boolean {
        const lower = content.toLowerCase();
        return (
            this.botIndicators.some(phrase => lower.includes(phrase)) ||
            this.botEmojis.test(lower)
        );
    }

}