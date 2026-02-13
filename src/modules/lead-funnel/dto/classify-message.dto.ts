export class ClassifyMessageDto {
    userId!: string;
    instanceId!: string;
    remoteJid!: string;
    pushName?: string;

    // id autoincrement real de Session
    sessionDbId!: number;

    // texto entrante (ya merged del buffer)
    text!: string;

    // historial resumido (últimos N mensajes) para contexto IA
    history?: string[];
}
