import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';

@Injectable()
export class InstancesService {
    private readonly logger = new Logger(InstancesService.name);

    constructor(private readonly prisma: PrismaService) { }

    /**
     * 🔍 getUserId
     * Obtiene la información de una instancia por su `instanceName`.
     * 
     * @param {string} instanceName - Nombre de la instancia registrada
     * @returns {Promise<Instancia | null>}
     */
    public async getUserId(instanceName: string) {
        if (!instanceName || typeof instanceName !== 'string') {
            this.logger.warn('getUserId: instanceName inválido o no proporcionado');
            return null;
        }

        try {
            const result = await this.prisma.instancias.findFirst({
                where: { instanceName },
            });

            if (!result) {
                this.logger.warn(`No se encontró ninguna instancia con el nombre: ${instanceName}`);
            }

            return result;
        } catch (error) {
            this.logger.error(`Error en getUserId(${instanceName})`, error?.message || error);
            throw error;
        }
    }

    /**
     * 🔗 getInstances
     * Devuelve todas las instancias activas asociadas a un usuario, incluyendo su API key y server URL.
     * 
     * @param {string} userId - ID del usuario
     * @returns {Promise<{ instanceName: string, instanceId: string, serverUrl: string }[]>}
     */
    public async getInstances(userId: string) {
        if (!userId || typeof userId !== 'string') {
            this.logger.warn('getInstances: userId inválido o no proporcionado');
            return [];
        }

        try {
            const instances = await this.prisma.instancias.findMany({
                where: { userId },
                select: {
                    instanceName: true,
                    instanceId: true,
                },
            });

            if (!instances.length) {
                this.logger.warn(`No se encontraron instancias para el usuario: ${userId}`);
            }

            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                include: { ApiKey: true },
            });

            if (!user || !user.ApiKey) {
                this.logger.warn(`El usuario ${userId} no tiene una API Key asignada`);
                return [];
            }

            const { key: apiKey, url: serverUrl } = user.ApiKey;

            const enrichedInstances = instances.map((instance) => ({
                ...instance,
                serverUrl,
            }));

            this.logger.log(`Instancias encontradas para userId=${userId}: ${enrichedInstances.length}`);

            return enrichedInstances;
        } catch (error) {
            this.logger.error(`Error en getInstances(userId=${userId})`, error?.message || error);
            return [];
        }
    }
}