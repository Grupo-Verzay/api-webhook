import { Module } from '@nestjs/common';
import { VoicebotController } from './voicebot.controller';
import { VoicebotService } from './voicebot.service';

@Module({
  controllers: [VoicebotController],
  providers: [VoicebotService],
})
export class VoicebotModule {}
