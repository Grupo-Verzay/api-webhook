// src/modules/webhook/services/antiflood.service.ts
import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';

interface MessageTracker {
    timestamps: number[];
}

@Injectable()
export class AntifloodService {
    private messageMap: Map<string, MessageTracker> = new Map();

    // 🔧 Personalización
    private readonly maxHistory = 10;         // Número máximo de timestamps a guardar
    private readonly toleranceMs = 2000;      // Tolerancia para considerar un patrón similar
    private readonly minRequired = 5;         // Mínimo de mensajes requeridos para evaluación
    private readonly minSimilarCount = 7;     //7 Cuántos deltas deben ser similares para marcar patrón

    constructor(private readonly logger: LoggerService) { }

    /**
     * Guarda timestamp del mensaje entrante
     */
    registerMessageTimestamp(remoteJid: string) {
        const now = Date.now();
        const entry = this.messageMap.get(remoteJid) || { timestamps: [] };
        entry.timestamps.push(now);

        // Solo guardamos los últimos N
        if (entry.timestamps.length > this.maxHistory) {
            entry.timestamps.shift();
        }

        this.messageMap.set(remoteJid, entry);
    }

    /**
     * Calcula la media de una lista de valores
     */
    private median(values: number[]): number {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0
            ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /**
     * Detecta si los mensajes están siendo enviados con intervalos sincronizados.
     */
    isSynchronizedPattern(remoteJid: string): boolean {
        const entry = this.messageMap.get(remoteJid);

        if (!entry || entry.timestamps.length < this.minRequired) return false;

        const deltas = entry.timestamps
            .map((t, i, arr) => (i === 0 ? 0 : t - arr[i - 1]))
            .filter((d) => d > 0);

        if (deltas.length < this.minRequired - 1) return false;

        const ref = this.median(deltas);

        const similares = deltas.filter(
            (delta) => Math.abs(delta - ref) <= this.toleranceMs
        );


        if (similares.length >= this.minSimilarCount) {
            this.logger.warn(
                `🚨 Patrón IA sincronizado detectado para ${remoteJid} (${similares.length}/${deltas.length} deltas ≈ ${ref}ms)`,
                'AntifloodService',
            );
            return true;
        }

        return false;
    }

    /**
     * Limpia el registro de un usuario
     */
    clear(remoteJid: string) {
        this.messageMap.delete(remoteJid);
    }
}