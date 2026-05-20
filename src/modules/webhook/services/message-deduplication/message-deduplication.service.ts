import { Injectable } from '@nestjs/common';

@Injectable()
export class MessageDeduplicationService {
  private readonly processedMsgIds = new Map<string, number>();
  private readonly outgoingResponseCache = new Map<
    string,
    { hash: string; ts: number }
  >();
  private static readonly OUTGOING_DEDUPE_TTL_MS = 10 * 60_000;

  private simpleHash(text: string): string {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  isDuplicateMessage(key: string, ttlMs = 120000): boolean {
    const now = Date.now();
    for (const [k, ts] of this.processedMsgIds.entries()) {
      if (now - ts > ttlMs) this.processedMsgIds.delete(k);
    }
    const last = this.processedMsgIds.get(key);
    if (last && now - last < ttlMs) return true;
    this.processedMsgIds.set(key, now);
    return false;
  }

  isDuplicateOutgoingResponse(
    instanceName: string,
    remoteJid: string,
    responseText: string,
  ): boolean {
    const key = `${instanceName}:${remoteJid}`;
    const hash = this.simpleHash(responseText.trim());
    const now = Date.now();
    const ttl = MessageDeduplicationService.OUTGOING_DEDUPE_TTL_MS;

    for (const [k, v] of this.outgoingResponseCache.entries()) {
      if (now - v.ts > ttl) this.outgoingResponseCache.delete(k);
    }

    const cached = this.outgoingResponseCache.get(key);
    if (cached && cached.hash === hash && now - cached.ts < ttl) return true;

    this.outgoingResponseCache.set(key, { hash, ts: now });
    return false;
  }

  getMessageId(data: any): string {
    return (
      data?.key?.id ??
      data?.key?.msgId ??
      data?.messageId ??
      data?.message?.messageId ??
      ''
    );
  }
}
