export interface IntentionItem {
    name: string;
    tipo: 'flujo' | 'seguimiento' | 'notificacion';
    frase: string; // frase representativa o pregunta que activa esta intención
    umbral: number; 
}
export interface Decision {
    type: string;
    name: string;
    tipo: string;
}
export interface ToolHandler {
    name: string;
    handle(args: any): Promise<string>;
}

export interface proccessInput {
    input: string,
    userId: string,
    apikeyOpenAi: string,
    sessionId: string,
    server_url: string,
    apikey: string,
    instanceName: string,
    remoteJid: string,
}