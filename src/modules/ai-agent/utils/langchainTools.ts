import { z } from 'zod';

// Definición de herramientas con Zod
export const langchainTools = [
  {
    name: 'Notificacion Asesor',
    description: 'Utiliza esta herramienta cuando un usuario necesite la asesoría de un asesor, haga una solicitud, reclamo o agendamiento.',
    schema: z.object({
      nombre: z.string().describe('Nombre del usuario'),
      detalles: z.string().describe('Detalle de la notificación o solicitud'),
    }),
  },
  {
    name: 'Ejecutar Flujos',
    description: 'Utiliza siempre esta herramienta para verificar si existe un flujo automatizado relacionado con la intención del usuario.',
    schema: z.object({
      nombre_flujo: z.string().describe('Nombre del flujo'),
      detalles: z.string().describe('Solicitud del usuario'),
    }),
  },
  {
    name: 'listar_workflows',
    description: 'Devuelve todos los flujos disponibles para este usuario.',
    schema: z.object({}),
  },
];
