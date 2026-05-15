// src/common/helpers/convert-delay-to-seconds.helper.ts
export const unitToSeconds = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
};

/**
 * Convierte un delay con formato "unidad-valor" (ej. "minutes-5") a una fecha
 * formateada en la zona horaria indicada (por defecto Colombia UTC-5).
 *
 * @param delay Formato como "minutes-5", "hours-2", "days-1"
 * @param timezoneOffset Offset IANA-style, ej. "-05:00" (default Colombia)
 * @returns Fecha futura en formato "dd/MM/yyyy HH:mm" en la zona horaria indicada
 * @throws Error si el formato es inválido
 */
export function convertDelayToSeconds(delay: string, timezoneOffset = '-05:00'): string {
  if (!delay) {
    throw new Error('El parámetro delay es requerido.');
  }

  const [unit, valueStr] = delay.split('-');
  const value = parseInt(valueStr, 10);

  if (!['seconds', 'minutes', 'hours', 'days'].includes(unit) || isNaN(value)) {
    throw new Error(`Formato de delay inválido: ${delay}`);
  }

  const seconds = value * unitToSeconds[unit];
  const futureDate = new Date(Date.now() + seconds * 1000);

  // Convertir UTC a la zona horaria configurada usando el offset
  const offsetMatch = timezoneOffset.match(/^([+-])(\d{2}):(\d{2})$/);
  const offsetMinutes = offsetMatch
    ? (offsetMatch[1] === '+' ? 1 : -1) * (parseInt(offsetMatch[2], 10) * 60 + parseInt(offsetMatch[3], 10))
    : -300; // fallback UTC-5

  const localDate = new Date(futureDate.getTime() + offsetMinutes * 60 * 1000);

  const day = String(localDate.getUTCDate()).padStart(2, '0');
  const month = String(localDate.getUTCMonth() + 1).padStart(2, '0');
  const year = localDate.getUTCFullYear();
  const hours = String(localDate.getUTCHours()).padStart(2, '0');
  const minutes = String(localDate.getUTCMinutes()).padStart(2, '0');

  return `${day}/${month}/${year} ${hours}:${minutes}`;
}
