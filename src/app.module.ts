import { Module } from '@nestjs/common';
import { WebhookModule } from './webhook/webhook.module';
import { ServicesService } from './services/services.service';
import { PrismaModule } from './prisma/prisma.module';
import { ServicesService } from './services/services.service';

@Module({
  imports: [WebhookModule, PrismaModule],
  providers: [ServicesService],
})
export class AppModule {}
