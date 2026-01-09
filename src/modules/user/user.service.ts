import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { Pausar, Prisma, User } from '@prisma/client';

// Define el tipo de retorno para la configuración de IA por defecto
export type DefaultAiConfig = {
    userId: string;
    defaultProvider?: { id: string; name: string } | null;
    defaultModel?: { id: string; name: string } | null;
    defaultApiKey: string | null;
};

type UserWithPausar = Prisma.UserGetPayload<{
    include: { Pausar: true };
}>;

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
            data,
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

    async getUserWithPausar(userId: string): Promise<UserWithPausar | null> {
        return this.prisma.user.findUnique({
            where: { id: userId },
            include: {
                Pausar: true, // 👈 así se llama en tu schema
            },
        });
    }

    // =================================================================
    // CONFIGURACIÓN DE IA (ALINEADA A TU SCHEMA)
    // =================================================================

    async getUserDefaultAiConfig(userId: string): Promise<DefaultAiConfig | null> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                defaultProviderId: true,
                ai_models: { select: { id: true, name: true } }, // <- relación real en tu schema
                user_ai_configs: {
                    select: { providerId: true, apiKey: true, isActive: true },
                }, // <- relación real en tu schema
            },
        });

        if (!user) return null;

        // 1) Elegir config candidata
        let chosen:
            | { providerId: string; apiKey: string; isActive: boolean }
            | undefined;

        if (user.defaultProviderId) {
            chosen =
                user.user_ai_configs.find(
                    (c) => c.providerId === user.defaultProviderId && c.isActive,
                ) ?? user.user_ai_configs.find((c) => c.providerId === user.defaultProviderId);
        }

        if (!chosen) {
            chosen =
                user.user_ai_configs.find((c) => c.isActive) ?? user.user_ai_configs[0];
        }

        // 2) Resolver proveedor
        let defaultProvider: { id: string; name: string } | null = null;
        let defaultApiKey: string | null = null;

        if (chosen) {
            const provider = await this.prisma.ai_providers.findUnique({
                where: { id: chosen.providerId },
                select: { id: true, name: true },
            });

            defaultProvider = provider ?? null;
            defaultApiKey = chosen.apiKey ?? null;
        }

        return {
            userId: user.id,
            defaultProvider,
            defaultModel: user.ai_models ?? null,
            defaultApiKey,
        };
    }
}
