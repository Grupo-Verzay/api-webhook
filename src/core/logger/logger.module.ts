import { Global, Module } from '@nestjs/common';
import { LoggerService } from './logger.service';

@Global() // Permite que Logger esté disponible en toda la app sin importar imports
@Module({
  providers: [LoggerService],
  exports: [LoggerService],
})
export class LoggerModule {}
