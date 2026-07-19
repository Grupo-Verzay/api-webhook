import { Injectable } from '@nestjs/common';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { ChatHistoryService } from '../../chat-history/chat-history.service';
import { LlmClientFactory } from '../services/llmClientFactory/llmClientFactory.service';
import { OWNER_AGENT_SYSTEM_PROMPT } from './owner-agent.prompt';

/**
 * Modo Dueño por WhatsApp — el "cerebro".
 *
 * Cuando el número que escribe es el del dueño de la cuenta, este servicio
 * atiende el mensaje con un agente ReAct separado (prompt admin + tools owner_*)
 * en vez del flujo normal de clientes. Las tools llaman a los endpoints
 * /api/owner/* de la app (verzay-app), que validan identidad, ejecutan y auditan.
 *
 * Está detrás del flag OWNER_MODE_ENABLED y totalmente aislado: si algo falla,
 * el llamador (AiAgentService.processInput) cae al flujo normal — nunca lo rompe.
 */
@Injectable()
export class OwnerAgentService {
  constructor(
    private readonly logger: LoggerService,
    private readonly prisma: PrismaService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly llmClientFactory: LlmClientFactory,
  ) {}

  private appUrl(): string {
    // NEXTJS_URL es la variable canónica del backend para alcanzar la app (verzay-app).
    return (process.env.NEXTJS_URL ?? '').replace(/\/+$/, '');
  }
  private secret(): string {
    return (process.env.OWNER_COMMANDS_KEY ?? '').trim();
  }
  private isEnabled(): boolean {
    return String(process.env.OWNER_MODE_ENABLED ?? '').trim().toLowerCase() === 'true';
  }

  private normalizePhone(v?: string | null): string {
    return (v ?? '').replace(/\D/g, '');
  }

  /** Coincidencia tolerante por sufijo (mismo criterio que la app). */
  private phonesMatch(a: string, b: string): boolean {
    if (a.length < 7 || b.length < 7) return false;
    if (a === b) return true;
    const n = Math.min(a.length, b.length, 10);
    return a.slice(-n) === b.slice(-n);
  }

  private phoneFromJid(remoteJid: string): string {
    return this.normalizePhone((remoteJid ?? '').split('@')[0]);
  }

