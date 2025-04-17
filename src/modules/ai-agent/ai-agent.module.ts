import { Module } from '@nestjs/common';
import { AiAgentService } from './ai-agent.service';

@Module({
  providers: [AiAgentService]
})
export class AiAgentModule {}
