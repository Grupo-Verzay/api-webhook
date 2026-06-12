import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { LeadStatus } from '@prisma/client';
import { StageAutomationService } from './stage-automation.service';

@Controller('stage-automations')
export class StageAutomationController {
  constructor(private readonly service: StageAutomationService) {}

  @Post('execute')
  @HttpCode(200)
  async execute(
    @Body() body: { sessionId: number; newStage: LeadStatus },
    @Headers('x-internal-secret') secret?: string,
  ) {
    const expected = (process.env.CRM_FOLLOW_UP_RUNNER_KEY ?? '').trim();
    if (expected && secret !== expected) throw new UnauthorizedException();

    if (!body?.sessionId || !body?.newStage) {
      return { success: false, message: 'sessionId y newStage son requeridos' };
    }

    void this.service.executeForSession(Number(body.sessionId), body.newStage);
    return { success: true };
  }
}
