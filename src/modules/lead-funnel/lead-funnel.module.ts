import { Module } from '@nestjs/common';
import { LeadFunnelService } from './services/lead-funnel/lead-funnel.service';
import { LeadClassifierIaService } from './services/lead-classifier-ia/lead-classifier-ia.service';
import { RegistroService } from './services/registro/registro.service';
import { ReporteSintesisService } from './services/reporte-sintesis/reporte-sintesis.service';
import { LeadFunnelController } from './lead-funnel.controller';
import { AiAgentModule } from '../ai-agent/ai-agent.module';
import { ChatHistoryModule } from '../chat-history/chat-history.module';
import { LeadStatusIaService } from './services/lead-status-ia.service';
import { CrmFollowUpPlannerService } from './services/crm-follow-up-planner.service';
import { CrmFollowUpRunnerService } from './services/crm-follow-up-runner.service';
import { CrmFollowUpRunnerSchedulerService } from './services/crm-follow-up-runner.scheduler.service';

@Module({
  imports: [AiAgentModule, ChatHistoryModule],
  providers: [
    LeadFunnelService,
    LeadClassifierIaService,
    RegistroService,
    ReporteSintesisService,
    LeadStatusIaService,
    CrmFollowUpPlannerService,
    CrmFollowUpRunnerService,
    CrmFollowUpRunnerSchedulerService,
  ],
  controllers: [LeadFunnelController],
  exports: [LeadFunnelService, CrmFollowUpRunnerService],
})
export class LeadFunnelModule {}
