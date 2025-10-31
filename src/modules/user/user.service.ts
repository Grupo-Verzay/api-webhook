import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import {
    Pausar,
    User,
    UserAiConfig,
    Prisma,
    AiProvider,
} from '@prisma/client';

// Define el tipo de retorno para la configuración de IA por defecto
export type DefaultAiConfig = {
    userId: string;
    // El proveedor por defecto se obtiene a través de un lookup manual.
    defaultProvider?: { id: string; name: string; } | null;
    defaultModel?: { id: string; name: string; } | null;
    defaultApiKey: string | null;
};

@Injectable()
export class UserService {
    constructor(private readonly prisma: PrismaService) { }

    // =================================================================
    // FUNCIONES CRUD BÁSICAS Y EXISTENTES (Mantenidas)
    // =================================================================

    async getUserById(userId: string): Promise<User | null> {
        return this.prisma.user.findUnique({
            where: { id: userId },
        });
    }

    async getUserByEmail(email: string): Promise<User | null> {
        return this.prisma.user.findUnique({
            where: { email },
        });
    }

    async getAllUsers(): Promise<User[]> {
        return this.prisma.user.findMany();
    }

    async updateUser(userId: string, data: Partial<User>): Promise<User> {
        return this.prisma.user.update({
            where: { id: userId },
            data: data,
        });
    }

    async deleteUser(userId: string): Promise<User> {
        return this.prisma.user.delete({
            where: { id: userId },
        });
    }

    async findUsersByCompany(companyName: string): Promise<User[]> {
        return this.prisma.user.findMany({
            where: {
                company: {
                    contains: companyName,
                    mode: 'insensitive',
                },
            },
        });
    }

    async getUserWithPausar(userId: string): Promise<(
        User & {
            pausar: Pausar[];
        }
    ) | null> {
        return this.prisma.user.findUnique({
            where: { id: userId },
            include: {
                pausar: true,
            },
        });
    }

    // =================================================================
    // FUNCIONES DE CONFIGURACIÓN DE IA (CONFIRMADA PARA TU ESQUEMA)
    // =================================================================

    /**
     * Obtiene la configuración de IA por defecto de un usuario:
     * - Modelo por defecto (relación directa a AiModel).
     * - Proveedor por defecto (requiere lookup manual ya que no hay relación @relation en defaultProviderId).
     * - API Key asociada al proveedor por defecto (de UserAiConfig).
     * No utiliza ningún valor de fallback (`apiUrl`).
     */
    async getUserDefaultAiConfig(userId: string): Promise<DefaultAiConfig | null> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                defaultProviderId: true,
                defaultAiModel: { select: { id: true, name: true } },
                aiConfig: { select: { providerId: true, apiKey: true, isActive: true } },
            },
        });

        if (!user) return null; // <- único caso real de null

        // 1) Elegir la config candidata
        let chosen: { providerId: string; apiKey: string } | undefined;

        if (user.defaultProviderId) {
            chosen = user.aiConfig.find(c => c.providerId === user.defaultProviderId && c.isActive)
                ?? user.aiConfig.find(c => c.providerId === user.defaultProviderId) // por si isActive es false/null
        }
        if (!chosen) {
            // Fallback: primera activa
            chosen = user.aiConfig.find(c => c.isActive) ?? user.aiConfig[0];
        }

        // 2) Resolver proveedor (si hay candidate)
        let defaultProvider: { id: string; name: string } | null = null;
        let defaultApiKey: string | null = null;

        if (chosen) {
            const provider = await this.prisma.aiProvider.findUnique({
                where: { id: chosen.providerId },
                select: { id: true, name: true },
            });
            defaultProvider = provider ?? null;
            defaultApiKey = chosen.apiKey ?? null;
        }

        return {
            userId: user.id,
            defaultProvider,
            defaultModel: user.defaultAiModel, // puede ser null si no está configurado
            defaultApiKey,
        };
    }



}