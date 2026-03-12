import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';

import { CrmFollowUpRunnerService } from './services/crm-follow-up-runner.service';

@Controller('lead-funnel')
export class LeadFunnelController {
  constructor(
    private readonly crmFollowUpRunnerService: CrmFollowUpRunnerService,
  ) {}

  @Post('crm-follow-up/process')
  async processCrmFollowUps(
    @Body() body: { limit?: number; userId?: string; instanceId?: string; remoteJid?: string } | undefined,
    @Headers('x-runner-key') runnerKey?: string,
  ) {
    const expectedKey =
      (process.env.CRM_FOLLOW_UP_RUNNER_KEY ?? '').trim()
      || (process.env.FOLLOW_UP_RUNNER_KEY ?? '').trim();

    if (expectedKey && runnerKey !== expectedKey) {
      throw new UnauthorizedException('runner key invalida');
    }

    const requestedLimit = Number(body?.limit ?? 25);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 25;

    return this.crmFollowUpRunnerService.processDueFollowUps(limit, {
      userId: body?.userId?.trim() || undefined,
      instanceId: body?.instanceId?.trim() || undefined,
      remoteJid: body?.remoteJid?.trim() || undefined,
    });
  }
}
