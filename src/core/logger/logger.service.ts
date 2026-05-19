import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/database/prisma.service'; // Prisma para guardar en BD

@Injectable()
export class LoggerService extends Logger {
  constructor(
    private readonly prisma: PrismaService,
    context: string = 'APP',
  ) {
    super(context);
  }

  async log(message: string, context?: string): Promise<void> {
    super.log(`🟢 LOG - ${message}`);
    await this.saveLog('info', message, context);
  }

  async error(message: any, trace?: string, context?: string): Promise<void> {
    super.error(`🔴 ERROR - ${message}`, trace);
    await this.saveLog('error', `${message} ${trace ?? ''}`.trim(), context);
  }

  async warn(message: string, context?: string): Promise<void> {
    super.warn(`🟡 WARNING - ${message}`);
    await this.saveLog('warn', message, context);
  }

  async debug(message: string, context?: string): Promise<void> {
    super.debug(`🔵 DEBUG - ${message}`);
  }

  async verbose(message: string, context?: string): Promise<void> {
    super.verbose(`🟣 VERBOSE - ${message}`);
  }

  //TODO: Mejorar para que guarde datos cómo instancia, user, y demás datos que sean necesarios.
  /**
   * Guarda el log en la base de datos.
   * @param {string} level - Nivel del log (log, warn, error, etc.).
   * @param {string} message - Contenido del log.
   * @param {string} [context] - Contexto o servicio donde ocurrió.
   */
  private async saveLog(
    level: string,
    message: string,
    context?: string,
  ): Promise<void> {
    try {
      await this.prisma.log.create({
        data: {
          id: randomUUID(),
          level,
          message,
          context,
        },
      });
    } catch (error) {
      // Evitar que un fallo en guardar el log crashee toda la app
      super.error(
        'Failed to save log to database',
        error.stack,
        'LoggerService',
      );
    }
  }
}
