export type ProviderId = "openai" | "google";

export interface FormatValidation {
  provider: ProviderId;
  isFormatValid: boolean;
  message?: string;
}

const REGEX = {
  // OpenAI suele emitir claves que empiezan por "sk-" y luego base62/URL-safe.
  // Usamos una regla amplia para no romper con variantes nuevas (sk-live-, sk-proj-, etc.)
  openai: /^sk-[A-Za-z0-9_-]{20,200}$/,

  // Google (Gemini/AI Studio) usa el clásico formato de API key que empieza en "AIza"
  // y tiene 39 caracteres en total (4 + 35).
  google: /^AIza[0-9A-Za-z-_]{35}$/,
} as const;

export function validateApiKeyFormat(
  provider: ProviderId,
  rawKey: string
): FormatValidation {
  const apiKey = (rawKey ?? "").trim();

  if (!apiKey) {
    return { provider, isFormatValid: false, message: "API key vacía" };
  }

  // Evitar espacios internos o saltos de línea
  if (/\s/.test(apiKey)) {
    return {
      provider,
      isFormatValid: false,
      message: "La API key contiene espacios o saltos de línea",
    };
  }

  // Limitar tamaños absurdos para prevenir input basura
  if (apiKey.length < 20 || apiKey.length > 256) {
    return {
      provider,
      isFormatValid: false,
      message: `Longitud fuera de rango (${apiKey.length})`,
    };
  }

  const pattern = REGEX[provider];
  const ok = pattern.test(apiKey);

  return {
    provider,
    isFormatValid: ok,
    message: ok ? "Formato válido" : "Formato inválido para el proveedor",
  };
}