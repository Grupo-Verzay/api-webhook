import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServicesService } from './services/services.service';
import { LoggerModule } from './core/logger/logger.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { AiAgentModule } from './modules/ai-agent/ai-agent.module';
import { LeadFunnelModule } from './modules/lead-funnel/lead-funnel.module';
import { RegistrosModule } from './modules/registros/registros.module';
import { ChatHistoryModule } from './modules/chat-history/chat-history.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // Así puedes usar ConfigService en cualquier parte
      load: [configuration], // Carga tu archivo src/config/configuration.ts
    }),
    WebhookModule,
    LoggerModule,
    DatabaseModule,
    AiAgentModule,
    LeadFunnelModule,
    RegistrosModule,
    ChatHistoryModule,
  ],
  providers: [
    ServicesService,
  ],
})
export class AppModule {}
