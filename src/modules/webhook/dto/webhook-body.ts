export class WebhookBodyDto {
    instance: string;
    apikey: string;
    server_url: string;
    date_time: string;
    data?: {
        key?: {
            remoteJid?: string;
            fromMe?: boolean;
            id?: string;
        };
        message?: {
            conversation?: string;
            mediaUrl?: string;
        };
        messageType?: string;
        source?: string;
        pushName?: string;
    };
}
