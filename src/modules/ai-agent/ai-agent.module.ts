// ai-agent.module.ts
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { AiAgentService } from './ai-agent.service';
import { PromptService } from '../prompt/prompt.service';
import { ChatHistoryService } from '../chat-history/chat-history.service';
import { IntentionService } from './services/intention/intention.service';
import { NodeSenderService } from '../workflow/services/node-sender.service.ts/node-sender.service';
import { WorkflowService } from '../workflow/services/workflow.service.ts/workflow.service';
import { SeguimientosService } from '../seguimientos/seguimientos.service';
import { SessionService } from '../session/session.service';
import { NotificacionToolService } from './tools/notificacion/notificacion.service';
import { WorkflowModule } from '../workflow/workflow.module';
import { AiCreditsService } from '../ai-credits/ai-credits.service';
import { PromptCompressorService } from './services/prompt-compressor/prompt-compressor.service';
import { LlmClientFactory } from './services/llmClientFactory/llmClientFactory.service';
import { UserService } from '../user/user.service';
import { AgentNotificationService } from './services/notificacionService/notificacion.service';

@Module({
  imports: [
    HttpModule,
    ConfigModule,
    WorkflowModule,   // 👈 de aquí viene WorkflowService ya configurado
  ],
  providers: [
    AiAgentService,
    PromptService,
    ChatHistoryService,
    IntentionService,
    NodeSenderService,
    // ❌ QUITAR WorkflowService DE AQUÍ
    PromptCompressorService,
    SeguimientosService,
    SessionService,
    NotificacionToolService,
    AiCreditsService,
    LlmClientFactory,
    AgentNotificationService,
    UserService,
  ],
  exports: [
    AiAgentService,
    NotificacionToolService,
    NodeSenderService,
    AiCreditsService,
    LlmClientFactory,
    AgentNotificationService,
  ],
})
export class AiAgentModule {}
