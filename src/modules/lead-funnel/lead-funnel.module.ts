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
import { CrmFollowUpRuleService } from './services/crm-follow-up-rule.service';
import { LeadStatusWorkflowTriggerService } from './services/lead-status-workflow-trigger.service';
import { WorkflowModule } from '../workflow/workflow.module';
import { StageAutomationModule } from '../stage-automation/stage-automation.module';

@Module({
  imports: [AiAgentModule, ChatHistoryModule, WorkflowModule, StageAutomationModule],
  providers: [
    LeadFunnelService,
    LeadClassifierIaService,
    RegistroService,
    ReporteSintesisService,
    LeadStatusIaService,
    CrmFollowUpRuleService,
    CrmFollowUpPlannerService,
    CrmFollowUpRunnerService,
    CrmFollowUpRunnerSchedulerService,
    LeadStatusWorkflowTriggerService,
  ],
  controllers: [LeadFunnelController],
  exports: [LeadFunnelService, CrmFollowUpRunnerService],
})
export class LeadFunnelModule {}
