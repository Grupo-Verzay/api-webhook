// agentId del entrenamiento (AgentPrompt) por canal. Cada canal puede tener su
// PROPIO entrenamiento; WhatsApp QR usa el base 'system-prompt-ai' (igual que
// CRM_AGENT_PROMPT_IDS.systemPrompAI) para retro-compatibilidad. Si un canal no
// tiene entrenamiento propio, el resolutor cae al base (WhatsApp QR).
export const CHANNEL_AGENT_IDS = {
  whatsapp_qr: 'system-prompt-ai',
  whatsapp_cloud: 'system-prompt-ai-whatsapp-cloud',
  facebook: 'system-prompt-ai-facebook',
  instagram: 'system-prompt-ai-instagram',
  telegram: 'system-prompt-ai-telegram',
} as const;

export type ChannelKey = keyof typeof CHANNEL_AGENT_IDS;

export const BASE_CHANNEL_AGENT_ID = CHANNEL_AGENT_IDS.whatsapp_qr;

// Resuelve la clave de canal a partir del tipo de instancia y el canal de Meta.
// meta + metaChannel(facebook/instagram) → red social; meta + whatsapp → Cloud;
// telegram → telegram; cualquier otro (Whatsapp/evolution/baileys) → WhatsApp QR.
export function resolveChannelKey(
  instanceType?: string | null,
  metaChannel?: string | null,
): ChannelKey {
  const type = (instanceType || '').toLowerCase();
  if (type === 'telegram') return 'telegram';
  if (type === 'meta') {
    const mc = (metaChannel || 'whatsapp').toLowerCase();
    if (mc === 'facebook') return 'facebook';
    if (mc === 'instagram') return 'instagram';
    return 'whatsapp_cloud';
  }
  return 'whatsapp_qr';
}
