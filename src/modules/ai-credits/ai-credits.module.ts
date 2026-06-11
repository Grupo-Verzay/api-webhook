import { Module } from '@nestjs/common';
import { AiCreditsService } from './ai-credits.service';
import { CreditRenewalService } from './credit-renewal.service';
import { CreditRenewalSchedulerService } from './credit-renewal.scheduler.service';

@Module({
  providers: [AiCreditsService, CreditRenewalService, CreditRenewalSchedulerService],
  exports: [AiCreditsService],
})
export class AiCreditsModule {}
