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
import { LogCleanupService } from './services/log-cleanup/log-cleanup.service';
import { LogCleanupSchedulerService } from './services/log-cleanup/log-cleanup.scheduler.service';
import { PaymentReceiptModule } from 'src/modules/payment-receipt/payment-receipt.module';
import { AutoAssignService } from './services/auto-assign/auto-assign.service';
import { SessionTriggerRunnerService } from './services/session-trigger-runner/session-trigger-runner.service';
import { SessionTriggerRunnerSchedulerService } from './services/session-trigger-runner/session-trigger-runner.scheduler.service';
import { RemindersRunnerService } from './services/reminders-runner/reminders-runner.service';
import { RemindersRunnerSchedulerService } from './services/reminders-runner/reminders-runner.scheduler.service';
import { WeeklyReportCronService } from './services/weekly-report-cron/weekly-report-cron.service';
import { WeeklyReportCronSchedulerService } from './services/weekly-report-cron/weekly-report-cron.scheduler.service';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { BaileysWebhookBridgeService } from './services/baileys-webhook-bridge/baileys-webhook-bridge.service';
import { MessageDeduplicationService } from './services/message-deduplication/message-deduplication.service';
import { ConversationControlService } from './services/conversation-control/conversation-control.service';
import { SessionOrchestrationService } from './services/session-orchestration/session-orchestration.service';

@Module({
  imports: [HttpModule, WorkflowModule, AiAgentModule, LeadFunnelModule, PaymentReceiptModule, WhatsAppModule],

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
    LogCleanupService,
    LogCleanupSchedulerService,
    FollowUpRunnerService,
    FollowUpRunnerSchedulerService,
    MessageDirectionService,
    AntifloodService,
    MessageBufferService,
    MessageTypeHandlerService,
    AutoAssignService,
    SessionTriggerRunnerService,
    SessionTriggerRunnerSchedulerService,
    RemindersRunnerService,
    RemindersRunnerSchedulerService,
    WeeklyReportCronService,
    WeeklyReportCronSchedulerService,
    BaileysWebhookBridgeService,
    MessageDeduplicationService,
    ConversationControlService,
    SessionOrchestrationService,
  ],
})
export class WebhookModule {}
