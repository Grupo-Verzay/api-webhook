import { Module } from '@nestjs/common';
import { EvolutionApiSenderAdapter } from './adapters/evolution-api.adapter';
import { BaileysSessionManager } from './adapters/baileys/baileys-session.manager';
import { BaileysSenderAdapter } from './adapters/baileys/baileys-sender.adapter';
import { WhatsAppSenderFactory } from './whatsapp-sender.factory';
import { WorkflowModule } from 'src/modules/workflow/workflow.module';

@Module({
  imports: [WorkflowModule],
  providers: [
    EvolutionApiSenderAdapter,
    BaileysSessionManager,
    BaileysSenderAdapter,
    WhatsAppSenderFactory,
  ],
  exports: [WhatsAppSenderFactory, BaileysSessionManager],
})
export class WhatsAppModule {}
