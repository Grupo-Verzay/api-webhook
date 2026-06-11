import { Pausar, Prisma, User } from '@prisma/client';
// import { ChatCompletionMessageToolCall } from "openai/resources/chat";
import { ChatCompletionMessageToolCall } from 'openai/resources/index.mjs';

const whatsappCreditsMsg = 'https://w.app/verzay';

export type UserWithPausar = Prisma.UserGetPayload<{
  include: { pausar: true };
}>;

export type DefaultAiConfig = {
  userId: string;
  defaultProvider?: { id: string; name: string } | null;
  defaultModel?: { id: string; name: string } | null;
  defaultApiKey: string | null;
};
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
  input: string;
  userId: string;
  apikeyOpenAi: string;
  sessionId: string;
  server_url: string;
  apikey: string;
  instanceName: string;
  remoteJid: string;
  pushName?: string;
  defaultModel: string;
  defaultProvider: string;
}

export interface inputWorkflow {
  nombre_flujo: { type: string; description: string };
  detalles: { type: string; description: string };
}

export interface openAIToolDetection {
  input: inputWorkflow;
  sessionId: string;
  userId: string;
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
  conversationMsg: string;
  remoteJid: string;
  remoteJidAlt?: string; // 👈 NUEVO
  instanceId: string;
  sessionStatus: boolean;
  userWithRelations: UserWithPausar;
  instanceName: string;
  apikey: string;
  server_url: string;
}

export interface getReactivateDate {
  userWithRelations: UserWithPausar;
}

export interface onAutoRepliesInterface {
  userId: string;
  conversationMsg: string;
  server_url: string;
  apikey: string;
  instanceName: string;
  instanceId: string;
  remoteJid: string;
}

export interface CreditFlag {
  pct: number;
  message: (ctx: { available: number; total: number }) => string;
}

export interface CreditValidationInput {
  userId: string;
  flags: CreditFlag[];
  webhookUrl: string;
  apiUrl: string;
  apikey: string;
  userPhone: string;
}

export const creditFlags: CreditFlag[] = [
  {
    pct: 50,
    message: ({ available, total }) =>
      `🔔 Aviso: te quedan *${available} de ${total} créditos* (50% disponible). Aún tienes tiempo para recargar.\n\n👉 ${whatsappCreditsMsg}`,
  },
  {
    pct: 25,
    message: ({ available, total }) =>
      `⚠️ Atención: solo te quedan *${available} de ${total} créditos* (25% disponible). Te recomendamos recargar pronto.\n\n👉 ${whatsappCreditsMsg}`,
  },
  {
    pct: 5,
    message: ({ available, total }) =>
      `🚨 URGENTE: solo tienes *${available} de ${total} créditos* disponibles (5%). Recarga ya para no interrumpir tu servicio.\n\n👉 ${whatsappCreditsMsg}`,
  },
  {
    pct: 0,
    message: ({ total }) =>
      `🛑 CRÍTICO: ¡Te has quedado *SIN CRÉDITOS*!\n\n• Consumiste los *${total} créditos* de tu plan\n• Tu servicio está *SUSPENDIDO*\n• No podrás recibir mensajes de clientes\n\n🔴 *RECARGA URGENTE* para reactivar tu agente:\n${whatsappCreditsMsg}`,
  },
];
