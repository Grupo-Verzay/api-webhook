import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { AiCreditsService } from './ai-credits.service';

@Injectable()
export class CreditRenewalService {
  constructor(
    private readonly aiCreditsService: AiCreditsService,
    private readonly logger: LoggerService,
  ) {}

  async execute(): Promise<{ count: number }> {
    this.logger.log('[CreditRenewal] Verificando renovaciones pendientes...');
    const result = await this.aiCreditsService.renewDueCredits();
    if (result.count > 0) {
      this.logger.log(`[CreditRenewal] ${result.count} usuarios renovados.`);
    }
    return result;
  }
}
