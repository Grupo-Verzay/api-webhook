import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { TipoRegistro } from '@prisma/client';
import { getDefaultEstado, ESTADOS_POR_TIPO } from '../../constants/estados-por-tipo';

@Injectable()
export class RegistroService {
  constructor(private readonly prisma: PrismaService) {}

  async createRegistro(params: {
    sessionId: number;
    tipo: TipoRegistro;
    estado?: string;
    resumen?: string;
    detalles?: string;
    lead?: boolean;
    nombre?: string;
    meta?: any;
    fecha?: Date;
  }) {
    const estadosValidos = ESTADOS_POR_TIPO[params.tipo] ?? [];
    const estado =
      params.estado && estadosValidos.includes(params.estado)
        ? params.estado
        : getDefaultEstado(params.tipo);

    return this.prisma.registro.create({
      data: {
        sessionId: params.sessionId,
        tipo: params.tipo,
        estado,
        resumen: params.resumen ?? null,
        detalles: params.detalles ?? null,
        lead: params.lead ?? null,
        nombre: params.nombre ?? null,
        meta: params.meta ?? null,
        fecha: params.fecha ?? new Date(),
      },
    });
  }
}
