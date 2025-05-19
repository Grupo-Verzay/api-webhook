import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServicesService } from './services/services.service';
import { SessionService } from './modules/session/session.service';
import { LoggerModule } from './core/logger/logger.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { InstancesService } from './modules/instances/instances.service';
import { AiAgentModule } from './modules/ai-agent/ai-agent.module';
import { UserService } from './modules/user/user.service';
import { ChatHistoryService } from './modules/chat-history/chat-history.service';
import { SeguimientosService } from './modules/seguimientos/seguimientos.service';
import { AutoRepliesService } from './modules/auto-replies/auto-replies.service';
import { NotificacionToolService } from './modules/ai-agent/tools/notificacion/notificacion.service';
import { AiCreditsService } from './modules/ai-credits/ai-credits.service';
import { SessionTriggerService } from './modules/session-trigger/session-trigger.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // Así puedes usar ConfigService en cualquier parte
      load: [configuration], // Carga tu archivo src/config/configuration.ts
    }),
    WebhookModule,
    LoggerModule,
    DatabaseModule,
    AiAgentModule
  ],
  providers: [
    ServicesService,
    SessionService,
    InstancesService,
    UserService,
    ChatHistoryService,
    SeguimientosService,
    AutoRepliesService,
    NotificacionToolService,
    AiCreditsService,
    SessionTriggerService,
  ],
})
export class AppModule { }
