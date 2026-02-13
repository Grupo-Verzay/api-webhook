import { TipoRegistro } from '@prisma/client';

/**
 * Salida normalizada del clasificador:
 * - kind=REPORTE => NO crea registro, solo actualiza síntesis.
 * - kind=REGISTRO => crea Registro con tipo/estado/resumen/detalles/meta.
 */
export class ClassificationResultDto {
    kind!: 'REPORTE' | 'REGISTRO';

    // Solo cuando kind=REGISTRO
    tipo?: TipoRegistro;
    estado?: string;

    // Campos de Registro (cuando aplique)
    resumen?: string;
    detalles?: string;
    lead?: boolean;
    nombre?: string;
    meta?: Record<string, any>;

    // Cuando kind=REPORTE
    sintesis?: string;
}
