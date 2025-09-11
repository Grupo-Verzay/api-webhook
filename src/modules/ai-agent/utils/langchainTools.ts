export const langchainTools: any[] = [
    {


        name: 'notificacion',
        description: 'Utiliza esta herramienta cuando un usuario necesite la asesoría de un asesor, haga una solicitud, reclamo o agendamiento.',
        schema: { // <-- Cambio aquí de 'parameters' a 'schema'
            type: 'object',
            properties: {
                nombre: { type: 'string', description: 'Nombre del usuario' },
                detalles: { type: 'string', description: 'Detalle de la notificación o solicitud' },
            },
            required: ['nombre', 'detalles'],
        },

    },
    {

        name: 'execute_workflow',
        description: 'Utiliza siempre esta herramienta para verificar si existe un flujo automatizado relacionado con la intención del usuario. Si se encuentra un flujo coincidente, se ejecuta automáticamente. Si no, la IA debe continuar la conversación de forma natural.',
        schema: { // <-- Cambio aquí de 'parameters' a 'schema'
            type: 'object',
            properties: {
                nombre_flujo: { type: 'string', description: 'Nombre del flujo' },
                detalles: { type: 'string', description: 'Solicitud del usuario' },
            },
            required: ['nombre_flujo', 'detalles'],
        },

    },
    {

        name: "listar_workflows",
        description: "Devuelve todos los flujos disponibles para este usuario",
        schema: { // <-- Cambio aquí de 'parameters' a 'schema'
            type: "object",
            properties: {},
            required: []
        }

    }
];