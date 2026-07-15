export type DefaultExternalToolConfig = {
  toolKey: string;
  displayName: string;
  toolDescription: string;
  toolCategory: string;
  toolType: string;
  sortOrder: number;
};

export const DEFAULT_EXTERNAL_TOOL_CONFIGS: DefaultExternalToolConfig[] = [
  {
    toolKey: 'Notificacion_Asesor',
    displayName: 'Notificacion Asesor',
    toolDescription:
      'Utiliza esta *tool* solo cuando un usuario necesite ayuda directa de un asesor humano o exista un registro que requiere atencion manual (solicitud, pedido, reclamo o comprobante de pago). No la uses despues de crear una cita/reserva con las herramientas de agenda, porque ese flujo ya envia su confirmacion automatica.',
    toolCategory: 'builtin',
    toolType: 'notificacion_asesor',
    sortOrder: 0,
  },
  {
    toolKey: 'Ejecutar_Flujos',
    displayName: 'Ejecutar Flujos',
    toolDescription:
      'Siempre consulta y ejecuta si existen flujos disponibles en la base de datos que correspondan a la solicitud del usuario. Si se encuentra un flujo, se ejecuta. Si no hay flujos, la IA continúa la conversación normalmente.',
    toolCategory: 'builtin',
    toolType: 'ejecutar_flujos',
    sortOrder: 1,
  },
  {
    toolKey: 'listar_workflows',
    displayName: 'Listar Flujos',
    toolDescription: 'Devuelve todos los flujos disponibles para este usuario.',
    toolCategory: 'builtin',
    toolType: 'listar_workflows',
    sortOrder: 2,
  },
  {
    toolKey: 'consultar_datos_cliente',
    displayName: 'Consultar Datos Cliente',
    toolDescription:
      'Consulta el perfil externo del cliente actual: cédula, correo, servicio contratado, monto, sector, convenio u otros campos configurados por el administrador.',
    toolCategory: 'builtin',
    toolType: 'consultar_datos_cliente',
    sortOrder: 3,
  },
  {
    toolKey: 'buscar_cliente_por_dato',
    displayName: 'Buscar Cliente por Dato',
    toolDescription:
      'Busca la información de un cliente a partir de un dato conocido como cédula, RIF, correo u otro campo registrado. Solo consulta datos del usuario actual.',
    toolCategory: 'builtin',
    toolType: 'buscar_cliente_por_dato',
    sortOrder: 4,
  },
  {
    toolKey: 'buscar_producto',
    displayName: 'Buscar Producto',
    toolDescription:
      'Busca productos del catálogo por nombre, categoría o SKU. Úsala cuando el cliente pregunte por un producto específico o quiera saber si existe un artículo determinado.',
    toolCategory: 'builtin',
    toolType: 'buscar_producto',
    sortOrder: 5,
  },
  {
    toolKey: 'listar_productos',
    displayName: 'Listar Productos',
    toolDescription:
      'Devuelve el catálogo completo de productos activos disponibles. Úsala cuando el cliente pida ver todos los productos, el catálogo o las opciones disponibles.',
    toolCategory: 'builtin',
    toolType: 'listar_productos',
    sortOrder: 6,
  },
];
