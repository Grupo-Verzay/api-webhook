import { Module } from '@nestjs/common';
import { VoicebotController } from './voicebot.controller';
import { VoicebotService } from './voicebot.service';
import { AiCreditsModule } from '../ai-credits/ai-credits.module';
import { AiAgentModule } from '../ai-agent/ai-agent.module';

@Module({
  imports: [AiCreditsModule, AiAgentModule],
  controllers: [VoicebotController],
  providers: [VoicebotService],
})
export class VoicebotModule {}
