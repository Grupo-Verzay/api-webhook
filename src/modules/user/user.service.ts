import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { User } from '@prisma/client';
import { DefaultAiConfig, UserWithPausar } from 'src/types/open-ai';
import { TtlCache } from 'src/utils/ttl-cache';

@Injectable()
export class UserService {
  private readonly userCache = new TtlCache<string, UserWithPausar | null>(60_000);
  private readonly aiConfigCache = new TtlCache<string, DefaultAiConfig | null>(2 * 60_000);

  constructor(private readonly prisma: PrismaService) {}

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
    const cached = this.userCache.get(userId);
    if (cached !== undefined) return cached;

    const result = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { pausar: true },
    });

    this.userCache.set(userId, result);
    return result;
  }

  async getResellerSender(ownerId: string): Promise<{ sendUrl: string; senderApikey: string } | null> {
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: {
        apiKey: { select: { url: true } },
        instancias: {
          where: { instanceType: 'Whatsapp' },
          select: { instanceName: true, instanceId: true },
          take: 1,
        },
      },
    });
    const instance = owner?.instancias?.[0];
    const serverUrl = owner?.apiKey?.url?.trim();
    if (!instance || !serverUrl) return null;
    const base = serverUrl.replace(/\/+$/, '');
    const normalizedBase = /^https?:\/\//i.test(base) ? base : `https://${base}`;
    return {
      sendUrl: `${normalizedBase}/message/sendText/${encodeURIComponent(instance.instanceName)}`,
      senderApikey: instance.instanceId,
    };
  }

  // =================================================================
  // CONFIGURACIÓN DE IA (ALINEADA A TU SCHEMA)
  // =================================================================

  async getUserDefaultAiConfig(
    userId: string,
  ): Promise<DefaultAiConfig | null> {
    const cached = this.aiConfigCache.get(userId);
    if (cached !== undefined) return cached;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        defaultProviderId: true,
        defaultAiModel: { select: { id: true, name: true } },
        aiConfigs: {
          select: {
            providerId: true,
            apiKey: true,
            isActive: true,
            provider: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!user) {
      this.aiConfigCache.set(userId, null);
      return null;
    }

    // Elegir config candidata
    let chosen:
      | { providerId: string; apiKey: string; isActive: boolean; provider: { id: string; name: string } }
      | undefined;

    if (user.defaultProviderId) {
      chosen =
        user.aiConfigs.find(
          (c) => c.providerId === user.defaultProviderId && c.isActive,
        ) ??
        user.aiConfigs.find((c) => c.providerId === user.defaultProviderId);
    }

    if (!chosen) {
      chosen = user.aiConfigs.find((c) => c.isActive) ?? user.aiConfigs[0];
    }

    const result: DefaultAiConfig = {
      userId: user.id,
      defaultProvider: chosen?.provider ?? null,
      defaultModel: user.defaultAiModel ?? null,
      defaultApiKey: chosen?.apiKey ?? null,
    };

    this.aiConfigCache.set(userId, result);
    return result;
  }
}
