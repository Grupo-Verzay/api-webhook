import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { PrismaService } from 'src/database/prisma.service';
import { HttpModule } from '@nestjs/axios';
import { SessionService } from 'src/modules/session/session.service';

@Module({
  imports: [HttpModule],
  controllers: [WebhookController],
  providers: [WebhookService, PrismaService, SessionService]
})
export class WebhookModule {}
