import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { LoggerService } from 'src/core/logger/logger.service';
import {
  buildWhatsAppJidCandidates,
} from 'src/utils/whatsapp-jid.util';
import { DEFAULT_EXTERNAL_TOOL_CONFIGS } from './default-tool-configs';
import type {
  ExternalClientDataRecord,
  IExternalClientDataProvider,
} from './interfaces/external-client-data.interface';

@Injectable()
export class ExternalClientDataService implements IExternalClientDataProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Busca los datos externos de un cliente usando candidatos de JID.
   * Genera variantes (con/sin sufijo, sólo dígitos) para cubrir distintos formatos
   * que pueden haber sido usados al importar los datos.
   */
  async getByRemoteJid(
    userId: string,
    remoteJid: string,
  ): Promise<ExternalClientDataRecord | null> {
    if (!userId || !remoteJid) return null;

    const candidates = buildWhatsAppJidCandidates(remoteJid);

    try {
      const record = await this.prisma.externalClientData.findFirst({
        where: {
          userId,
          remoteJid: { in: candidates },
        },
      });

      if (!record) return null;

      return record.data as ExternalClientDataRecord;
    } catch (error: any) {
      this.logger.error(
        `[ExternalClientData] Error al buscar datos para remoteJid=${remoteJid}`,
        error?.message,
        'ExternalClientDataService',
      );
      return null;
    }
  }

  /**
   * Busca un registro cuyo campo data[fieldName] coincida con value,
   * siempre dentro del scope del userId (nunca cruza datos de otros usuarios).
   *
   * La búsqueda es case-insensitive (LOWER en ambos lados).
   * El fieldName se sanitiza para prevenir SQL injection antes de
   * usarse como identificador raw en la consulta JSON.
   *
   * @example getByDataField(userId, 'CEDULA-RIF', 'V27548446')
   */
  async getByDataField(
    userId: string,
    fieldName: string,
    value: string,
  ): Promise<ExternalClientDataRecord[]> {
    if (!userId || !fieldName || !value) return [];

    // Solo permite: letras, dígitos, guión, guión_bajo y espacios.
    // Cualquier otro carácter es rechazado para evitar inyección en el nombre del campo.
    const safeField = fieldName.replace(/[^a-zA-Z0-9\-_ ]/g, '');
    if (!safeField) return [];

    try {
      const rows = await this.prisma.$queryRaw<Array<{ data: unknown }>>(
        Prisma.sql`
          SELECT data
          FROM external_client_data
          WHERE "userId" = ${userId}
            AND LOWER(data->>${Prisma.raw(`'${safeField}'`)}) = LOWER(${value})
          ORDER BY id ASC
        `,
      );

      return rows.map((r) => r.data as ExternalClientDataRecord);
    } catch (error: any) {
      this.logger.error(
        `[ExternalClientData] Error al buscar por campo=${fieldName} value=${value}`,
        error?.message,
        'ExternalClientDataService',
      );
      return [];
    }
  }

  /**
   * Obtiene todas las herramientas dinámicas configuradas para un usuario.
   * Se usan para generar tools de LangChain en tiempo de ejecución.
   */
  async getToolConfigs(userId: string) {
    if (!userId) return [];

    try {
      let configs = await this.prisma.externalDataToolConfig.findMany({
        where: { userId, isEnabled: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });

      if (configs.length > 0) return configs;

      await this.ensureDefaultToolConfigs(userId);

      configs = await this.prisma.externalDataToolConfig.findMany({
        where: { userId, isEnabled: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });

      return configs;
    } catch (error: any) {
      this.logger.error(
        `[ExternalClientData] Error al obtener tool configs para userId=${userId}`,
        error?.message,
        'ExternalClientDataService',
      );
      return [];
    }
  }

  /**
   * Convierte el mapa de datos en una cadena legible para el agente de IA.
   * Ejemplo: "CEDULA: 12345678 | SERVICIO: Internet 10Mb | MONTO: $25.00"
   */
  formatForAgent(data: ExternalClientDataRecord): string {
    return Object.entries(data)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => `${key.toUpperCase()}: ${String(value)}`)
      .join(' | ');
  }

  /**
   * Aplica el template de prompt, reemplazando {data} con los datos formateados.
   */
  applyPromptTemplate(template: string, formattedData: string): string {
    return template.replace(/\{data\}/g, formattedData);
  }

  private async ensureDefaultToolConfigs(userId: string): Promise<void> {
    for (const cfg of DEFAULT_EXTERNAL_TOOL_CONFIGS) {
      const existing = await this.prisma.externalDataToolConfig.findUnique({
        where: { userId_toolKey: { userId, toolKey: cfg.toolKey } },
      });
      if (existing) {
        // Si ya existe pero está desactivado, reactivarlo
        if (!existing.isEnabled) {
          await this.prisma.externalDataToolConfig.update({
            where: { userId_toolKey: { userId, toolKey: cfg.toolKey } },
            data: { isEnabled: true },
          });
        }
      } else {
        await this.prisma.externalDataToolConfig.create({
          data: {
            userId,
            toolKey: cfg.toolKey,
            displayName: cfg.displayName,
            toolDescription: cfg.toolDescription,
            toolCategory: cfg.toolCategory,
            toolType: cfg.toolType,
            isEnabled: true,
            isDefault: true,
            sortOrder: cfg.sortOrder,
          },
        });
      }
    }
  }
}
