// Réplica mínima (solo data) de lib/contact-fields.ts del frontend, para que el
// nodo de flujo "Guardar ficha + Sheets" capture/sincronice exactamente los
// mismos campos que la ficha de contacto configurada por la cuenta.

export type BackendContactField = {
  key: string;
  label: string;
  enabled: boolean;
  order: number;
};

// Los 14 campos base (deben coincidir con DEFAULT_CONTACT_FIELDS del frontend).
export const DEFAULT_CONTACT_FIELDS: BackendContactField[] = [
  { key: 'empresa', label: 'Empresa', enabled: true, order: 0 },
  { key: 'cargo', label: 'Cargo', enabled: true, order: 1 },
  { key: 'documento', label: 'Documento', enabled: true, order: 2 },
  { key: 'telefono', label: 'Teléfono', enabled: true, order: 3 },
  { key: 'email', label: 'Email', enabled: true, order: 4 },
  { key: 'fecha', label: 'Fecha', enabled: true, order: 5 },
  { key: 'pais', label: 'País', enabled: true, order: 6 },
  { key: 'ciudad', label: 'Ciudad', enabled: true, order: 7 },
  { key: 'direccion', label: 'Dirección', enabled: true, order: 8 },
  { key: 'sitioWeb', label: 'Sitio web', enabled: true, order: 9 },
  { key: 'instagram', label: 'Instagram', enabled: true, order: 10 },
  { key: 'facebook', label: 'Facebook', enabled: true, order: 11 },
  { key: 'linkedin', label: 'LinkedIn', enabled: true, order: 12 },
  { key: 'notas', label: 'Notas', enabled: true, order: 13 },
];

// Normaliza la config arbitraria de la BD a BackendContactField[].
// Si no es válida o queda vacía, devuelve los defaults.
export function normalizeContactFieldsConfig(raw: unknown): BackendContactField[] {
  if (!Array.isArray(raw)) return DEFAULT_CONTACT_FIELDS;

  const seen = new Set<string>();
  const cleaned: BackendContactField[] = [];

  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const f = item as Record<string, unknown>;
    const key = typeof f.key === 'string' ? f.key.trim() : '';
    const label = typeof f.label === 'string' ? f.label.trim() : '';
    if (!key || !label || seen.has(key)) return;
    seen.add(key);
    cleaned.push({
      key,
      label,
      enabled: f.enabled !== false,
      order: typeof f.order === 'number' ? f.order : i,
    });
  });

  return cleaned.length ? cleaned : DEFAULT_CONTACT_FIELDS;
}
