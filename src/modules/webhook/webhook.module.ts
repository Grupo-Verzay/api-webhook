import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { PrismaService } from 'src/database/prisma.service';
import { HttpModule } from '@nestjs/axios';
import { SessionService } from 'src/modules/session/session.service';
import { MessageDirectionService } from './services/message-direction/message-direction.service';
import { MessageTypeHandlerService } from './services/message-type-handler/message-type-handler.service';
import { InstancesService } from '../instances/instances.service';
import { AiAgentService } from '../ai-agent/ai-agent.service';
import { PromptService } from '../prompt/prompt.service';
import { UserService } from '../user/user.service';
import { MessageBufferService } from './services/message-buffer/message-buffer.service';
import { ChatHistoryService } from '../chat-history/chat-history.service';
import { WorkflowModule } from '../workflow/workflow.module';
import { IntentionService } from '../ai-agent/services/intention/intention.service';
import { NodeSenderService } from '../workflow/services/node-sender.service.ts/node-sender.service';
import { SeguimientosService } from '../seguimientos/seguimientos.service';
import { AutoRepliesService } from '../auto-replies/auto-replies.service';
import { WorkflowService } from '../workflow/services/workflow.service.ts/workflow.service';
import { NotificacionToolService } from '../ai-agent/tools/notificacion/notificacion.service';
import { AiCreditsService } from '../ai-credits/ai-credits.service';
import { WebhookControlService } from './services/webhook-control/webhook-control.service';
import { SessionTriggerService } from '../session-trigger/session-trigger.service';

@Module({
  imports: [HttpModule, WorkflowModule],

  controllers: [WebhookController],

  providers: [
    WebhookService,
    PrismaService,
    SessionService,
    UserService,
    InstancesService,
    MessageDirectionService,
    MessageBufferService,
    MessageTypeHandlerService,
    AiAgentService,
    PromptService,
    MessageBufferService,
    ChatHistoryService,
    IntentionService,
    NodeSenderService,
    SeguimientosService,
    AutoRepliesService,
    WorkflowService,
    NotificacionToolService,
    AiCreditsService,
    WebhookControlService,
    SessionTriggerService
  ]
})
export class WebhookModule { }
