import { Injectable, Logger } from '@nestjs/common';
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
    super.log(`🟢 LOG - ${message}`, context);
    await this.saveLog('Out', `${message}`, context);
  }

  async error(message: any, trace?: string, context?: string): Promise<void> {
    super.error(`🔴 ERROR - ${message}`, trace, context);
    await this.saveLog('error', `${message} ${trace ?? ''}`, context);
  }

  async warn(message: string, context?: string): Promise<void> {
    super.warn(`🟡 WARNING - ${message}`, context);
    await this.saveLog('warn', message, context);
  }

  async debug(message: string, context?: string): Promise<void> {
    super.debug(`🔵 DEBUG - ${message}`, context);
    // await this.saveLog('debug', message, context);
  }

  async verbose(message: string, context?: string): Promise<void> {
    super.verbose(`🟣 VERBOSE - ${message}`, context);
  }

  //TODO: Mejorar para que guarde datos cómo instancia, user, y demás datos que sean necesarios.
  /**
   * Guarda el log en la base de datos.
   * @param {string} level - Nivel del log (log, warn, error, etc.).
   * @param {string} message - Contenido del log.
   * @param {string} [context] - Contexto o servicio donde ocurrió.
   */
  private async saveLog(level: string, message: string, context?: string): Promise<void> {
    try {
      await this.prisma.log.create({
        data: {
          level,
          message,
          context,
        },
      });
    } catch (error) {
      // Evitar que un fallo en guardar el log crashee toda la app
      super.error('Failed to save log to database', error.stack, 'LoggerService');
    }
  }
}
