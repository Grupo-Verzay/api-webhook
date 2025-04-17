export function parseRemoteJid(remoteJid?: string): string {
    return (remoteJid || '').replace('@s.whatsapp.net', '');
  }
  