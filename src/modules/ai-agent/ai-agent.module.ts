// ai-agent.module.ts
import { forwardRef, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { AiAgentService } from './ai-agent.service';
import { OwnerAgentService } from './owner/owner-agent.service';
import { PromptService } from '../prompt/prompt.service';
import { ChatHistoryService } from '../chat-history/chat-history.service';
import { IntentionService } from './services/intention/intention.service';
import { NodeSenderService } from '../workflow/services/node-sender.service.ts/node-sender.service';
import { WorkflowService } from '../workflow/services/workflow.service.ts/workflow.service';
import { SeguimientosService } from '../seguimientos/seguimientos.service';
import { SessionService } from '../session/session.service';
import { NotificacionToolService } from './tools/notificacion/notificacion.service';
import { WorkflowModule } from '../workflow/workflow.module';
import { AiCreditsModule } from '../ai-credits/ai-credits.module';
import { PromptCompressorService } from './services/prompt-compressor/prompt-compressor.service';
import { LlmClientFactory } from './services/llmClientFactory/llmClientFactory.service';
import { UserService } from '../user/user.service';
import { AgentNotificationService } from './services/notificacionService/notificacion.service';
import { NotificationContactsService } from './services/notificacionService/notification-contacts.service';
import { ExternalClientDataModule } from '../external-client-data/external-client-data.module';
import { TtsService } from './services/tts/tts.service';
import { GoogleSheetsModule } from '../google-sheets/google-sheets.module';
import { EvolutionApiSenderAdapter } from '../whatsapp/adapters/evolution-api.adapter';
import { MetaCloudApiSenderAdapter } from '../whatsapp/adapters/meta-cloud-api.adapter';
import { TelegramSenderAdapter } from '../whatsapp/adapters/telegram-sender.adapter';
import { BaileysSessionManager } from '../whatsapp/adapters/baileys/baileys-session.manager';
import { BaileysMessageStore } from '../whatsapp/adapters/baileys/baileys-message.store';
import { BaileysSenderAdapter } from '../whatsapp/adapters/baileys/baileys-sender.adapter';
import { MediaStorageService } from '../whatsapp/adapters/baileys/media-storage.service';
import { WhatsAppSenderFactory } from '../whatsapp/whatsapp-sender.factory';
import { SystemNotificationDispatcherService } from '../whatsapp/services/system-notification-dispatcher.service';

@Module({
  imports: [HttpModule, ConfigModule, forwardRef(() => WorkflowModule), ExternalClientDataModule, GoogleSheetsModule, AiCreditsModule],
  providers: [
    AiAgentService,
    OwnerAgentService,
    PromptService,
    ChatHistoryService,
    IntentionService,
    NodeSenderService,
    PromptCompressorService,
    SeguimientosService,
    SessionService,
    NotificacionToolService,
    LlmClientFactory,
    AgentNotificationService,
    NotificationContactsService,
    UserService,
    TtsService,
    EvolutionApiSenderAdapter,
    MetaCloudApiSenderAdapter,
    TelegramSenderAdapter,
    BaileysSessionManager,
    BaileysMessageStore,
    BaileysSenderAdapter,
    MediaStorageService,
    WhatsAppSenderFactory,
    SystemNotificationDispatcherService,
  ],
  exports: [
    NotificacionToolService,
    NodeSenderService,
    AiCreditsModule,
    LlmClientFactory,
    AgentNotificationService,
    AiAgentService,
    OwnerAgentService,
    TtsService,
  ],
})
export class AiAgentModule {}
