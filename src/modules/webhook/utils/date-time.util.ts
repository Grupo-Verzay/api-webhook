export function getCurrentDateTime(): string {
    const date = new Date();
    const options = { timeZone: 'America/Bogota', hour12: false };
    return date.toLocaleString('es-CO', options);
  }
  