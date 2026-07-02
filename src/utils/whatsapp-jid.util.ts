const WHATSAPP_USER_JID_SUFFIX = '@s.whatsapp.net';
const WHATSAPP_LID_JID_SUFFIX = '@lid';
const WHATSAPP_GROUP_JID_SUFFIX = '@g.us';
const WHATSAPP_BROADCAST_JID_SUFFIX = '@broadcast';
const WHATSAPP_NEWSLETTER_JID_SUFFIX = '@newsletter';
const STATUS_BROADCAST_JID = 'status@broadcast';
// Mínimo de dígitos para considerar un JID como un número/contacto válido.
// Evita registrar leads basura como "0" → que la tabla mostraba como "+0".
const MIN_CONTACT_DIGITS = 6;

function cleanValue(value?: string | null) {
  return value?.trim() ?? '';
}

function isStatusBroadcastJid(value?: string | null) {
  return cleanValue(value).toLowerCase() === STATUS_BROADCAST_JID;
}

function isGroupJid(value?: string | null) {
  return cleanValue(value).toLowerCase().endsWith(WHATSAPP_GROUP_JID_SUFFIX);
}

function isBroadcastJid(value?: string | null) {
  return cleanValue(value)
    .toLowerCase()
    .endsWith(WHATSAPP_BROADCAST_JID_SUFFIX);
}

function isNewsletterJid(value?: string | null) {
  return cleanValue(value)
    .toLowerCase()
    .endsWith(WHATSAPP_NEWSLETTER_JID_SUFFIX);
}

/**
 * JID con esquema "LID" de WhatsApp (`@lid`): identificador de PRIVACIDAD, NO es
 * un número de teléfono. Sus dígitos parecen un número (15+), pero no lo son.
 * Un `@lid` por sí solo no es un contacto registrable; el teléfono real (cuando
 * WhatsApp lo entrega) viene en otro campo (senderPn/remoteJidAlt @s.whatsapp.net).
 */
export function isLidJid(value?: string | null) {
  return cleanValue(value).toLowerCase().endsWith(WHATSAPP_LID_JID_SUFFIX);
}

/**
 * Determina si un JID corresponde a un contacto real 1:1 que debe registrarse
 * como lead. Descarta vacíos, grupos, difusiones/estados, newsletters y JIDs
 * sin un número válido (que producían "leads basura" como "+0" o "Você").
 */
export function isRegisterableContactJid(value?: string | null): boolean {
  const raw = cleanValue(value);
  if (!raw) {
    return false;
  }

  if (
    isStatusBroadcastJid(raw) ||
    isGroupJid(raw) ||
    isBroadcastJid(raw) ||
    isNewsletterJid(raw) ||
    // Un @lid NO es un teléfono real: si el JID quedó como @lid es porque no se
    // pudo resolver el número (sus dígitos son un ID de privacidad, no un tel).
    // Evita crear "sesiones fantasma" sin teléfono (mostradas como "Você").
    isLidJid(raw)
  ) {
    return false;
  }

  return raw.replace(/[^\d]/g, '').length >= MIN_CONTACT_DIGITS;
}

export function extractWhatsAppDigits(value?: string | null) {
  const raw = cleanValue(value);

  if (!raw || isGroupJid(raw) || isBroadcastJid(raw)) {
    return '';
  }

  return raw.replace(/[^\d]/g, '');
}

export function normalizeWhatsAppConversationJid(value: string) {
  const raw = cleanValue(value);

  if (!raw) {
    return '';
  }

  if (isStatusBroadcastJid(raw) || isGroupJid(raw) || isBroadcastJid(raw)) {
    return raw;
  }

  if (raw.includes('@')) {
    return raw;
  }

  const digits = extractWhatsAppDigits(raw);
  if (!digits) {
    return raw;
  }

  return `${digits}${WHATSAPP_USER_JID_SUFFIX}`;
}

export function pickExplicitWhatsAppPhoneJid(
  values: Array<string | null | undefined>,
) {
  const cleanedValues = values
    .map((value) => cleanValue(value))
    .filter(Boolean);

  const explicitUserJid = cleanedValues.find((value) =>
    value.toLowerCase().endsWith(WHATSAPP_USER_JID_SUFFIX),
  );
  if (explicitUserJid) {
    return explicitUserJid;
  }

  const digitsOnlyValue = cleanedValues.find(
    (value) => !value.includes('@') && extractWhatsAppDigits(value),
  );
  if (digitsOnlyValue) {
    const digits = extractWhatsAppDigits(digitsOnlyValue);
    if (digits) {
      return `${digits}${WHATSAPP_USER_JID_SUFFIX}`;
    }
  }

  return '';
}

export function pickPreferredWhatsAppRemoteJid(
  values: Array<string | null | undefined>,
) {
  const cleanedValues = values
    .map((value) => cleanValue(value))
    .filter(Boolean);

  const directGroupOrBroadcast = cleanedValues.find(
    (value) =>
      isStatusBroadcastJid(value) || isGroupJid(value) || isBroadcastJid(value),
  );
  if (directGroupOrBroadcast) {
    return directGroupOrBroadcast;
  }

  const explicitUserJid = pickExplicitWhatsAppPhoneJid(cleanedValues);
  if (explicitUserJid) {
    return explicitUserJid;
  }

  const normalizedIndividual = cleanedValues
    .map((value) => normalizeWhatsAppConversationJid(value))
    .find((value) => value.endsWith(WHATSAPP_USER_JID_SUFFIX));
  if (normalizedIndividual) {
    return normalizedIndividual;
  }

  const withSuffix = cleanedValues.find((value) => value.includes('@'));
  if (withSuffix) {
    return withSuffix;
  }

  return cleanedValues[0] ?? '';
}

export function pickObservedAlternateRemoteJid(
  preferredRemoteJid: string,
  values: Array<string | null | undefined>,
) {
  const preferred = cleanValue(preferredRemoteJid);
  const seen = new Set<string>();

  for (const value of values) {
    const raw = cleanValue(value);
    if (!raw || raw === preferred || seen.has(raw) || !raw.includes('@')) {
      continue;
    }

    seen.add(raw);
    return raw;
  }

  return null;
}

export function buildWhatsAppJidCandidates(
  value: string,
  extraValues: Array<string | null | undefined> = [],
) {
  const candidates = new Set<string>();

  const addValue = (input?: string | null) => {
    const raw = cleanValue(input);
    if (!raw) {
      return;
    }

    candidates.add(raw);

    if (isStatusBroadcastJid(raw) || isGroupJid(raw) || isBroadcastJid(raw)) {
      return;
    }

    const canonical = normalizeWhatsAppConversationJid(raw);
    if (canonical) {
      candidates.add(canonical);
    }

    const digits = extractWhatsAppDigits(raw);
    if (!digits) {
      return;
    }

    candidates.add(digits);
    candidates.add(`${digits}${WHATSAPP_USER_JID_SUFFIX}`);
    candidates.add(`${digits}${WHATSAPP_LID_JID_SUFFIX}`);
  };

  addValue(value);
  for (const extraValue of extraValues) {
    addValue(extraValue);
  }

  return Array.from(candidates);
}
