// src/common/helpers/convert-delay-to-seconds.helper.ts
export const unitToSeconds = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
};

/**
 * Convierte un delay con formato "unidad-valor" (ej. "minutes-5") a una
 * fecha futura expresada en ISO 8601 UTC (ej. "2026-05-15T17:30:00.000Z").
 *
 * Guardar en UTC garantiza que el sistema funcione correctamente para
 * usuarios en cualquier país, sin depender del timezone del servidor.
 *
 * @param delay Formato como "minutes-5", "hours-2", "days-1"
 * @returns ISO 8601 UTC string de la fecha futura
 * @throws Error si el formato es inválido
 */
export function convertDelayToSeconds(delay: string): string {
  if (!delay) {
    throw new Error('El parámetro delay es requerido.');
  }

  const [unit, valueStr] = delay.split('-');
  const value = parseInt(valueStr, 10);

  if (!['seconds', 'minutes', 'hours', 'days'].includes(unit) || isNaN(value)) {
    throw new Error(`Formato de delay inválido: ${delay}`);
  }

  const seconds = value * unitToSeconds[unit];
  return new Date(Date.now() + seconds * 1000).toISOString();
}
