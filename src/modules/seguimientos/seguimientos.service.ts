import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { seguimientos, Prisma } from '@prisma/client'; // Importamos tipos generados por Prisma

@Injectable()
export class SeguimientosService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Registra un nuevo seguimiento.
     * @param seguimientoData Datos del seguimiento a guardar.
     */
    async createSeguimiento(seguimientoData: Prisma.seguimientosCreateInput): Promise<seguimientos> {
        return this.prisma.seguimientos.create({
            data: seguimientoData,
        });
    }

    /**
     * Obtiene todos los seguimientos registrados para un número específico.
     * @param remoteJid Número de WhatsApp (remoteJid).
     */
    async getSeguimientosByRemoteJid(remoteJid: string): Promise<seguimientos[]> {
        return this.prisma.seguimientos.findMany({
            where: { remoteJid },
            orderBy: { id: 'asc' },
        });
    }

    /**
     * Elimina un seguimiento específico por ID.
     * @param id ID del seguimiento.
     */
    async deleteSeguimiento(id: number): Promise<seguimientos> {
        return this.prisma.seguimientos.delete({
            where: { id },
        });
    }

    /**
     * Elimina todos los seguimientos de un remoteJid específico.
     * @param remoteJid Número de WhatsApp.
     */
    async deleteSeguimientosByRemoteJid(remoteJid: string, instanceName: string): Promise<{ count: number }> {
        return this.prisma.seguimientos.deleteMany({
            where: { remoteJid, instancia: instanceName },
        });
    }

    /**
     * Actualiza un seguimiento específico.
     * @param id ID del seguimiento.
     * @param data Datos a actualizar.
     */
    async updateSeguimiento(id: number, data: Prisma.seguimientosUpdateInput): Promise<seguimientos> {
        return this.prisma.seguimientos.update({
            where: { id },
            data,
        });
    }
}
