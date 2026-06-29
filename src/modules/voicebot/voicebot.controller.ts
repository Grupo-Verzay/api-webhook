import { Controller, Get, Headers, Query } from '@nestjs/common';
import { VoicebotService } from './voicebot.service';

@Controller('voicebot')
export class VoicebotController {
  constructor(private readonly service: VoicebotService) {}

  // Consultado por wacalls al entrar una llamada:
  // GET /voicebot/resolve?sid=<sesion>&from=<numero>  (header X-Voicebot-Secret)
  @Get('resolve')
  resolve(
    @Query('sid') sid: string,
    @Headers('x-voicebot-secret') secret?: string,
  ) {
    return this.service.resolve(sid, secret);
  }
}
