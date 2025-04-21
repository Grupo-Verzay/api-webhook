import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { Account, ApiKey, Instancias, Pausar, SystemMessage, Tools, User, Session } from '@prisma/client';

@Injectable()
export class UserService {
    constructor(private readonly prisma: PrismaService) { }

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
}
