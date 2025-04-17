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
  ],
})
export class AppModule { }
