import {
  normalizeWhatsAppConversationJid,
  pickExplicitWhatsAppPhoneJid,
  pickPreferredWhatsAppRemoteJid,
} from 'src/utils/whatsapp-jid.util';

export function buildChatHistorySessionId(instanceName: string, remoteJid: string) {
  const safeInstanceName = (instanceName ?? '').trim();
  const safeRemoteJid = (remoteJid ?? '').trim();
  const normalizedRemoteJid =
    pickExplicitWhatsAppPhoneJid([safeRemoteJid]) ||
    pickPreferredWhatsAppRemoteJid([safeRemoteJid]) ||
    normalizeWhatsAppConversationJid(safeRemoteJid) ||
    safeRemoteJid;

  return `${safeInstanceName}-${normalizedRemoteJid}`;
}
