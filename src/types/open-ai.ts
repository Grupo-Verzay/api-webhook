import { Pausar, User } from "@prisma/client";
import { ChatCompletionMessageToolCall } from "openai/resources/chat";

const whatsappCreditsMsg = 'https://w.app/verzay';
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

export interface inputWorkflow {
    nombre_flujo: { type: string, description: string }
    detalles: { type: string, description: string }
}

export interface openAIToolDetection {
    input: inputWorkflow,
    sessionId: string,
    userId: string,

}

export interface ChoiceWithToolCall {
    message: {
        content?: string;
        tool_calls?: ChatCompletionMessageToolCall[];
    };
}

export interface ChoiceWithToolCall {
    message: {
        content?: string;
        tool_calls?: ChatCompletionMessageToolCall[];
    };
}
export interface OpenAIDetectionResult {
    // choice: ChoiceWithToolCall | null;
    // toolCall: ChatCompletionMessageToolCall | null;
    content: string | null;
}

export interface stopOrResumeConversation {
    conversationMsg: string,
    remoteJid: string,
    instanceId: string,
    sessionStatus: boolean,
    userWithRelations: User & { pausar: Pausar[] },
    instanceName: string,
    apikey: string,
    server_url: string
};


export interface getReactivateDate {
    userWithRelations: User & { pausar: Pausar[] },
};

export interface onAutoRepliesInterface {
    userId: string
    conversationMsg: string
    server_url: string
    apikey: string
    instanceName: string
    remoteJid: string
};

export interface CreditFlag {
    value: number; // valor en créditos requeridos
    message: string; // mensaje a mostrar si se activa esta flag
};

export interface CreditValidationInput {
    userId: string;
    flags: { value: number; message: string }[];
    webhookUrl: string;
    apiUrl: string,
    apikey: string,
    userPhone: string,
};

export const flags = [
    {
        value: 0,
        message: `🛑 CRÍTICO: ¡Te has quedado *SIN CRÉDITOS*! \n\n• Tu servicio está *SUSPENDIDO* \n• No podrás recibir mensajes \n• Perderás números asociados \n\n🔴 *RECARGA URGENTE* para reactivar: ${whatsappCreditsMsg}`,
    },
    {
        value: 500,
        message: "🚨 Tienes menos de *500 créditos* disponibles. Tu cuenta podría ser pausada pronto. Considera recargar urgentemente.",
    },
    {
        value: 1000,
        message: "⚠️ Estás por debajo de *1000 créditos*. Te recomendamos recargar antes de que se agoten.",
    },
    {
        value: 2000,
        message: "🔔 Aviso: tienes menos de *2000 créditos* disponibles. Aún estás a tiempo de recargar.",
    },
];