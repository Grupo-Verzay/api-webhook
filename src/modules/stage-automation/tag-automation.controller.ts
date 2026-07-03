import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { StageAutomationService } from './stage-automation.service';

@Controller('tag-automations')
export class TagAutomationController {
  constructor(private readonly service: StageAutomationService) {}

  @Post('execute')
  @HttpCode(200)
  async execute(
    @Body() body: { sessionId: number; tagId: number },
    @Headers('x-internal-secret') secret?: string,
  ) {
    const expected = (process.env.CRM_FOLLOW_UP_RUNNER_KEY ?? '').trim();
    if (expected && secret !== expected) throw new UnauthorizedException();

    if (!body?.sessionId || !body?.tagId) {
      return { success: false, message: 'sessionId y tagId son requeridos' };
    }

    void this.service.executeForTag(Number(body.sessionId), Number(body.tagId));
    return { success: true };
  }
}
