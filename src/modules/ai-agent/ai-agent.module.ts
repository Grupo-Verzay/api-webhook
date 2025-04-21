import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios'; // <-- importa HttpModule
import { ConfigModule } from '@nestjs/config'; // <-- también debes tenerlo para ConfigService
import { AiAgentService } from './ai-agent.service';
import { PromptService } from '../prompt/prompt.service';

@Module({
  imports: [
    HttpModule, 
    ConfigModule, // necesario porque usas ConfigService
  ],
  providers: [AiAgentService, PromptService],
  exports: [AiAgentService],
})
export class AiAgentModule {}
