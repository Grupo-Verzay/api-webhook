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
    @Query('from') from?: string,
    @Headers('x-voicebot-secret') secret?: string,
  ) {
    return this.service.resolve(sid, from, secret);
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

  // Reportado por wacalls al TERMINAR una llamada saliente del bot:
  // POST /voicebot/call-result { sid, phone, answered }  (header X-Voicebot-Secret)
  // Si answered=false y la cuenta tiene activado el auto-mensaje "al no contestar",
  // se le envía el texto configurado al contacto por WhatsApp.
  @Post('call-result')
  callResult(
    @Body() body: { sid: string; phone: string; answered: boolean },
    @Headers('x-voicebot-secret') secret?: string,
  ) {
    return this.service.handleCallResult(body?.sid, body?.phone, !!body?.answered, secret);
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
