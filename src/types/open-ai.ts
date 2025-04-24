export interface IntentionItem {
    name: string;
    tipo: 'flujo' | 'seguimiento' | 'notificacion';
    frase: string; // frase representativa o pregunta que activa esta intención
}
export interface Decision {
    type: string;
    name: string;
    tipo: string;
}
