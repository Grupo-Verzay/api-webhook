import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { Seguimiento, Prisma } from '@prisma/client'; // Importamos tipos generados por Prisma
import { buildWhatsAppJidCandidates } from 'src/utils/whatsapp-jid.util';

@Injectable()
export class SeguimientosService {
    constructor(private readonly prisma: PrismaService) { }

    private clean(value?: string | null) {
        return (value ?? '').trim();
    }

    private buildRemoteJidCandidates(remoteJid: string) {
        return buildWhatsAppJidCandidates(this.clean(remoteJid));
    }

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
        const candidates = this.buildRemoteJidCandidates(remoteJid);
        return this.prisma.seguimiento.findMany({
            where: { remoteJid: { in: candidates } },
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
        const candidates = this.buildRemoteJidCandidates(remoteJid);
        return this.prisma.seguimiento.deleteMany({
            where: {
                remoteJid: { in: candidates },
                instancia: this.clean(instanceName),
            },
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
