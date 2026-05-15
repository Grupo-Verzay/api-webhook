import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { IWhatsAppSender } from './interfaces/whatsapp-sender.interface';
import { EvolutionApiSenderAdapter } from './adapters/evolution-api.adapter';
import { BaileysSenderAdapter } from './adapters/baileys/baileys-sender.adapter';

@Injectable()
export class WhatsAppSenderFactory {
  constructor(
    private readonly evolutionAdapter: EvolutionApiSenderAdapter,
    private readonly baileysAdapter: BaileysSenderAdapter,
    private readonly prisma: PrismaService,
  ) {}

  async getSender(instanceName: string): Promise<IWhatsAppSender> {
    const instance = await this.prisma.instancia.findFirst({
      where: { instanceName },
      select: { instanceType: true },
    });

    if (instance?.instanceType === 'baileys') {
      return this.baileysAdapter;
    }

    return this.evolutionAdapter;
  }

  getSenderSync(instanceType?: string | null): IWhatsAppSender {
    if (instanceType === 'baileys') return this.baileysAdapter;
    return this.evolutionAdapter;
  }
}
