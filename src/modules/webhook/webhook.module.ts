import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { PrismaService } from 'src/database/prisma.service';
import { HttpModule } from '@nestjs/axios';
import { SessionService } from 'src/modules/session/session.service';
import { MessageDirectionService } from './services/message-direction/message-direction.service';
import { MessageTypeHandlerService } from './services/message-type-handler/message-type-handler.service';
import { InstancesService } from '../instances/instances.service';
import { PromptService } from '../prompt/prompt.service';
import { UserService } from '../user/user.service';
import { MessageBufferService } from './services/message-buffer/message-buffer.service';
import { ChatHistoryService } from '../chat-history/chat-history.service';
import { WorkflowModule } from '../workflow/workflow.module';
import { IntentionService } from '../ai-agent/services/intention/intention.service';
import { SeguimientosService } from '../seguimientos/seguimientos.service';
import { AutoRepliesService } from '../auto-replies/auto-replies.service';
import { WebhookControlService } from './services/webhook-control/webhook-control.service';
import { SessionTriggerService } from '../session-trigger/session-trigger.service';
import { AntifloodService } from './services/antiflood/antiflood.service';
import { PromptCompressorService } from '../ai-agent/services/prompt-compressor/prompt-compressor.service';
import { AiAgentModule } from '../ai-agent/ai-agent.module';
import { LeadFunnelModule } from '../lead-funnel/lead-funnel.module';
import { FollowUpRunnerService } from './services/follow-up-runner/follow-up-runner.service';
import { FollowUpRunnerSchedulerService } from './services/follow-up-runner/follow-up-runner.scheduler.service';
import { BillingCronService } from './services/billing-cron/billing-cron.service';
import { BillingCronSchedulerService } from './services/billing-cron/billing-cron.scheduler.service';

@Module({
  imports: [HttpModule, WorkflowModule, AiAgentModule, LeadFunnelModule],

  controllers: [WebhookController],

  providers: [
    PrismaService,
    SessionService,
    UserService,
    InstancesService,
    PromptService,
    ChatHistoryService,
    IntentionService,
    PromptCompressorService,
    SeguimientosService,
    AutoRepliesService,
    SessionTriggerService,
    // pertenece
    WebhookService,
    WebhookControlService,
    BillingCronService,
    BillingCronSchedulerService,
    FollowUpRunnerService,
    FollowUpRunnerSchedulerService,
    MessageDirectionService,
    AntifloodService,
    MessageBufferService,
    MessageTypeHandlerService,
  ],
})
export class WebhookModule {}
