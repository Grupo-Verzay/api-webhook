import { Module } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { PromptService } from './prompt.service';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [
      HttpModule, 
      ConfigModule, // necesario porque usas ConfigService
  ],
  providers: [PromptService, PrismaService],
  exports: [PromptService],
})
export class PromptModule {}