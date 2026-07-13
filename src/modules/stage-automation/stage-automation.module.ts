import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaService } from 'src/database/prisma.service';
import { WorkflowModule } from 'src/modules/workflow/workflow.module';
import { WhatsAppModule } from 'src/modules/whatsapp/whatsapp.module';
import { StageAutomationService } from './stage-automation.service';
import { StageAutomationController } from './stage-automation.controller';
import { AdvisorAutomationController } from './advisor-automation.controller';
import { TagAutomationController } from './tag-automation.controller';
import { ApptAutomationController } from './appt-automation.controller';
import { TaskTypeAutomationController } from './task-type-automation.controller';

@Module({
  imports: [HttpModule, WorkflowModule, WhatsAppModule],
  controllers: [
    StageAutomationController,
    AdvisorAutomationController,
    TagAutomationController,
    ApptAutomationController,
    TaskTypeAutomationController,
  ],
  providers: [StageAutomationService, PrismaService],
  exports: [StageAutomationService],
})
export class StageAutomationModule {}
