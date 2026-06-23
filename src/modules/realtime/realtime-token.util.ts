import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Token HMAC-SHA256 simple (sin dependencias externas) para autenticar el
 * handshake del WebSocket. La app Next.js lo firma con el mismo secreto
 * (REALTIME_JWT_SECRET) y aquí solo lo verificamos.
 *
 * Formato: base64url(payloadJSON).base64url(hmac)
 */

export type RealtimeTokenPayload = {
  userIds: string[];
  exp: number;
  [key: string]: unknown;
};

export function verifyRealtimeToken(
  token: string,
  secret: string,
): RealtimeTokenPayload | null {
  if (!token || !secret) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  if (!data || !sig) return null;

  const expected = createHmac('sha256', secret).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(data, 'base64url').toString('utf8'),
    ) as RealtimeTokenPayload;

    if (
      typeof payload.exp !== 'number' ||
      payload.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    if (!Array.isArray(payload.userIds) || payload.userIds.length === 0) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
