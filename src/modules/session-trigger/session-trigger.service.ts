import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { SessionTrigger } from '@prisma/client';
import { LoggerService } from 'src/core/logger/logger.service';

@Injectable()
export class SessionTriggerService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly logger: LoggerService,
    ) {
    }

    /**
     * Crea un nuevo SessionTrigger en la base de datos.
     * 
     * @param sessionId - ID de la sesión asociada.
     * @param time - Hora programada como string (ej: "15/05/2025 18:30").
     * @returns El trigger creado.
     */
    async create(sessionId: string, time: string): Promise<SessionTrigger> {
        if (!sessionId || !time?.trim()) {
            this.logger.warn('create: Datos incompletos');
            throw new BadRequestException('sessionId y time son obligatorios.');
        }

        const trigger = await this.prisma.sessionTrigger.create({
            data: { sessionId, time },
        });

        this.logger.log(`Trigger creado: sessionId=${sessionId}, time=${time}`);
        return trigger;
    }

    /**
     * Obtiene todos los SessionTrigger registrados.
     * 
     * @returns Lista de triggers ordenados por fecha de creación descendente.
     */
    async findAll(): Promise<SessionTrigger[]> {
        const triggers = await this.prisma.sessionTrigger.findMany({
            orderBy: { createdAt: 'desc' },
        });

        return triggers;
    }

    /**
     * Busca un trigger específico por ID.
     * 
     * @param id - ID del trigger a buscar.
     * @returns El trigger encontrado o error si no existe.
     */
    async findById(id: number): Promise<SessionTrigger> {
        const trigger = await this.prisma.sessionTrigger.findUnique({ where: { id } });

        if (!trigger) {
            this.logger.warn(`findById: Trigger con ID ${id} no encontrado`);
            throw new NotFoundException(`Trigger con ID ${id} no existe`);
        }

        return trigger;
    }

    /**
     * Actualiza el campo `time` del trigger según el sessionId.
     * 
     * @param sessionId - ID de la sesión asociada.
     * @param newTime - Nueva hora formateada.
     * @returns El registro actualizado.
     */
    async updateTimeBySessionId(sessionId: string, newTime: string): Promise<SessionTrigger> {
        if (!sessionId || !newTime?.trim()) {
            this.logger.warn('updateTimeBySessionId: Parámetros inválidos');
            throw new BadRequestException('sessionId y newTime son obligatorios.');
        }

        const existing = await this.findBySessionId(sessionId);

        if (!existing) {
            this.logger.warn(`updateTimeBySessionId: No existe trigger con sessionId=${sessionId}`);
            throw new NotFoundException('No se puede actualizar: trigger no encontrado');
        }

        const updated = await this.prisma.sessionTrigger.update({
            where: { id: existing.id },
            data: { time: newTime },
        });

        this.logger.log(`updateTimeBySessionId: time actualizado para sessionId=${sessionId}`);
        return updated;
    }

    /**
     * Busca un trigger por su sessionId.
     * 
     * @param sessionId - ID único de la sesión.
     * @returns El SessionTrigger encontrado o null si no existe.
     */
    async findBySessionId(sessionId: string): Promise<SessionTrigger | null> {
        if (!sessionId) {
            this.logger.warn('findBySessionId: sessionId inválido');
            throw new BadRequestException('El sessionId debe ser un número válido');
        }

        const trigger = await this.prisma.sessionTrigger.findFirst({
            where: { sessionId },
            orderBy: { createdAt: 'desc' },
        });

        if (!trigger) {
            return null;
        }

        this.logger.log(`findBySessionId: Trigger encontrado para sessionId=${sessionId}`);
        return trigger;
    }

    /**
     * Elimina un trigger por su ID.
     * 
     * @param id - ID del trigger a eliminar.
     * @returns El registro eliminado.
     */
    async delete(id: number): Promise<SessionTrigger> {
        const existing = await this.prisma.sessionTrigger.findUnique({ where: { id } });

        if (!existing) {
            this.logger.warn(`delete: Trigger con ID ${id} no existe`);
            throw new NotFoundException(`No se puede eliminar: ID ${id} no encontrado`);
        }

        const deleted = await this.prisma.sessionTrigger.delete({ where: { id } });
        this.logger.log(`delete: Trigger con ID ${id} eliminado`);

        return deleted;
    }
}
