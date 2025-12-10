// src/modules/session-trigger/session-trigger.module.ts
import { Module } from '@nestjs/common';
import { SessionTriggerService } from './session-trigger.service';
import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';

@Module({
  providers: [SessionTriggerService, PrismaService, LoggerService],
  exports: [SessionTriggerService], // 👈 CLAVE
})
export class SessionTriggerModule {}
