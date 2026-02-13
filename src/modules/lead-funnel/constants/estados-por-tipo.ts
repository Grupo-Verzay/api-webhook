import { TipoRegistro } from '@prisma/client';

export const ESTADOS_POR_TIPO: Record<TipoRegistro, string[]> = {
    REPORTE: ['Habilitado', 'Inhabilitado'],
    SOLICITUD: ['Pendiente', 'Procesando', 'Confirmado', 'Cancelado'],
    PEDIDO: ['Pendiente', 'Procesando', 'Despachado', 'En tránsito', 'Entregado', 'Cancelado'],
    RESERVA: ['Pendiente', 'Procesando', 'Confirmada', 'Cancelada'],
    RECLAMO: ['Pendiente', 'Procesando', 'Solucionado', 'Cancelado'],
    PAGO: ['Pendiente', 'Procesando', 'Confirmado', 'Cancelado'],
};

export const getDefaultEstado = (tipo: TipoRegistro): string => {
    const estados = ESTADOS_POR_TIPO[tipo] ?? [];
    return estados[0] ?? 'Pendiente';
};
