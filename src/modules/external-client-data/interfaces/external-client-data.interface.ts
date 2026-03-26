export type ExternalClientDataRecord = Record<string, unknown>;

/**
 * Contrato para proveedores de datos externos de clientes.
 * Implementar esta interfaz permite intercambiar la fuente de datos
 * sin modificar el agente de IA (principio de inversión de dependencias).
 */
export interface IExternalClientDataProvider {
  /**
   * Busca los datos externos asociados a un remoteJid para el usuario dado.
   * Retorna null si no hay registro.
   */
  getByRemoteJid(
    userId: string,
    remoteJid: string,
  ): Promise<ExternalClientDataRecord | null>;

  /**
   * Busca un registro cuyo campo data[fieldName] coincida con value.
   * La búsqueda es case-insensitive y siempre scoped al userId del dueño.
   * Retorna null si no hay coincidencia.
   */
  getByDataField(
    userId: string,
    fieldName: string,
    value: string,
  ): Promise<ExternalClientDataRecord | null>;

  /**
   * Formatea los datos como texto legible para incluir en el contexto del agente.
   */
  formatForAgent(data: ExternalClientDataRecord): string;
}
