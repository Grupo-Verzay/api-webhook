const SMALL_NUMBERS: Record<number, string> = {
  0: 'cero',
  1: 'uno',
  2: 'dos',
  3: 'tres',
  4: 'cuatro',
  5: 'cinco',
  6: 'seis',
  7: 'siete',
  8: 'ocho',
  9: 'nueve',
  10: 'diez',
  11: 'once',
  12: 'doce',
  13: 'trece',
  14: 'catorce',
  15: 'quince',
  16: 'dieciseis',
  17: 'diecisiete',
  18: 'dieciocho',
  19: 'diecinueve',
  20: 'veinte',
  21: 'veintiuno',
  22: 'veintidos',
  23: 'veintitres',
  24: 'veinticuatro',
  25: 'veinticinco',
  26: 'veintiseis',
  27: 'veintisiete',
  28: 'veintiocho',
  29: 'veintinueve',
  30: 'treinta',
  40: 'cuarenta',
  50: 'cincuenta',
  60: 'sesenta',
};

const DIGIT_WORDS: Record<string, string> = {
  '0': 'cero',
  '1': 'uno',
  '2': 'dos',
  '3': 'tres',
  '4': 'cuatro',
  '5': 'cinco',
  '6': 'seis',
  '7': 'siete',
  '8': 'ocho',
  '9': 'nueve',
};

function numberToSpanish(value: number): string {
  if (SMALL_NUMBERS[value]) return SMALL_NUMBERS[value];

  if (value > 30 && value < 100) {
    const tens = Math.floor(value / 10) * 10;
    const units = value % 10;
    return units === 0 ? SMALL_NUMBERS[tens] : `${SMALL_NUMBERS[tens]} y ${SMALL_NUMBERS[units]}`;
  }

  return String(value);
}

function spellDigits(value: string): string {
  return value
    .split('')
    .map((digit) => DIGIT_WORDS[digit] ?? digit)
    .join(', ');
}

function normalizePhoneLikeNumbers(text: string): string {
  return text.replace(/(?:\+\d{1,3}[\s.-]*)?(?:\d[\s.-]*){7,15}/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 7) return match;
    const prefix = match.trim().startsWith('+') ? 'mas, ' : '';
    const suffix = /\s$/.test(match) ? ' ' : '';
    return `${prefix}${spellDigits(digits)}${suffix}`;
  });
}

export function normalizeTextForTts(text: string): string {
  let t = text;

  t = t
    .replace(/\{\{([^}]+)\}\}/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/https?:\/\/(?:www\.)?([^\s/]+)(?:\/[^\s]*)?/gi, (_match, domain: string) =>
      String(domain).replace(/\./g, ' punto '),
    )
    .replace(/\b(?:uds|ud?s\.?)\b/gi, (match) => {
      const clean = match.toLowerCase().replace(/\./g, '');
      return clean === 'ud' ? 'usted' : 'ustedes';
    })
    .replace(/\b(min|mins)\b/gi, 'minutos')
    .replace(/\bseg\b/gi, 'segundos')
    .replace(/\b(?:usd|us\$|u\.s\.d\.|dolares|dólares)\s*(\d{1,4})\b/gi, (_match, amount: string) => {
      const value = Number(amount);
      return `${Number.isFinite(value) ? numberToSpanish(value) : amount} dolares`;
    })
    .replace(/\b(\d{1,4})\s*(?:usd|us\$|u\.s\.d\.|dolares|dólares)\b/gi, (_match, amount: string) => {
      const value = Number(amount);
      return `${Number.isFinite(value) ? numberToSpanish(value) : amount} dolares`;
    });

  t = normalizePhoneLikeNumbers(t);

  t = t.replace(/\b(\d{1,2})\s*(minutos?|segundos?|horas?|dias?|días?)\b/gi, (_match, amount: string, unit: string) => {
    const spokenAmount = numberToSpanish(Number(amount));
    return `${spokenAmount} ${unit.toLowerCase()}`;
  });

  t = t.replace(/\b(\d{1,2})\s*(am|pm)\b/gi, (_match, hour: string, period: string) => {
    const spokenHour = numberToSpanish(Number(hour));
    return `${spokenHour} ${period.toLowerCase() === 'am' ? 'de la manana' : 'de la tarde'}`;
  });

  t = t
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return t;
}
