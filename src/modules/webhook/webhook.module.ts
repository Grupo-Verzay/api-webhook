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
  ]
})
export class WebhookModule { }
