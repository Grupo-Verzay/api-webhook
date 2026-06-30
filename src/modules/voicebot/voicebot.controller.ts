import { Body, Controller, Get, Headers, Post, Query } from '@nestjs/common';
import { VoicebotService } from './voicebot.service';

@Controller('voicebot')
export class VoicebotController {
  constructor(private readonly service: VoicebotService) {}

  // Consultado por wacalls al entrar/iniciar una llamada:
  // GET /voicebot/resolve?sid=<sesion>&from=<numero>  (header X-Voicebot-Secret)
  @Get('resolve')
  resolve(
    @Query('sid') sid: string,
    @Headers('x-voicebot-secret') secret?: string,
  ) {
    return this.service.resolve(sid, secret);
  }

  // Reportado por wacalls al terminar una llamada del bot, para descontar
  // créditos: POST /voicebot/usage { sid, tokens }  (header X-Voicebot-Secret)
  @Post('usage')
  usage(
    @Body() body: { sid: string; tokens: number },
    @Headers('x-voicebot-secret') secret?: string,
  ) {
    return this.service.chargeUsage(body?.sid, body?.tokens, secret);
  }

  // Invocado por wacalls cuando el bot usa una herramienta durante la llamada
  // (function calling): POST /voicebot/tool { sid, phone, name, arguments }
  @Post('tool')
  tool(
    @Body() body: { sid: string; phone: string; name: string; arguments: string },
    @Headers('x-voicebot-secret') secret?: string,
  ) {
    return this.service.executeTool(body?.sid, body?.phone, body?.name, body?.arguments, secret);
  }
}
