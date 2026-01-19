import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { Seguimiento, Prisma } from '@prisma/client'; // Importamos tipos generados por Prisma

@Injectable()
export class SeguimientosService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Registra un nuevo seguimiento.
     * @param seguimientoData Datos del seguimiento a guardar.
     */
    async createSeguimiento(seguimientoData: Prisma.SeguimientoCreateInput): Promise<Seguimiento> {
        return this.prisma.seguimiento.create({
            data: seguimientoData,
        });
    }

    /**
     * Obtiene todos los seguimiento registrados para un número específico.
     * @param remoteJid Número de WhatsApp (remoteJid).
     */
    async getSeguimientosByRemoteJid(remoteJid: string): Promise<Seguimiento[]> {
        return this.prisma.seguimiento.findMany({
            where: { remoteJid },
            orderBy: { id: 'asc' },
        });
    }

    /**
     * Elimina un seguimiento específico por ID.
     * @param id ID del seguimiento.
     */
    async deleteSeguimiento(id: number): Promise<Seguimiento> {
        return this.prisma.seguimiento.delete({
            where: { id },
        });
    }

    /**
     * Elimina todos los seguimiento de un remoteJid específico.
     * @param remoteJid Número de WhatsApp.
     */
    async deleteSeguimientosByRemoteJid(remoteJid: string, instanceName: string): Promise<{ count: number }> {
        return this.prisma.seguimiento.deleteMany({
            where: { remoteJid, instancia: instanceName },
        });
    }

    /**
     * Actualiza un seguimiento específico.
     * @param id ID del seguimiento.
     * @param data Datos a actualizar.
     */
    async updateSeguimientos(id: number, data: Prisma.SeguimientoUpdateInput): Promise<Seguimiento> {
        return this.prisma.seguimiento.update({
            where: { id },
            data,
        });
    }
}
