import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { StageAutomationService } from './stage-automation.service';

@Controller('advisor-automations')
export class AdvisorAutomationController {
  constructor(private readonly service: StageAutomationService) {}

  @Post('execute')
  @HttpCode(200)
  async execute(
    @Body() body: { sessionId: number; advisorId: string },
    @Headers('x-internal-secret') secret?: string,
  ) {
    const expected = (process.env.CRM_FOLLOW_UP_RUNNER_KEY ?? '').trim();
    if (expected && secret !== expected) throw new UnauthorizedException();

    if (!body?.sessionId || !body?.advisorId) {
      return { success: false, message: 'sessionId y advisorId son requeridos' };
    }

    void this.service.executeForAdvisor(Number(body.sessionId), String(body.advisorId));
    return { success: true };
  }
}