  /**
   * ¿El mensaje entrante es del dueño de la cuenta? Requiere flag activo,
   * configuración presente y que el número coincida con el número del dueño
   * configurado (ownerModePhone; si está vacío, cae a notificationNumber).
   */
  async isOwnerMessage(userId: string, remoteJid: string): Promise<boolean> {
    if (!this.isEnabled() || !this.appUrl() || !this.secret()) return false;

    const fromDigits = this.phoneFromJid(remoteJid);
    if (fromDigits.length < 7) return false;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ownerModeEnabled: true, ownerModePhone: true, notificationNumber: true },
    });
    if (!user?.ownerModeEnabled) return false;

    const ownerDigits = this.normalizePhone(
      user?.ownerModePhone || user?.notificationNumber,
    );
    return this.phonesMatch(fromDigits, ownerDigits);
  }

  /**
   * Atiende el mensaje del dueño con el agente ReAct administrativo.
   * Construye su propio cliente LLM con la config del usuario y usa historyId
   * (string instancia-remoteJid) para la memoria de la conversación.
   */
  async handle(params: {
    userId: string;
    remoteJid: string;
    historyId: string;
    input: string;
    apiKey: string;
    model: string;
    provider: string;
  }): Promise<string> {
    const ownerPhone = this.phoneFromJid(params.remoteJid);
    const tools = this.buildOwnerTools({ userId: params.userId, ownerPhone });

    const client = this.llmClientFactory.getClient({
      provider: params.provider as any,
      apiKey: params.apiKey,
      model: params.model,
    });

    let historyMessages: any[] = [];
    try {
      const chatHistory = await this.chatHistoryService.getChatHistoryWithTypes(params.historyId);
      historyMessages = (chatHistory ?? []).map(({ content, type }: any) => {
        const isAi = type === 'ia' || type === 'ai';
        return isAi
          ? new AIMessage({ content: [{ type: 'text', text: content }] })
          : new HumanMessage({ content: [{ type: 'text', text: content }] });
      });
    } catch {
      historyMessages = [];
    }

    const messages = [
      new SystemMessage({ content: [{ type: 'text', text: OWNER_AGENT_SYSTEM_PROMPT }] }),
      ...historyMessages,
      new HumanMessage({ content: [{ type: 'text', text: params.input }] }),
    ];

    const agent = createReactAgent({ llm: client, tools });
    const result = await agent.invoke({ messages }, { recursionLimit: 20 });
    return this.extractText(result);
  }

  private extractText(result: any): string {
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    const last = messages[messages.length - 1];
    const content = last?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('').trim();
    }
    return '';
  }

  /** POST a un endpoint /api/owner/* con el secreto compartido. */
  private async callOwnerEndpoint(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${this.appUrl()}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.secret()}`,
      },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  private buildOwnerTools(ctx: { userId: string; ownerPhone: string }): any[] {
    const base = { userId: ctx.userId, ownerPhone: ctx.ownerPhone };
    const logger = this.logger;

    // Helper que construye una tool LangChain casteando los tipos, para evitar
    // los "tipos profundos" de LangChain + zod (mismo motivo por el que el resto
    // del servicio usa @ts-ignore en sus tools).
    const mk = (
      fn: (args: any) => Promise<string>,
      cfg: { name: string; description: string; schema: any },
    ): any => tool(fn as any, cfg as any);

    // Ejecuta una acción de escritura respetando la confirmación.
    const runWrite = async (
      endpoint: string,
      extra: Record<string, unknown>,
      confirmar: boolean | undefined,
      accion: string,
    ): Promise<string> => {
      if (confirmar !== true) {
        return `Antes de ejecutar "${accion}" necesito que el dueño confirme. Muéstrale exactamente qué se hará y pídele un "sí"; luego vuelve a llamar esta herramienta con confirmar: true.`;
      }
      const { status, json } = await this.callOwnerEndpoint(endpoint, { ...base, ...extra, confirmed: true });
      if (status >= 200 && status < 300) {
        return `OK: ${json?.message ?? 'acción completada'}. ${JSON.stringify(json ?? {})}`;
      }
      logger.warn(`[owner-tool] ${endpoint} → ${status}: ${json?.message ?? ''}`);
      return `No se pudo completar (${status}): ${json?.message ?? 'error'}.`;
    };

    const runRead = async (endpoint: string, extra: Record<string, unknown> = {}): Promise<string> => {
      const { status, json } = await this.callOwnerEndpoint(endpoint, { ...base, ...extra });
      if (status >= 200 && status < 300) return JSON.stringify(json ?? {});
      logger.warn(`[owner-tool] ${endpoint} → ${status}: ${json?.message ?? ''}`);
      return `No se pudo consultar (${status}): ${json?.message ?? 'error'}.`;
    };

    // ── Fase 1 ───────────────────────────────────────────────────────────────
    const resumenDia = mk(
      async () => runRead('/api/owner/summary'),
      {
        name: 'owner_resumen_dia',
        description:
          'Devuelve el resumen del día del dueño: tareas pendientes, tareas que vencen hoy y citas de hoy. Solo lectura.',
        schema: z.object({}),
      },
    );

    const crearTarea = mk(
      async ({ titulo, fecha_iso, tipo }: any) =>
        runWrite('/api/owner/task', { title: titulo, dueDate: fecha_iso, type: tipo }, true, 'crear tarea'),
      {
        name: 'owner_crear_tarea',
        description:
          'Crea una tarea para el dueño. La fecha debe ir en ISO 8601 (UTC). No requiere confirmación previa.',
        schema: z.object({
          titulo: z.string().describe('Qué hay que hacer'),
          fecha_iso: z.string().describe('Fecha/hora de vencimiento en ISO 8601 (UTC)'),
          tipo: z.string().optional().describe("Opcional. Por defecto 'Seguimiento'."),
        }),
      },
    );

    const crearRecordatorio = mk(
      async ({ titulo, fecha_iso }: any) =>
        runWrite('/api/owner/reminder', { title: titulo, dueDate: fecha_iso }, true, 'crear recordatorio'),
      {
        name: 'owner_crear_recordatorio',
        description:
          'Crea un recordatorio para el dueño. La fecha debe ir en ISO 8601 (UTC). No requiere confirmación previa.',
        schema: z.object({
          titulo: z.string().describe('Qué recordar'),
          fecha_iso: z.string().describe('Fecha/hora en ISO 8601 (UTC)'),
        }),
      },
    );

    // ── Fase 2 ───────────────────────────────────────────────────────────────
    const buscarContacto = mk(
      async ({ busqueda }: any) => runRead('/api/owner/contacts/search', { query: busqueda }),
      {
        name: 'owner_buscar_contacto',
        description:
          'Busca contactos del dueño por nombre o número. Úsala SIEMPRE antes de una acción sobre un contacto para obtener su sessionId. Solo lectura.',
        schema: z.object({ busqueda: z.string().describe('Nombre o número a buscar') }),
      },
    );

    const enviarMensaje = mk(
      async ({ sessionId, texto, confirmar }: any) =>
        runWrite('/api/owner/message', { sessionId, text: texto }, confirmar, 'enviar mensaje'),
      {
        name: 'owner_enviar_mensaje',
        description:
          'Envía un mensaje de WhatsApp a un contacto del dueño (sessionId de owner_buscar_contacto). REQUIERE confirmación del dueño: llama con confirmar:true solo tras un "sí".',
        schema: z.object({
          sessionId: z.number().int().describe('sessionId del contacto'),
          texto: z.string().describe('Mensaje a enviar'),
          confirmar: z.boolean().optional().describe('true solo cuando el dueño ya confirmó'),
        }),
      },
    );

    const moverLead = mk(
      async ({ sessionId, estado, confirmar }: any) =>
        runWrite('/api/owner/lead-status', { sessionId, status: estado }, confirmar, 'mover estado de lead'),
      {
        name: 'owner_mover_lead',
        description:
          'Cambia el estado de lead (kanban) de un contacto. REQUIERE confirmación: confirmar:true solo tras un "sí".',
        schema: z.object({
          sessionId: z.number().int().describe('sessionId del contacto'),
          estado: z
            .enum(['FRIO', 'TIBIO', 'CALIENTE', 'FINALIZADO', 'DESCARTADO'])
            .describe('Nuevo estado del lead'),
          confirmar: z.boolean().optional().describe('true solo cuando el dueño ya confirmó'),
        }),
      },
    );

    const etiquetarContacto = mk(
      async ({ sessionId, etiqueta, confirmar }: any) =>
        runWrite('/api/owner/tag', { sessionId, tag: etiqueta }, confirmar, 'etiquetar contacto'),
      {
        name: 'owner_etiquetar_contacto',
        description:
          'Aplica una etiqueta (por nombre) a un contacto; se crea si no existe. REQUIERE confirmación: confirmar:true solo tras un "sí".',
        schema: z.object({
          sessionId: z.number().int().describe('sessionId del contacto'),
          etiqueta: z.string().describe('Nombre de la etiqueta'),
          confirmar: z.boolean().optional().describe('true solo cuando el dueño ya confirmó'),
        }),
      },
    );

    const asignarAsesor = mk(
      async ({ sessionId, asesor, confirmar }: any) =>
        runWrite('/api/owner/assign', { sessionId, advisorName: asesor }, confirmar, 'asignar asesor'),
      {
        name: 'owner_asignar_asesor',
        description:
          'Asigna un contacto a un asesor de la cuenta (por nombre), o lo libera si el nombre es "ninguno". REQUIERE confirmación: confirmar:true solo tras un "sí".',
        schema: z.object({
          sessionId: z.number().int().describe('sessionId del contacto'),
          asesor: z.string().describe('Nombre del asesor, o "ninguno" para liberar'),
          confirmar: z.boolean().optional().describe('true solo cuando el dueño ya confirmó'),
        }),
      },
    );

    // ── Fase 3 (entrenamiento) ────────────────────────────────────────────────
    const verEntrenamiento = mk(
      async () => runRead('/api/owner/training/get'),
      {
        name: 'owner_ver_entrenamiento',
        description:
          'Muestra las instrucciones de entrenamiento actuales del agente de clientes. Solo lectura.',
        schema: z.object({}),
      },
    );

    const listarRevisiones = mk(
      async () => runRead('/api/owner/training/revisions'),
      {
        name: 'owner_listar_revisiones_entrenamiento',
        description:
          'Lista el historial de versiones del entrenamiento (para rollback). Solo lectura.',
        schema: z.object({}),
      },
    );

    const agregarInstruccion = mk(
      async ({ instruccion, titulo, confirmar }: any) =>
        runWrite(
          '/api/owner/training/instruction',
          { instruction: instruccion, title: titulo },
          confirmar,
          'agregar instrucción al entrenamiento',
        ),
      {
        name: 'owner_agregar_instruccion_entrenamiento',
        description:
          'Agrega una instrucción al entrenamiento del agente de clientes y la publica (solo agrega, no reescribe). REQUIERE confirmación: confirmar:true solo tras un "sí".',
        schema: z.object({
          instruccion: z.string().describe('La regla/comportamiento a agregar'),
          titulo: z.string().optional().describe('Opcional. Título corto de la instrucción.'),
          confirmar: z.boolean().optional().describe('true solo cuando el dueño ya confirmó'),
        }),
      },
    );

    const restaurarEntrenamiento = mk(
      async ({ numero_revision, confirmar }: any) =>
        runWrite(
          '/api/owner/training/restore',
          { revisionNumber: numero_revision },
          confirmar,
          'restaurar entrenamiento',
        ),
      {
        name: 'owner_restaurar_entrenamiento',
        description:
          'Restaura el entrenamiento a una revisión previa (rollback) y la republica. REQUIERE confirmación: confirmar:true solo tras un "sí".',
        schema: z.object({
          numero_revision: z.number().int().describe('Número de revisión a restaurar'),
          confirmar: z.boolean().optional().describe('true solo cuando el dueño ya confirmó'),
        }),
      },
    );

    return [
      resumenDia,
      crearTarea,
      crearRecordatorio,
      buscarContacto,
      enviarMensaje,
      moverLead,
      etiquetarContacto,
      asignarAsesor,
      verEntrenamiento,
      listarRevisiones,
      agregarInstruccion,
      restaurarEntrenamiento,
    ];
  }
}
