import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { User } from '@prisma/client';
import { DefaultAiConfig, UserWithPausar } from 'src/types/open-ai';

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
                pausar: true, // 👈 así se llama en tu schema
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
                defaultAiModel: { select: { id: true, name: true } }, // <- relación real en tu schema
                aiConfigs: {
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
                user.aiConfigs.find(
                    (c) => c.providerId === user.defaultProviderId && c.isActive,
                ) ?? user.aiConfigs.find((c) => c.providerId === user.defaultProviderId);
        }

        if (!chosen) {
            chosen =
                user.aiConfigs.find((c) => c.isActive) ?? user.aiConfigs[0];
        }

        // 2) Resolver proveedor
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
            defaultModel: user.defaultAiModel ?? null,
            defaultApiKey,
        };
    }
}
