import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';

@Injectable()
export class AutoRepliesService {
    constructor(private readonly prisma: PrismaService) { }

    
    async getAutoRepliesByUserId(userId: string) {
        return this.prisma.rr.findMany({
            where: { userId },
            orderBy: { id: 'asc' },
        });
    }
}
