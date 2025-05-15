import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';

type CreditResult = {
    success: true;
    total: number;
    used: number;
    available: number;
    renewalDate: Date;
} | {
    success: false;
    msg: string;
};

@Injectable()
export class AiCreditsService {
    constructor(
        private readonly logger: LoggerService,
        private readonly prisma: PrismaService
    ) { }

    /**
     * trackTokens
     * Incrementa el contador de tokens usados por un usuario en el modelo IaCredit.
     *
     * - Si el usuario no tiene un registro, se crea automáticamente con valores iniciales.
     * - Si ya existe, solo se incrementa el campo "used".
     * - Se ignoran tokens <= 0 para evitar escrituras innecesarias.
     *
     * @param {string} userId - ID del usuario al que se le están registrando tokens.
     * @param {number} tokens - Número total de tokens usados a sumar.
     */
    public async trackTokens(userId: string, tokens: number): Promise<void> {
        if (!userId || typeof userId !== 'string') {
            this.logger.warn('trackTokens: userId inválido.');
            return;
        }

        if (typeof tokens !== 'number' || tokens <= 0) {
            this.logger.log(`trackTokens: tokens inválidos o cero (${tokens}). No se hará nada.`);
            return;
        }

        try {
            this.logger.log(`trackTokens: registrando ${tokens} tokens usados para userId=${userId}`);

            await this.prisma.iaCredit.upsert({
                where: { userId },
                create: {
                    userId,
                    used: tokens,
                    total: 1000, // inicialización por defecto
                    renewalDate: new Date(),
                },
                update: {
                    used: { increment: tokens },
                },
            });

            this.logger.log(`trackTokens: tokens actualizados correctamente para userId=${userId}`);
        } catch (error) {
            this.logger.error(
                `Error en trackTokens para userId=${userId}`,
                error?.message || error,
                'AiCreditsService'
            );
        }
    }

    /**
      * 🔍 getCreditsByUser
      * Obtiene los créditos de IA actuales para un usuario.
      *
      * @param {string} userId - ID del usuario
      * @returns {Promise<CreditResult>}
      */
    public async getCreditsByUser(userId: string): Promise<CreditResult> {
        if (!userId || typeof userId !== 'string') {
            this.logger.error('getCreditsByUser: userId inválido o no proporcionado');
            return {
                success: false,
                msg: 'userId inválido o no proporcionado',
            };
        }

        try {
            const credit = await this.prisma.iaCredit.findUnique({
                where: { userId },
            });

            if (!credit) {
                this.logger.error(`No se encontraron créditos para userId=${userId}`);
                return {
                    success: false,
                    msg: 'No se encontraron créditos',
                };
            }

            const TOKENS_PER_CREDIT = 3085;
            const usedCredits = Math.floor(credit.used / TOKENS_PER_CREDIT);
            const availableCredits = Math.max(credit.total - usedCredits, 0);

            this.logger.log(
                `Créditos de usuario ${userId} → Total: ${credit.total}, Usados: ${usedCredits}, Disponibles: ${availableCredits}`
            );

            return {
                success: true,
                total: credit.total,
                used: usedCredits,
                available: availableCredits,
                renewalDate: credit.renewalDate,
            };
        } catch (error) {
            this.logger.error(`Error al obtener créditos de userId=${userId}`, error?.message || error);
            return {
                success: false,
                msg: 'Error al obtener créditos',
            };
        }
    }

}