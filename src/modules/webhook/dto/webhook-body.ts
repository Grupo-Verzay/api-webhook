export class WebhookBodyDto {
    event: string;
    instance: string;
    apikey: string;
    server_url: string;
    date_time: string;
    destination: string;
    sender: string;
    data: WebhookDataDto;
  }
  
export class WebhookDataDto {
  key: {
      remoteJid: string;
      remoteJidAlt?:string;
      fromMe: boolean;
      id: string;
      senderLid?: string; // Add this field, as it is present in the object but not the original type
      senderPn?: string;
  };
  pushName: string;
  senderPn?: string;
  status: string;
    message?: {
        conversation?: string;
        mediaUrl?: string;
        imageMessage?: {
            url: string;
            mimetype: string;
            fileSha256: string;
            fileLength: string;
            height: number;
            width: number;
            mediaKey: string;
            fileEncSha256: string;
            directPath: string;
            mediaKeyTimestamp: string;
            jpegThumbnail: string;
            contextInfo: {
                disappearingMode: {
                    initiator: string;
                };
            };
            viewOnce: boolean;
        };
        audioMessage?: {
            url: string;
            mimetype: string;
            fileSha256: string;
            fileLength: string;
            seconds: number;
            ptt: boolean;
            mediaKey: string;
            fileEncSha256: string;
            directPath: string;
            mediaKeyTimestamp: string;
            waveform: string;
        };
        messageContextInfo?: any;
        base64?: string;
    };
    contextInfo?: any;
    messageType: string;
    messageTimestamp: number;
    instanceId: string;
    source: string;
}
