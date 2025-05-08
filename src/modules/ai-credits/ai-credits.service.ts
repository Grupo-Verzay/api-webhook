import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';

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
}
