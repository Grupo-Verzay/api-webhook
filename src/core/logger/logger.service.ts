import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class LoggerService extends Logger {
    constructor(context: string = 'Application') {
        super(context);
    }

    log(message: string, context?: string): void {
        super.log(`🟢 LOG - ${message}`, context);
    }

    error(message: any, trace?: string, context?: string): void {
        super.error(`🔴 ERROR - ${message}`, trace, context);
    }

    warn(message: string, context?: string): void {
        super.warn(`🟡 WARNING - ${message}`, context);
    }

    debug(message: string, context?: string): void {
        super.debug(`🔵 DEBUG - ${message}`, context);
    }

    verbose(message: string, context?: string): void {
        super.verbose(`🟣 VERBOSE - ${message}`, context);
    }
}
