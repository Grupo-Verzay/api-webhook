import { forwardRef, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaService } from 'src/database/prisma.service';
import { WorkflowService } from './services/workflow.service.ts/workflow.service';
import { NodeSenderService } from './services/node-sender.service.ts/node-sender.service';
import { SeguimientosService } from '../seguimientos/seguimientos.service';
import { SessionService } from '../session/session.service';
import { SessionTriggerModule } from 'src/modules/session-trigger/session-trigger.module';
import { AiAgentModule } from '../ai-agent/ai-agent.module';
import { ChatHistoryModule } from '../chat-history/chat-history.module';
import { NotificationContactsService } from '../ai-agent/services/notificacionService/notification-contacts.service';

@Module({
  imports: [
    HttpModule,
    SessionTriggerModule,
    forwardRef(() => AiAgentModule),
    ChatHistoryModule,
  ],
  providers: [
    WorkflowService,
    PrismaService,
    NodeSenderService,
    SeguimientosService,
    SessionService,
    NotificationContactsService,
  ],
  exports: [WorkflowService],
})
export class WorkflowModule {}
