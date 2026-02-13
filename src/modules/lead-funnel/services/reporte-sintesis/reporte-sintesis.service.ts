import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { normalizeText } from '../../utils/normalize-text';

@Injectable()
export class ReporteSintesisService {
    constructor(private readonly prisma: PrismaService) { }

    async updateSintesis(sessionId: number, sintesis: string): Promise<void> {
        const s = normalizeText(sintesis);
        if (!s) return;

        await this.prisma.session.update({
            where: { id: sessionId },
            data: { seguimientos: s },
        });
    }
}
