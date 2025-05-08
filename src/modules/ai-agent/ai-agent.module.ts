import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios'; // <-- importa HttpModule
import { ConfigModule } from '@nestjs/config'; // <-- también debes tenerlo para ConfigService
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

@Module({
  imports: [
    HttpModule,
    ConfigModule,
    WorkflowModule // necesario porque usas ConfigService
  ],
  providers: [AiAgentService,
    PromptService,
    ChatHistoryService,
    IntentionService,
    NodeSenderService,
    WorkflowService,
    IntentionService,
    SeguimientosService,
    SessionService,
    NotificacionToolService,
    AiCreditsService
  ],

  exports: [AiAgentService, NotificacionToolService, NodeSenderService, AiCreditsService ],
})
export class AiAgentModule { }
