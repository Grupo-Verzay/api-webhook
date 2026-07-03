import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { StageAutomationService } from './stage-automation.service';

@Controller('appt-automations')
export class ApptAutomationController {
  constructor(private readonly service: StageAutomationService) {}

  @Post('execute')
  @HttpCode(200)
  async execute(
    @Body() body: { sessionId: number; apptStatus: AppointmentStatus },
    @Headers('x-internal-secret') secret?: string,
  ) {
    const expected = (process.env.CRM_FOLLOW_UP_RUNNER_KEY ?? '').trim();
    if (expected && secret !== expected) throw new UnauthorizedException();

    if (!body?.sessionId || !body?.apptStatus) {
      return { success: false, message: 'sessionId y apptStatus son requeridos' };
    }

    void this.service.executeForAppt(Number(body.sessionId), body.apptStatus);
    return { success: true };
  }
}
