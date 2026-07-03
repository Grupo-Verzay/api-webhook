import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaService } from 'src/database/prisma.service';
import { WorkflowModule } from 'src/modules/workflow/workflow.module';
import { StageAutomationService } from './stage-automation.service';
import { StageAutomationController } from './stage-automation.controller';
import { AdvisorAutomationController } from './advisor-automation.controller';

@Module({
  imports: [HttpModule, WorkflowModule],
  controllers: [StageAutomationController, AdvisorAutomationController],
  providers: [StageAutomationService, PrismaService],
  exports: [StageAutomationService],
})
export class StageAutomationModule {}
