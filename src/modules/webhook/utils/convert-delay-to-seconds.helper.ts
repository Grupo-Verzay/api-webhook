// src/common/helpers/convert-delay-to-seconds.helper.ts
export const unitToSeconds = {
    seconds: 1,
    minutes: 60,
    hours: 3600,
    days: 86400,
};

/**
 * Convierte un delay con formato "unidad-valor" (ej. "minutes-5") a segundos.
 *
 * @param delay Formato como "minutes-5", "hours-2", "days-1"
 * @returns Fecha con la suma del tiempo
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

    //  #1: Darle el formato DD/MM/YYYY HH:MM
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0'); // ¡Importante! Enero es 0
    const year = now.getFullYear();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    const formattedNow = `${day}/${month}/${year} ${hours}:${minutes}`;

    //  #2: Sumar segundos a la fecha actual
    const futureDate = new Date(now.getTime() + seconds * 1000);

    const futureDay = String(futureDate.getDate()).padStart(2, '0');
    const futureMonth = String(futureDate.getMonth() + 1).padStart(2, '0');
    const futureYear = futureDate.getFullYear();
    const futureHours = String(futureDate.getHours()).padStart(2, '0');
    const futureMinutes = String(futureDate.getMinutes()).padStart(2, '0');

    const formattedFuture = `${futureDay}/${futureMonth}/${futureYear} ${futureHours}:${futureMinutes}`;

    return formattedFuture;
}
