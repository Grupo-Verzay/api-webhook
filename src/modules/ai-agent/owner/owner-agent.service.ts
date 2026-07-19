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
  // Acción pendiente de confirmación por dueño (key = userId:ownerPhone).
  // Permite ejecutar de forma determinística cuando el dueño dice "sí", sin
  // depender de que el modelo recuerde y llame la herramienta correctamente.
  private readonly pending = new Map<
    string,
    { endpoint: string; args: Record<string, unknown>; accion: string; at: number }
  >();
  private readonly PENDING_TTL_MS = 10 * 60 * 1000;

  // Último contacto sobre el que se trabajó en la conversación (key = userId:ownerPhone).
  // Se inyecta al modelo cada turno para que "cámbialo", "etiquétalo", etc. sepan
  // de quién se habla sin repetir el número. Robusto ante el olvido del modelo.
  private readonly activeContact = new Map<string, { numero: string; nombre: string; at: number }>();

  constructor(
    private readonly logger: LoggerService,
    private readonly prisma: PrismaService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly llmClientFactory: LlmClientFactory,
  ) {}

  private isAffirmative(text: string): boolean {
    return /^\s*(s[ií]|s[ií]\s|dale|ok(ay)?|confirmo|confirmar|conf[ií]rmalo|h[aá]zlo|env[ií]a(lo)?|adelante|correcto|listo|de una|as[ií] es|perfecto)\b/i.test(
      (text ?? '').trim(),
    );
  }
  private isNegative(text: string): boolean {
    return /^\s*(no|nop|cancela(r)?|mejor no|d[eé]jalo|olv[ií]dalo|para|detente)\b/i.test(
      (text ?? '').trim(),
    );
  }

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

    // ── Confirmación determinística ─────────────────────────────────────────
    // Si hay una acción preparada esperando confirmación y el dueño responde
    // "sí"/"no", se resuelve aquí sin pasar por el modelo (que a veces no lo hace).
    const pendKey = `${params.userId}:${ownerPhone}`;
    const pend = this.pending.get(pendKey);
    const trimmed = (params.input ?? '').trim();
    if (pend && Date.now() - pend.at < this.PENDING_TTL_MS) {
      if (this.isAffirmative(trimmed)) {
        this.pending.delete(pendKey);
        const { status, json } = await this.callOwnerEndpoint(pend.endpoint, {
          ...pend.args,
          confirmed: true,
        });
        this.logger.log(
          `[owner-tool] (confirmado) ${pend.endpoint} → ${status} ${JSON.stringify(json ?? {}).slice(0, 300)}`,
          'OwnerAgentService',
        );
        const reply =
          status >= 200 && status < 300
            ? `✅ ${json?.message ?? 'Hecho.'}`
            : `No se pudo completar (${status}): ${json?.message ?? 'error'}.`;
        await this.chatHistoryService.saveMessage(params.historyId, trimmed, 'human').catch(() => undefined);
        await this.chatHistoryService.saveMessage(params.historyId, reply, 'ia').catch(() => undefined);
        return reply;
      }
      if (this.isNegative(trimmed)) {
        this.pending.delete(pendKey);
        return 'Listo, lo cancelo. ¿Algo más?';
      }
      // Cualquier otra cosa: la confirmación pendiente queda obsoleta.
      this.pending.delete(pendKey);
    }

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

    // Contacto activo: se lo recordamos al modelo para acciones de seguimiento
    // ("cámbialo a caliente", "etiquétalo", "mándale otro") sin repetir el número.
    const active = this.activeContact.get(pendKey);
    const activeMsgs =
      active && Date.now() - active.at < this.PENDING_TTL_MS
        ? [
            new SystemMessage({
              content: [
                {
                  type: 'text',
                  text: `Contacto activo de esta conversación: ${active.nombre} (número ${active.numero}). Si el dueño pide una acción sobre "él/ella" o sin indicar contacto, usa ESTE número.`,
                },
              ],
            }),
          ]
        : [];

    const messages = [
      new SystemMessage({ content: [{ type: 'text', text: OWNER_AGENT_SYSTEM_PROMPT }] }),
      ...historyMessages,
      ...activeMsgs,
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

    const pendKey = `${ctx.userId}:${ctx.ownerPhone}`;

    // Ejecuta de inmediato (acciones que NO requieren confirmación: tarea, recordatorio).
    const runDirect = async (endpoint: string, extra: Record<string, unknown>): Promise<string> => {
      const { status, json } = await this.callOwnerEndpoint(endpoint, { ...base, ...extra });
      logger.log(
        `[owner-tool] ${endpoint} userId=${ctx.userId} args=${JSON.stringify(extra)} → ${status} ${JSON.stringify(json ?? {}).slice(0, 400)}`,
        'OwnerAgentService',
      );
      if (status >= 200 && status < 300) {
        return `OK: ${json?.message ?? 'acción completada'}. ${JSON.stringify(json ?? {})}`;
      }
      return `No se pudo completar (${status}): ${json?.message ?? 'error'}.`;
    };

    // Prepara una acción que requiere confirmación: guarda el pendiente. La
    // ejecución real ocurre de forma determinística cuando el dueño dice "sí"
    // (ver handle()). El modelo solo debe mostrar el detalle y pedir confirmación.
    const prepare = (endpoint: string, extra: Record<string, unknown>, accion: string): string => {
      this.pending.set(pendKey, { endpoint, args: { ...base, ...extra }, accion, at: Date.now() });
      const ph = (extra as any)?.phone;
      if (typeof ph === 'string' && ph.trim()) {
        this.activeContact.set(pendKey, {
          numero: ph,
          nombre: this.activeContact.get(pendKey)?.nombre || 'contacto',
          at: Date.now(),
        });
      }
      logger.log(`[owner-tool] preparada "${accion}" ${endpoint} args=${JSON.stringify(extra)}`, 'OwnerAgentService');
      return `Acción "${accion}" preparada. Muéstrale al dueño EXACTAMENTE qué se hará (a quién, con qué número, qué texto/cambio) y pídele que confirme con "sí". NO llames más herramientas: cuando el dueño confirme, se ejecutará automáticamente.`;
    };

    const runRead = async (endpoint: string, extra: Record<string, unknown> = {}): Promise<string> => {
      const { status, json } = await this.callOwnerEndpoint(endpoint, { ...base, ...extra });
      // Diagnóstico: registra qué se consultó, la cuenta y un resumen del resultado.
      logger.log(
        `[owner-tool] ${endpoint} userId=${ctx.userId} args=${JSON.stringify(extra)} → ${status} ${JSON.stringify(json ?? {}).slice(0, 400)}`,
        'OwnerAgentService',
      );
      if (status >= 200 && status < 300) return JSON.stringify(json ?? {});
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
        runDirect('/api/owner/task', { title: titulo, dueDate: fecha_iso, type: tipo }),
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
        runDirect('/api/owner/reminder', { title: titulo, dueDate: fecha_iso }),
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
      async ({ busqueda }: any) => {
        const out = await runRead('/api/owner/contacts/search', { query: busqueda });
        // Si hay exactamente un contacto, recuérdalo como contacto activo.
        try {
          const parsed = JSON.parse(out);
          const list = Array.isArray(parsed?.contacts) ? parsed.contacts : [];
          if (list.length === 1) {
            const c = list[0];
            const numero = String(c?.remoteJid ?? '').split('@')[0];
            if (numero) {
              this.activeContact.set(pendKey, { numero, nombre: c?.name || 'contacto', at: Date.now() });
            }
          }
        } catch {
          /* out no era JSON (error): ignorar */
        }
        return out;
      },
      {
        name: 'owner_buscar_contacto',
        description:
          'Busca contactos del dueño por nombre o número. Úsala para encontrar el NÚMERO del contacto antes de una acción. Solo lectura.',
        schema: z.object({ busqueda: z.string().describe('Nombre o número a buscar') }),
      },
    );

    const enviarMensaje = mk(
      async ({ numero, texto }: any) =>
        prepare('/api/owner/message', { phone: numero, text: texto }, 'enviar mensaje'),
      {
        name: 'owner_enviar_mensaje',
        description:
          'Prepara el envío de un mensaje de WhatsApp a un contacto del dueño, identificado por su NÚMERO de teléfono. Llámala UNA vez con el número y el texto; el sistema pedirá confirmación y, tras el "sí" del dueño, se envía solo. No la vuelvas a llamar tras la confirmación.',
        schema: z.object({
          numero: z.string().describe('Número de teléfono del contacto, con código de país'),
          texto: z.string().describe('Mensaje a enviar'),
        }),
      },
    );

    const moverLead = mk(
      async ({ numero, estado }: any) =>
        prepare('/api/owner/lead-status', { phone: numero, status: estado }, 'mover estado de lead'),
      {
        name: 'owner_mover_lead',
        description:
          'Prepara el cambio de estado de lead (kanban) de un contacto, identificado por su NÚMERO. El sistema pedirá confirmación y, tras el "sí", se aplica solo.',
        schema: z.object({
          numero: z.string().describe('Número de teléfono del contacto, con código de país'),
          estado: z
            .enum(['FRIO', 'TIBIO', 'CALIENTE', 'FINALIZADO', 'DESCARTADO'])
            .describe('Nuevo estado del lead'),
        }),
      },
    );

    const etiquetarContacto = mk(
      async ({ numero, etiqueta }: any) =>
        prepare('/api/owner/tag', { phone: numero, tag: etiqueta }, 'etiquetar contacto'),
      {
        name: 'owner_etiquetar_contacto',
        description:
          'Prepara aplicar una etiqueta (por nombre) a un contacto identificado por su NÚMERO; se crea si no existe. El sistema pedirá confirmación y, tras el "sí", se aplica sola.',
        schema: z.object({
          numero: z.string().describe('Número de teléfono del contacto, con código de país'),
          etiqueta: z.string().describe('Nombre de la etiqueta'),
        }),
      },
    );

    const asignarAsesor = mk(
      async ({ numero, asesor }: any) =>
        prepare('/api/owner/assign', { phone: numero, advisorName: asesor }, 'asignar asesor'),
      {
        name: 'owner_asignar_asesor',
        description:
          'Prepara asignar un contacto (identificado por su NÚMERO) a un asesor de la cuenta (por nombre), o liberarlo si el nombre es "ninguno". El sistema pedirá confirmación y, tras el "sí", se aplica sola.',
        schema: z.object({
          numero: z.string().describe('Número de teléfono del contacto, con código de país'),
          asesor: z.string().describe('Nombre del asesor, o "ninguno" para liberar'),
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
      async ({ instruccion, titulo }: any) =>
        prepare(
          '/api/owner/training/instruction',
          { instruction: instruccion, title: titulo },
          'agregar instrucción al entrenamiento',
        ),
      {
        name: 'owner_agregar_instruccion_entrenamiento',
        description:
          'Prepara agregar una instrucción al entrenamiento del agente de clientes y publicarla (solo agrega, no reescribe). El sistema pedirá confirmación y, tras el "sí", se publica sola.',
        schema: z.object({
          instruccion: z.string().describe('La regla/comportamiento a agregar'),
          titulo: z.string().optional().describe('Opcional. Título corto de la instrucción.'),
        }),
      },
    );

    const restaurarEntrenamiento = mk(
      async ({ numero_revision }: any) =>
        prepare(
          '/api/owner/training/restore',
          { revisionNumber: numero_revision },
          'restaurar entrenamiento',
        ),
      {
        name: 'owner_restaurar_entrenamiento',
        description:
          'Prepara restaurar el entrenamiento a una revisión previa (rollback) y republicarla. El sistema pedirá confirmación y, tras el "sí", se aplica sola.',
        schema: z.object({
          numero_revision: z.number().int().describe('Número de revisión a restaurar'),
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
