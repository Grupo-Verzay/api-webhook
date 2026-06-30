import { Module } from '@nestjs/common';
import { VoicebotController } from './voicebot.controller';
import { VoicebotService } from './voicebot.service';
import { AiCreditsModule } from '../ai-credits/ai-credits.module';

@Module({
  imports: [AiCreditsModule],
  controllers: [VoicebotController],
  providers: [VoicebotService],
})
export class VoicebotModule {}
