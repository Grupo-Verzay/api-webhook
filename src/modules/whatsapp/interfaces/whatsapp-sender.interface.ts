export interface IWhatsAppSender {
  sendText(instanceName: string, remoteJid: string, text: string, serverUrl?: string, apikey?: string): Promise<boolean>;
  sendMedia(instanceName: string, remoteJid: string, type: string, caption: string, mediaUrl: string, serverUrl?: string, apikey?: string): Promise<boolean>;
  sendAudio(instanceName: string, remoteJid: string, audioUrl: string, serverUrl?: string, apikey?: string): Promise<boolean>;
}
