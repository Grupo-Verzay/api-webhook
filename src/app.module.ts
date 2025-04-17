import { Module } from '@nestjs/common';
import { ServicesService } from './services/services.service';
import { PrismaService } from './prisma.service';
import { SessionService } from './modules/session/session.service';
import { LoggerModule } from './core/logger/logger.module';
import { WebhookModule } from './modules/webhook/webhook.module';

@Module({
  imports: [WebhookModule, LoggerModule],
  providers: [ServicesService, PrismaService, SessionService],
})
export class AppModule {}
