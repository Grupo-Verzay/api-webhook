import { Module } from '@nestjs/common';
import { EvolutionApiSenderAdapter } from './adapters/evolution-api.adapter';
import { BaileysSessionManager } from './adapters/baileys/baileys-session.manager';
import { BaileysSenderAdapter } from './adapters/baileys/baileys-sender.adapter';
import { BaileysMessageStore } from './adapters/baileys/baileys-message.store';
import { MediaStorageService } from './adapters/baileys/media-storage.service';
import { MetaCloudApiSenderAdapter } from './adapters/meta-cloud-api.adapter';
import { WhatsAppSenderFactory } from './whatsapp-sender.factory';
import { WhatsAppController } from './whatsapp.controller';
import { WorkflowModule } from 'src/modules/workflow/workflow.module';

@Module({
  imports: [WorkflowModule],
  controllers: [WhatsAppController],
  providers: [
    EvolutionApiSenderAdapter,
    BaileysSessionManager,
    BaileysSenderAdapter,
    BaileysMessageStore,
    MediaStorageService,
    MetaCloudApiSenderAdapter,
    WhatsAppSenderFactory,
  ],
  exports: [WhatsAppSenderFactory, BaileysSessionManager, BaileysMessageStore, BaileysSenderAdapter],
})
export class WhatsAppModule {}
