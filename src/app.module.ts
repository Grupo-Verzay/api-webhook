import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServicesService } from './services/services.service';
import { LoggerModule } from './core/logger/logger.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { AiAgentModule } from './modules/ai-agent/ai-agent.module';
import { AiCreditsModule } from './modules/ai-credits/ai-credits.module';
import { LeadFunnelModule } from './modules/lead-funnel/lead-funnel.module';
import { RegistrosModule } from './modules/registros/registros.module';
import { ChatHistoryModule } from './modules/chat-history/chat-history.module';
import { GoogleSheetsModule } from './modules/google-sheets/google-sheets.module';
import { HealthController } from './health/health.controller';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    WebhookModule,
    LoggerModule,
    DatabaseModule,
    AiAgentModule,
    AiCreditsModule,
    LeadFunnelModule,
    RegistrosModule,
    ChatHistoryModule,
    GoogleSheetsModule,
  ],
  providers: [
    ServicesService,
  ],
})
export class AppModule {}
