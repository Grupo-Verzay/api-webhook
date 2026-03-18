const WHATSAPP_USER_JID_SUFFIX = '@s.whatsapp.net';
const WHATSAPP_LID_JID_SUFFIX = '@lid';
const WHATSAPP_GROUP_JID_SUFFIX = '@g.us';
const WHATSAPP_BROADCAST_JID_SUFFIX = '@broadcast';
const STATUS_BROADCAST_JID = 'status@broadcast';

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
  return cleanValue(value).toLowerCase().endsWith(WHATSAPP_BROADCAST_JID_SUFFIX);
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

export function pickExplicitWhatsAppPhoneJid(values: Array<string | null | undefined>) {
  const cleanedValues = values.map((value) => cleanValue(value)).filter(Boolean);

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

export function pickPreferredWhatsAppRemoteJid(values: Array<string | null | undefined>) {
  const cleanedValues = values.map((value) => cleanValue(value)).filter(Boolean);

  const directGroupOrBroadcast = cleanedValues.find(
    (value) => isStatusBroadcastJid(value) || isGroupJid(value) || isBroadcastJid(value),
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
