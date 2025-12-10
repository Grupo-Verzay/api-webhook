import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaService } from 'src/database/prisma.service';
import { WorkflowService } from './services/workflow.service.ts/workflow.service';
import { NodeSenderService } from './services/node-sender.service.ts/node-sender.service';
import { SeguimientosService } from '../seguimientos/seguimientos.service';
import { SessionService } from '../session/session.service';
import { SessionTriggerModule } from 'src/modules/session-trigger/session-trigger.module';

@Module({
  imports: [HttpModule, SessionTriggerModule],
  providers: [
    WorkflowService,
    PrismaService,
    NodeSenderService,
    SeguimientosService,
    SessionService,
  ],
  exports: [WorkflowService],
})
export class WorkflowModule {}
