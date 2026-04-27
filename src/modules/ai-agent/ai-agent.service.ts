import axios from 'axios';

import { Readable } from 'stream';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { PromptService } from '../prompt/prompt.service';
import { ChatHistoryService } from '../chat-history/chat-history.service';
import { WorkflowService } from '../workflow/services/workflow.service.ts/workflow.service';
import {
  inputWorkflow,
  OpenAIDetectionResult,
  openAIToolDetection,
  proccessInput,
} from 'src/types/open-ai';
import { NotificacionToolService } from './tools/notificacion/notificacion.service';
import { AiCreditsService } from '../ai-credits/ai-credits.service';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SessionService } from '../session/session.service';
import { ExternalClientDataService } from '../external-client-data/external-client-data.service';

// Refactor
import { LlmClientFactory } from './services/llmClientFactory/llmClientFactory.service';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { NodeSenderService } from '../workflow/services/node-sender.service.ts/node-sender.service';
import { AgentNotificationService } from './services/notificacionService/notificacion.service';

// LangGraph + Tools
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { PrismaService } from 'src/database/prisma.service';
import { systemPromptWorkflow } from './utils/rulesPrompt';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import { CRM_AGENT_PROMPT_IDS } from '../../types/CRM_AGENT_PROMPT_IDS';

@Injectable()
export class AiAgentService {
  // Cliente LLM (LangChain / OpenAI envuelto)
  private aiClient: any = null;

  // Nombre del flujo de bienvenida inicial
  private readonly initWorkflowName: string = 'INICIO_BIENVENIDA';

  constructor(
    private readonly logger: LoggerService,
    private readonly promptService: PromptService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly notificacionTool: NotificacionToolService,
    private readonly aiCredits: AiCreditsService,
    private readonly llmClientFactory: LlmClientFactory,
    private readonly prisma: PrismaService,
    private readonly nodeSenderService: NodeSenderService,
    private readonly sessionService: SessionService,
    private readonly agentNotificationService: AgentNotificationService,
    private readonly externalClientDataService: ExternalClientDataService,

    @Inject(forwardRef(() => WorkflowService))
    private readonly workflowService: WorkflowService,
  ) {}

  private async getClientForUser(userId: string): Promise<BaseChatModel> {
    // 1) Usuario (default provider/model)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        defaultProviderId: true,
        defaultAiModelId: true,
      },
    });

    if (!user?.defaultProviderId || !user?.defaultAiModelId) {
      throw new Error('Usuario sin defaultProviderId/defaultAiModelId');
    }

    // 2) API Key activa
    const cfg = await this.prisma.userAiConfig.findFirst({
      where: { userId, isActive: true, providerId: user.defaultProviderId },
      select: { apiKey: true },
    });

    if (!cfg?.apiKey) throw new Error('No hay apiKey activa para el usuario');

    // 3) Provider + Model
    const provider = await this.prisma.aiProvider.findUnique({
      where: { id: user.defaultProviderId },
      select: { name: true },
    });

    const model = await this.prisma.aiModel.findUnique({
      where: { id: user.defaultAiModelId },
      select: { name: true },
    });

    if (!provider?.name || !model?.name) {
      throw new Error('Provider/model inválidos');
    }

    // 4) Crear cliente LangChain (BaseChatModel)
    return this.llmClientFactory.getClient({
      provider: provider.name as any, // ideal: tipar provider como 'openai' | 'google'
      apiKey: cfg.apiKey,
      model: model.name,
    });
  }

  // Logger con contexto fijo: [UID=...][I=...][R=...]
  private scopedLogger(ctx: {
    userId?: string;
    instanceName?: string;
    remoteJid?: string;
  }) {
    const tag = `[UID=${ctx.userId ?? '-'}][I=${ctx.instanceName ?? '-'}][R=${
      ctx.remoteJid ?? '-'
    }]`;
    return {
      log: (msg: string, context = 'AiAgentService') =>
        this.logger.log(`${tag} ${msg}`, context),
      warn: (msg: string, context = 'AiAgentService') =>
        this.logger.warn(`${tag} ${msg}`, context),
      error: (msg: string, err?: any, context = 'AiAgentService') =>
        this.logger.error(`${tag} ${msg}`, err, context),
    };
  }

  // Inicializa el cliente LLM (LangChain) según provider y modelo.
  private initializeClient(
    apikeyOpenAi: string,
    model: string,
    provider: string,
  ): BaseChatModel {
    this.logger.log(
      `Inicializando cliente LLM. provider=${provider} model=${model}`,
      'AiAgentService',
    );
    this.aiClient = this.llmClientFactory.getClient({
      provider,
      apiKey: apikeyOpenAi,
      model,
    });
    return this.aiClient;
  }

  // Valida si una API Key parece válida.
  private isValidApiKey(apikeyOpenAi: string): boolean {
    return (
      typeof apikeyOpenAi === 'string' &&
      apikeyOpenAi.startsWith('sk-') &&
      apikeyOpenAi.length >= 40
    );
  }

  /**
   * Ejemplo tonto de función auxiliar (no usada).
   */
  private async getWeather(location: string): Promise<string> {
    return `Soleado y 25°C en ${location}`;
  }

  /**
   * Agente interno de detección de flujos.
   */
  private async openAIToolDetection({
    input,
    sessionId,
    userId,
  }: openAIToolDetection): Promise<OpenAIDetectionResult> {
    const logger = this.scopedLogger({ userId });
    try {
      const workflows = await this.workflowService.getWorkflow(userId);

      const formattedList = workflows
        .map((flow, index) => `${index + 1}. ${flow.name}`)
        .join(',\n');

      // logger.log(`Lista de flujos (texto): ${formattedList}`);
      // logger.log(`Lista de flujos (obj): ${JSON.stringify(workflows)}`);

      const customWorkflowPrompt = systemPromptWorkflow(
        input,
        JSON.stringify(formattedList),
      );

      const messagesR = [
        new SystemMessage({
          content: [{ type: 'text', text: customWorkflowPrompt }],
        }),
        new HumanMessage({
          content: [{ type: 'text', text: JSON.stringify(input) }],
        }),
      ];

      const responseR = await this.aiClient.invoke(messagesR);

      const choice = responseR.content.toString();
      const content = choice.trim();

      const totalTokensR = responseR?.usage_metadata?.total_tokens;
      const tokensUsedR = totalTokensR
        ? parseInt(totalTokensR.toString(), 10)
        : 0;
      await this.aiCredits.trackTokens(userId, tokensUsedR);

      if (!choice || !content) {
        logger.warn('Content inválido o vacío');
        return { content: null };
      }

      return { content };
    } catch (error) {
      logger.error(
        'Error procesando entrada con OpenAI (detección de flujos).',
        (error as any)?.response?.data || (error as any)?.message,
      );
      return { content: null };
    }
  }

  /**
   * Tools reales para el createReactAgent.
   * Cada tool llama a los servicios internos de NestJS.
   * OJO: usamos `// @ts-ignore` para evitar que TS intente expandir genéricos infinitos.
   */
  /**
   * Construye el array de herramientas LangChain para el agente ReAct.
   *
   * ESTRATEGIA:
   *  - Si el usuario tiene configs en DB → se usan exclusivamente esas (config-driven).
   *  - Si el usuario NO tiene configs → se devuelven todas las tools hardcodeadas
   *    (safety net de retrocompatibilidad: clientes existentes sin configurar no se rompen).
   *
   * DISPATCHER:
   *  Cada config con toolCategory='builtin' se despacha según toolType a su
   *  implementación fija. Las de toolCategory='data_query' y toolType='search_by_field'
   *  son totalmente dinámicas. toolType='auto_inject' se ignora aquí (es para system prompt).
   */
  private async buildReactTools(params: {
    userId: string;
    sessionId: string;
    server_url: string;
    apikey: string;
    instanceName: string;
    remoteJid: string;
    pushName: string;
    toolConfigs?: any[];
  }): Promise<any[]> {
    const {
      userId,
      toolConfigs: preloadedConfigs,
    } = params;
    const logger = this.scopedLogger({
      userId,
      instanceName: params.instanceName,
      remoteJid: params.remoteJid,
    });

    // Obtener configs (ya precargadas desde processInput para evitar doble query)
    const allConfigs =
      preloadedConfigs ??
      (await this.externalClientDataService.getToolConfigs(userId).catch(() => []));

    // ── SAFETY NET ──────────────────────────────────────────────────────────
    // Si el usuario no tiene NINGUNA config → fallback completo a las tools
    // hardcodeadas. Esto garantiza que clientes existentes no se vean afectados.
    if (allConfigs.length === 0) {
      logger.warn(
        'Sin ExternalDataToolConfig para este usuario → usando tools hardcodeadas por defecto',
      );
      return this.buildHardcodedDefaultTools(params);
    }

    // ── CONFIG-DRIVEN ───────────────────────────────────────────────────────
    // Solo se incluyen las configs habilitadas; auto_inject no es una tool de LangChain.
    const tools: any[] = [];

    // Ref compartido entre tools del mismo turno del agente para evitar que
    // Notificacion_Asesor se dispare más de una vez (ej: después de Ejecutar_Flujos
    // que ya incluyó un nodo-notify en el workflow).
    const notificationSentThisTurn = { value: false };

    for (const cfg of allConfigs) {
      if (!cfg.isEnabled) continue;
      if (cfg.toolType === 'auto_inject') continue; // lo maneja processInput

      const builtTool = this.buildToolFromConfig(cfg, params, notificationSentThisTurn);
      if (builtTool) {
        tools.push(builtTool);
      } else {
        logger.warn(
          `[buildReactTools] toolType desconocido o config inválida: toolKey="${cfg.toolKey}" toolType="${cfg.toolType}" — omitida`,
        );
      }
    }

    return tools;
  }

  /**
   * Despacha la construcción de una tool LangChain según el toolType de la config.
   * Retorna null para toolTypes desconocidos o configs incompletas (campo requerido vacío).
   */
  private buildToolFromConfig(cfg: any, params: {
    userId: string;
    sessionId: string;
    server_url: string;
    apikey: string;
    instanceName: string;
    remoteJid: string;
    pushName: string;
  }, notificationSentThisTurn?: { value: boolean }): any | null {
    switch (cfg.toolType) {
      case 'notificacion_asesor':
        return this.buildNotificacionAsesorTool(cfg, params, notificationSentThisTurn);
      case 'ejecutar_flujos':
        return this.buildEjecutarFlujosTool(cfg, params, notificationSentThisTurn);
      case 'listar_workflows':
        return this.buildListarWorkflowsTool(cfg, params);
      case 'consultar_datos_cliente':
        return this.buildConsultarDatosClienteTool(cfg, params);
      case 'buscar_cliente_por_dato':
        return this.buildBuscarClientePorDatoTool(cfg, params);
      case 'search_by_field':
        return cfg.searchField
          ? this.buildSearchByFieldTool(cfg, params)
          : null;
      case 'buscar_producto':
        return this.buildBuscarProductoTool(cfg, params);
      case 'listar_productos':
        return this.buildListarProductosTool(cfg, params);
      case 'listar_servicios_agenda':
        return this.buildListarServiciosAgendaTool(cfg, params);
      case 'consultar_slots_disponibles':
        return this.buildConsultarSlotsDisponiblesTool(cfg, params);
      case 'crear_cita':
        return this.buildCrearCitaTool(cfg, params);
      default:
        return null;
    }
  }

  // ─── Individual tool builders ─────────────────────────────────────────────

  private buildNotificacionAsesorTool(cfg: any, params: {
    userId: string; server_url: string; apikey: string;
    instanceName: string; remoteJid: string;
  }, notificationSentThisTurn?: { value: boolean }): any {
    const { userId, server_url, apikey, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore - evitar problemas de tipos profundos con LangChain + zod
    return tool(
      async ({ nombre, detalles }: { nombre: string; detalles: string }) => {
        if (notificationSentThisTurn?.value) {
          logger.warn(
            `[NOTIF_DEDUPE] Tool "${cfg.toolKey}" omitida: ya se envió una notificación en este turno del agente.`,
          );
          return `Notificación ya enviada en este turno. Sin duplicado para "${nombre}".`;
        }
        logger.log(`Tool "${cfg.toolKey}" (notificacion_asesor) llamada para: ${nombre}`);
        const res = await this.notificacionTool.handleNotificacionTool(
          { nombre, detalles } as any,
          userId, server_url, apikey, instanceName, remoteJid,
        );
        if (notificationSentThisTurn) notificationSentThisTurn.value = true;
        return res === 'ok'
          ? `Notificación enviada al asesor para el cliente "${nombre}". Detalle: ${detalles}`
          : `No se pudo notificar al asesor. Detalle original del cliente: ${detalles}`;
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          nombre: z.string().describe('Nombre del usuario'),
          detalles: z.string().describe('Detalle de la notificación o solicitud'),
        }),
      },
    );
  }

  private buildEjecutarFlujosTool(cfg: any, params: {
    userId: string; sessionId: string; server_url: string;
    apikey: string; instanceName: string; remoteJid: string;
  }, notificationSentThisTurn?: { value: boolean }): any {
    const { userId, sessionId, server_url, apikey, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async ({ nombre_flujo, detalles }: { nombre_flujo: string; detalles: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (ejecutar_flujos) → "${nombre_flujo}"`);
        const follow = await this.handleExecuteWorkflowTool(
          { nombre_flujo: [nombre_flujo], descripcion: detalles } as any,
          userId, sessionId, server_url, apikey, instanceName, remoteJid,
        );
        // El workflow puede incluir un nodo-notify. Marcar como notificado para
        // impedir que Notificacion_Asesor se dispare en el mismo turno del agente.
        if (notificationSentThisTurn) notificationSentThisTurn.value = true;
        return follow || `ℹ️ Flujo "${nombre_flujo}" ejecutado.`;
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          nombre_flujo: z.string().describe('Nombre del flujo que se debe ejecutar'),
          detalles: z.string().describe('Texto original de la solicitud del usuario o contexto adicional'),
        }),
      },
    );
  }

  private buildListarWorkflowsTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string;
  }): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async () => {
        logger.log(`Tool "${cfg.toolKey}" (listar_workflows) llamada.`);
        const workflows = await this.workflowService.getWorkflow(userId).catch(() => []);
        if (!Array.isArray(workflows) || workflows.length === 0) {
          return 'No hay flujos configurados actualmente para este usuario.';
        }
        return `Flujos disponibles:\n${workflows.map((w: any, i: number) => `${i + 1}. ${w.name ?? 'SIN_NOMBRE'}`).join('\n')}`;
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({}),
      },
    );
  }

  private buildConsultarDatosClienteTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string;
  }): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async () => {
        logger.log(`Tool "${cfg.toolKey}" (consultar_datos_cliente) llamada.`);
        const data = await this.externalClientDataService.getByRemoteJid(userId, remoteJid);
        if (!data || Object.keys(data).length === 0) {
          return 'No hay datos externos registrados para este cliente.';
        }
        return this.externalClientDataService.formatForAgent(data);
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({}),
      },
    );
  }

  private buildBuscarClientePorDatoTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string;
  }): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async ({ campo, valor }: { campo: string; valor: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (buscar_cliente_por_dato): campo="${campo}" valor="${valor}"`);
        const data = await this.externalClientDataService.getByDataField(userId, campo, valor);
        if (!data || Object.keys(data).length === 0) {
          return `No se encontró ningún cliente con ${campo.toUpperCase()}: ${valor} en el sistema.`;
        }
        return this.externalClientDataService.formatForAgent(data);
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          campo: z.string().describe('Nombre del campo por el que buscar. Ejemplos: "CEDULA-RIF", "CORREO", "NOMBRE".'),
          valor: z.string().describe('Valor a buscar. Ejemplos: "V27548446", "juan@email.com".'),
        }),
      },
    );
  }

  private buildSearchByFieldTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string;
  }): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async ({ valor }: { valor: string }) => {
        logger.log(`Tool dinámica "${cfg.toolKey}" (search_by_field): campo="${cfg.searchField}" valor="${valor}"`);
        const data = await this.externalClientDataService.getByDataField(userId, cfg.searchField!, valor);
        if (!data || Object.keys(data).length === 0) {
          return `No se encontró ningún registro con ${cfg.searchField!.toUpperCase()}: ${valor}.`;
        }
        return this.externalClientDataService.formatForAgent(data);
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          valor: z.string().describe(
            `Valor de ${cfg.searchField} a buscar. Ejemplo: si el campo es CEDULA-RIF, el valor sería "V27548446".`,
          ),
        }),
      },
    );
  }

  private buildBuscarProductoTool(cfg: any, params: {
    userId: string; server_url: string; apikey: string;
    instanceName: string; remoteJid: string;
  }): any {
    const { userId, server_url, apikey, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async ({ query, category, sku }: { query?: string; category?: string; sku?: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (buscar_producto): query="${query}" category="${category}" sku="${sku}"`);

        const where: any = { userId, isActive: true };
        if (sku) {
          where.sku = sku;
        } else {
          if (query) where.title = { contains: query, mode: 'insensitive' };
          if (category) where.category = category;
        }

        const products = await this.prisma.product.findMany({ where, orderBy: { title: 'asc' } });

        if (products.length === 0) {
          return 'No se encontraron productos con los criterios indicados.';
        }

        // Enviar imágenes de los productos encontrados (máximo 5 para no saturar el chat)
        const sendMediaUrl = `${server_url.replace(/\/+$/, '')}/message/sendMedia/${encodeURIComponent(instanceName)}`;
        const productsWithImages = products.filter(
          (p) => Array.isArray(p.images) && (p.images as string[]).length > 0 && (p.images as string[])[0]?.trim(),
        );

        logger.log(`[buscar_producto] ${products.length} producto(s) encontrado(s), ${productsWithImages.length} con imagen. sendMediaUrl=${sendMediaUrl}`);

        for (const product of productsWithImages.slice(0, 5)) {
          const imageUrl = (product.images as string[])[0];
          logger.log(`[buscar_producto] Enviando imagen de "${product.title}": ${imageUrl}`);
          const sent = await this.nodeSenderService.sendMediaNode(
            sendMediaUrl, apikey, remoteJid,
            'image',
            `${product.title} — $${Number(product.price).toLocaleString('es-CO')}`,
            imageUrl,
          );
          logger.log(`[buscar_producto] Resultado envío imagen "${product.title}": ${sent ? 'OK' : 'FALLÓ'}`);
        }

        const formatted = products
          .map((p) =>
            `• ${p.title} — $${Number(p.price).toLocaleString('es-CO')} | Categoría: ${p.category} | Stock: ${p.stock}` +
            (p.description ? `\n  ${p.description}` : '') +
            (p.sku ? ` | SKU: ${p.sku}` : ''),
          )
          .join('\n');

        return `Productos encontrados (${products.length}):\n${formatted}`;
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          query: z.string().optional().describe('Nombre o texto del producto a buscar'),
          category: z.string().optional().describe('Categoría del producto'),
          sku: z.string().optional().describe('Código SKU exacto del producto'),
        }),
      },
    );
  }

  private buildListarProductosTool(cfg: any, params: {
    userId: string; server_url: string; apikey: string;
    instanceName: string; remoteJid: string;
  }): any {
    const { userId, server_url, apikey, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async () => {
        logger.log(`Tool "${cfg.toolKey}" (listar_productos) llamada.`);

        const products = await this.prisma.product.findMany({
          where: { userId, isActive: true },
          orderBy: { category: 'asc' },
        });

        if (products.length === 0) {
          return 'No hay productos disponibles en este momento.';
        }

        // Enviar imágenes de los productos (máximo 5 para no saturar el chat)
        const sendMediaUrl = `${server_url.replace(/\/+$/, '')}/message/sendMedia/${encodeURIComponent(instanceName)}`;
        const productsWithImages = products.filter(
          (p) => Array.isArray(p.images) && (p.images as string[]).length > 0 && (p.images as string[])[0]?.trim(),
        );

        logger.log(`[listar_productos] ${products.length} producto(s), ${productsWithImages.length} con imagen. sendMediaUrl=${sendMediaUrl}`);

        for (const product of productsWithImages.slice(0, 5)) {
          const imageUrl = (product.images as string[])[0];
          logger.log(`[listar_productos] Enviando imagen de "${product.title}": ${imageUrl}`);
          const sent = await this.nodeSenderService.sendMediaNode(
            sendMediaUrl, apikey, remoteJid,
            'image',
            `${product.title} — $${Number(product.price).toLocaleString('es-CO')}`,
            imageUrl,
          );
          logger.log(`[listar_productos] Resultado envío imagen "${product.title}": ${sent ? 'OK' : 'FALLÓ'}`);
        }

        const formatted = products
          .map((p) =>
            `• ${p.title} — $${Number(p.price).toLocaleString('es-CO')} | Categoría: ${p.category} | Stock: ${p.stock}` +
            (p.description ? `\n  ${p.description}` : ''),
          )
          .join('\n');

        return `Catálogo de productos disponibles (${products.length}):\n${formatted}`;
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({}),
      },
    );
  }

  // ─── Agenda / citas ──────────────────────────────────────────────────────

  private buildListarServiciosAgendaTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string;
  }): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    const nextjsUrl = (process.env.NEXTJS_URL ?? '').replace(/\/+$/, '');
    const runnerKey = process.env.CRM_FOLLOW_UP_RUNNER_KEY ?? '';

    // @ts-ignore
    return tool(
      async () => {
        logger.log(`Tool "${cfg.toolKey}" (listar_servicios_agenda) llamada.`);
        try {
          const res = await axios.get(
            `${nextjsUrl}/api/schedule/services?userId=${encodeURIComponent(userId)}`,
            { headers: { Authorization: `Bearer ${runnerKey}` } },
          );
          const { services = [], total = 0 } = res.data ?? {};
          if (!Array.isArray(services) || services.length === 0) {
            return 'No hay servicios configurados para agendar en este momento.';
          }
          const list = services
            .map((s: any, i: number) =>
              `${i + 1}. ${s.name}${s.description ? ` — ${s.description}` : ''}  (id: ${s.id})`,
            )
            .join('\n');
          return `Servicios disponibles (${total}):\n${list}`;
        } catch (err: any) {
          logger.error(`[listar_servicios_agenda] Error: ${err?.message}`);
          return 'No fue posible obtener los servicios en este momento. Inténtalo más tarde.';
        }
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({}),
      },
    );
  }

  private buildConsultarSlotsDisponiblesTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string;
  }): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    const nextjsUrl = (process.env.NEXTJS_URL ?? '').replace(/\/+$/, '');
    const runnerKey = process.env.CRM_FOLLOW_UP_RUNNER_KEY ?? '';

    // @ts-ignore
    return tool(
      async ({ date }: { date: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (consultar_slots_disponibles) date="${date}"`);
        try {
          const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { timezone: true },
          });
          const timezone = user?.timezone || 'UTC';

          const url =
            `${nextjsUrl}/api/schedule/slots?userId=${encodeURIComponent(userId)}` +
            `&date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(timezone)}`;

          const res = await axios.get(url, {
            headers: { Authorization: `Bearer ${runnerKey}` },
          });

          const { slots = [], total = 0 } = res.data ?? {};
          if (!Array.isArray(slots) || slots.length === 0) {
            return `No hay horarios disponibles para el ${date}.`;
          }

          const localSlots = slots.map((s: any) => {
            const start = new Date(s.startTime).toLocaleTimeString('es-CO', {
              timeZone: timezone,
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
            const end = new Date(s.endTime).toLocaleTimeString('es-CO', {
              timeZone: timezone,
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
            return `• ${start} – ${end}  (startTime: ${s.startTime} | endTime: ${s.endTime})`;
          });

          return `Horarios disponibles para el ${date} (${total}):\n${localSlots.join('\n')}`;
        } catch (err: any) {
          logger.error(`[consultar_slots_disponibles] Error: ${err?.message}`);
          return 'No fue posible consultar los horarios disponibles. Inténtalo más tarde.';
        }
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          date: z.string().describe('Fecha a consultar en formato YYYY-MM-DD. Ejemplo: "2025-05-20"'),
        }),
      },
    );
  }

  private buildCrearCitaTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string; pushName: string;
  }): any {
    const { userId, instanceName, remoteJid, pushName } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    const nextjsUrl = (process.env.NEXTJS_URL ?? '').replace(/\/+$/, '');
    const runnerKey = process.env.CRM_FOLLOW_UP_RUNNER_KEY ?? '';

    // @ts-ignore
    return tool(
      async ({ serviceId, startTime, endTime }: { serviceId: string; startTime: string; endTime: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (crear_cita) serviceId="${serviceId}" startTime="${startTime}"`);
        try {
          const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { timezone: true },
          });
          const timezone = user?.timezone || 'UTC';

          const res = await axios.post(
            `${nextjsUrl}/api/schedule/appointment`,
            {
              userId,
              serviceId,
              pushName,
              phone: remoteJid,
              instanceName,
              startTime,
              endTime,
              timezone,
            },
            {
              headers: {
                Authorization: `Bearer ${runnerKey}`,
                'Content-Type': 'application/json',
              },
            },
          );

          const { message, appointment } = res.data ?? {};
          const confirmDate = appointment?.startTime
            ? new Date(appointment.startTime).toLocaleString('es-CO', {
                timeZone: timezone,
                dateStyle: 'full',
                timeStyle: 'short',
              })
            : startTime;

          return message
            ? `${message} — ${confirmDate}`
            : `Cita agendada exitosamente para el ${confirmDate}.`;
        } catch (err: any) {
          const errMsg = err?.response?.data?.message ?? err?.message ?? 'error desconocido';
          logger.error(`[crear_cita] Error: ${errMsg}`);
          return `No fue posible agendar la cita: ${errMsg}`;
        }
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          serviceId: z.string().describe('ID del servicio seleccionado por el cliente (obtenido de listar_servicios_agenda)'),
          startTime: z.string().describe('Hora de inicio de la cita en formato ISO UTC. Ejemplo: "2025-05-20T14:00:00.000Z"'),
          endTime: z.string().describe('Hora de fin de la cita en formato ISO UTC. Ejemplo: "2025-05-20T15:00:00.000Z"'),
        }),
      },
    );
  }

  /**
   * Safety net: devuelve las 5 tools hardcodeadas originales.
   * Solo se usa cuando un usuario no tiene NINGUNA ExternalDataToolConfig en DB.
   * Garantiza retrocompatibilidad total con clientes pre-configuración dinámica.
   */
  private buildHardcodedDefaultTools(params: {
    userId: string;
    sessionId: string;
    server_url: string;
    apikey: string;
    instanceName: string;
    remoteJid: string;
    pushName: string;
  }): any[] {
    const HARDCODED_BUILTIN_CONFIGS = [
      {
        toolKey: 'Notificacion_Asesor', toolType: 'notificacion_asesor',
        toolDescription: 'Utiliza esta *tool* solo cuando un usuario necesite la ayuda directa de un asesor humano o exista un registro ya guardado de (solicitud, pedido, reclamo, cita, reserva o el usuario envía una *imagen de comprobante de pago* que requiere validación).',
      },
      {
        toolKey: 'Ejecutar_Flujos', toolType: 'ejecutar_flujos',
        toolDescription: 'Siempre consulta esta *tool* y ejecutala si existen flujos disponibles en la base de conocimiento que correspondan a la solicitud del usuario o declarado por algún paso. Si se encuentra un flujo, se ejecuta. Si no hay flujos, la IA continúa la conversación normalmente.',
      },
      {
        toolKey: 'listar_workflows', toolType: 'listar_workflows',
        toolDescription: 'Devuelve todos los flujos disponibles para este usuario.',
      },
      {
        toolKey: 'consultar_datos_cliente', toolType: 'consultar_datos_cliente',
        toolDescription: 'Consulta el perfil externo del cliente actual: cédula, correo, servicio contratado, monto, sector, convenio u otros campos configurados por el administrador.',
      },
      {
        toolKey: 'buscar_cliente_por_dato', toolType: 'buscar_cliente_por_dato',
        toolDescription: 'Busca la información de un cliente a partir de un dato conocido como cédula, RIF, correo u otro campo registrado. Solo consulta datos del usuario actual.',
      },
    ];

    const notificationSentThisTurn = { value: false };
    return HARDCODED_BUILTIN_CONFIGS.map((cfg) => this.buildToolFromConfig(cfg, params, notificationSentThisTurn)).filter(Boolean);
  }

  /**
   * Extrae el contenido de texto del último mensaje del agente ReAct.
   */
  private extractReactAgentReply(result: any): string {
    if (!result) return '';

    const messages = Array.isArray(result.messages) ? result.messages : [];
    if (messages.length === 0) return '';

    const last = messages[messages.length - 1];
    const content = last?.content;

    if (typeof content === 'string') {
      return content.trim();
    }

    if (Array.isArray(content)) {
      const joined = content
        .map((c: any) => {
          if (typeof c === 'string') return c;
          if (typeof c?.text === 'string') return c.text;
          return '';
        })
        .join(' ')
        .trim();
      return joined;
    }

    if (content?.text) {
      return String(content.text).trim();
    }

    return String(content ?? '').trim();
  }

  private extractWorkflowNameFromLiteral(text: string): string | null {
    const raw = (text || '').trim();

    const m =
      raw.match(/ejecuta\s+el\s+flujo\s+['"`]([^'"`]+)['"`]/i) ??
      raw.match(/\bflujo\b\s*[:\-]?\s*['"`]([^'"`]+)['"`]/i);

    return m?.[1]?.trim() || null;
  }

  private sanitizeOutgoingText(text: string): string {
    const lines = (text || '').split('\n');

    const banned = (line: string) => {
      const s = line.trim();

      // bullets típicos del prompt
      if (/^\-\s*\(\d+\)\s*\*\*función\*\*/i.test(s)) return true;
      if (/\*\*función\*\*/i.test(s) && /ejecuta\s+el\s+flujo/i.test(s))
        return true;

      if (/\*\*regla\/parámetro\*\*/i.test(s)) return true;
      if (/comportamiento\s+obligatorio/i.test(s)) return true;
      if (/^####\s*elementos/i.test(s)) return true;

      // opcional si también se te están colando headers internos
      if (/^###\s*paso\s+\d+/i.test(s)) return true;

      return false;
    };

    const cleaned = lines
      .filter((l) => !banned(l))
      .join('\n')
      .trim();
    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Ejecuta un workflow por nombre exacto (case-insensitive),
   * con control anti-duplicados (usa el mismo registro en chatHistory + session).
   */
  private async executeWorkflowByNameIfPossible(params: {
    workflowName: string;
    userId: string;
    sessionId: string;
    server_url: string;
    apikey: string;
    instanceName: string;
    remoteJid: string;
  }): Promise<boolean> {
    const {
      workflowName,
      userId,
      sessionId,
      server_url,
      apikey,
      instanceName,
      remoteJid,
    } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    const workflows = await this.workflowService
      .getWorkflow(userId)
      .catch(() => []);
    if (!Array.isArray(workflows) || workflows.length === 0) return false;

    const currentWorkflow = workflows.find(
      (w: any) => (w?.name || '').toLowerCase() === workflowName.toLowerCase(),
    );
    if (!currentWorkflow) return false;

    const alreadyExecuted =
      await this.chatHistoryService.hasIntentionBeenExecuted(
        sessionId,
        currentWorkflow.name,
      );

    if (alreadyExecuted) return true; // ya estaba hecho, igual “consumimos” la instrucción literal

    await this.chatHistoryService.registerExecutedIntention(
      sessionId,
      currentWorkflow.name,
      'intention',
    );

    await this.workflowService.executeWorkflow(
      currentWorkflow.name,
      server_url,
      apikey,
      instanceName,
      remoteJid,
      userId,
    );

    await this.sessionService.registerWorkflow(
      { id: currentWorkflow.id, name: currentWorkflow.name },
      remoteJid,
      instanceName,
      userId,
    );

    logger.log(
      `OutboundGuard: workflow ejecutado por literal => ${currentWorkflow.name}`,
    );
    return true;
  }

  /**
   * Proceso principal de entrada (AGENTE PRINCIPAL).
   * Llamado desde el webhook.
   */
  async processInput({
    input,
    userId,
    apikeyOpenAi,
    defaultModel,
    defaultProvider,
    sessionId,
    server_url,
    apikey,
    instanceName,
    remoteJid,
    pushName = '',
  }: proccessInput): Promise<string> {
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    try {
      // Inicializar LLM (LangChain client)
      this.initializeClient(apikeyOpenAi, defaultModel, defaultProvider);

      const systemPrompt = await this.promptService
        .getPromptUserId(userId, CRM_AGENT_PROMPT_IDS.systemPrompAI)
        .catch(() => '');

      //logger.log('PROMPT:', systemPrompt);

      const extraRules = await this.promptService
        .getPromptPadre('cm842kthc0000qd2l66nbnytv')
        .catch(() => '');

      // Datos externos del cliente (cédula, correo, servicio, monto, etc.)
      const [externalClientData, toolConfigs] = await Promise.all([
        this.externalClientDataService.getByRemoteJid(userId, remoteJid).catch(() => null),
        this.externalClientDataService.getToolConfigs(userId).catch(() => []),
      ]);

      let externalDataBlock = '';
      if (externalClientData && Object.keys(externalClientData).length > 0) {
        const formattedData = this.externalClientDataService.formatForAgent(externalClientData);
        const autoInjectConfig = toolConfigs.find(
          (c: any) => c.toolType === 'auto_inject' && c.isEnabled,
        );

        if (autoInjectConfig?.promptTemplate) {
          externalDataBlock = `\n\n---\n${this.externalClientDataService.applyPromptTemplate(
            autoInjectConfig.promptTemplate,
            formattedData,
          )}\n---`;
        } else {
          externalDataBlock = `\n\n---\n## PERFIL DEL CLIENTE (datos registrados en el sistema)\n${formattedData}\nUsa estos datos para personalizar tus respuestas. No los repitas todos de golpe; solo menciona los relevantes según el contexto. No inventes ni modifiques ninguno de estos valores.\n---`;
        }
      }

      // Prompt PRINCIPAL del agente
      const promptAI = `${extraRules} ${systemPrompt}${externalDataBlock}`.trim();

      // logger.log('PROMPT:', promptAI);

      const chatHistory =
        await this.chatHistoryService.getChatHistory(sessionId);

      const historyMessages = chatHistory.map(
        (text) =>
          new HumanMessage({
            content: [{ type: 'text', text }],
          }),
      );

      // logger.log(`HISTORIAL: ${JSON.stringify(historyMessages, null, 2)}`);

      const rawInputMessage = new HumanMessage({
        content: [{ type: 'text', text: input }],
      });

      const systemMessage = new SystemMessage({
        content: [{ type: 'text', text: promptAI }],
      });

      const messagesForLlm = [
        systemMessage,
        ...historyMessages,
        rawInputMessage,
      ];

      const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

      // Tools + agente ReAct
      const tools = await this.buildReactTools({
        userId,
        sessionId,
        server_url,
        apikey,
        instanceName,
        remoteJid,
        pushName: pushName ?? '',
        toolConfigs,
      });

      const createReactAgentWithRetry = async () => {
        let attempt = 0;
        const maxAttempts = 3;

        while (true) {
          try {
            const agent = createReactAgent({
              llm: this.aiClient,
              tools,
            });

            const result = await agent.invoke({
              messages: messagesForLlm,
            });

            return result;
          } catch (err: any) {
            attempt++;

            const isRate =
              err?.code === 'rate_limit_exceeded' ||
              err?.status === 429 ||
              (typeof err?.message === 'string' &&
                err.message.toLowerCase().includes('rate limit'));

            if (!isRate || attempt >= maxAttempts) {
              throw err;
            }

            const backoff = Math.floor(
              2 ** attempt * 1000 + Math.random() * 1000,
            );
            logger.warn(
              `Rate limit (ReAct agent): reintento #${attempt} en ${backoff}ms`,
            );
            await sleep(backoff);
          }
        }
      };

      let result: any;

      // --- Llamada al agente con manejo especial de error de CUOTA ---
      try {
        result = await createReactAgentWithRetry();
      } catch (err: any) {
        const msg = err?.message || '';
        const name = err?.name || '';

        const isQuota =
          name === 'InsufficientQuotaError' ||
          msg.includes('exceeded your current quota') ||
          msg.includes('You exceeded your current quota') ||
          msg.includes('InsufficientQuota');

        if (isQuota) {
          logger.warn(
            '❌ Error de cuota con el proveedor de IA (OpenAI). El asistente no puede responder hasta que se restablezca el plan/billing.',
          );

          try {
            const apiUrl = `${server_url}/message/sendText/${instanceName}`;
            const notificationPhones =
              await this.agentNotificationService.getNotificationPhones(
                userId,
                remoteJid,
              );

            if (notificationPhones.length > 0) {
              const aviso =
                '⚠️ Tu *agente IA* alcanzó el límite de uso del proveedor de IA.\n\n' +
                '🧐 Por favor revisa el plan o la facturación del modelo configurado\n\n' +
                '👉 https://platform.openai.com/settings/organization/billing/overview';
              await Promise.all(
                notificationPhones.map((phone) =>
                  this.nodeSenderService.sendTextNode(apiUrl, apikey, phone, aviso),
                ),
              );
            } else {
              logger.warn(
                'Error de cuota: no se envió aviso porque no hay número de notificación ni fallback.',
              );
            }
          } catch (sendErr: any) {
            logger.error(
              'Error enviando notificación por error de cuota.',
              sendErr?.message || sendErr,
            );
          }

          // No responder nada al usuario final
          return '';
        }

        // Otros errores pasan al catch general de processInput
        throw err;
      }

      // Por ahora no tenemos usage_metadata directo desde LangGraph
      await this.aiCredits.trackTokens(userId, 0);

      // const finalText = this.extractReactAgentReply(result);

      // if (!finalText || !finalText.trim()) {
      //   logger.warn('Respuesta vacía del agente ReAct, usamos mensaje plano de fallback.');
      //   return 'No pude procesar tu solicitud correctamente. ¿Puedes reformular tu mensaje?';
      // }

      // return finalText;
      const finalTextRaw = this.extractReactAgentReply(result);

      if (!finalTextRaw || !finalTextRaw.trim()) {
        logger.warn(
          'Respuesta vacía del agente ReAct, usamos mensaje plano de fallback.',
        );
        return 'No pude procesar tu solicitud correctamente. ¿Puedes reformular tu mensaje?';
      }

      // CAPA A: si viene literal “Ejecuta el flujo X” => ejecutar workflow y NO responder texto raro
      const literalFlow = this.extractWorkflowNameFromLiteral(finalTextRaw);
      if (literalFlow) {
        const executed = await this.executeWorkflowByNameIfPossible({
          workflowName: literalFlow,
          userId,
          sessionId,
          server_url,
          apikey,
          instanceName,
          remoteJid,
        });

        if (executed) return '';
        // si no existe el workflow, seguimos a sanitizar (y evitamos mandar el meta-texto)
      }

      // CAPA B: sanitizar meta-salida
      const finalText = this.sanitizeOutgoingText(finalTextRaw);
      if (!finalText) {
        logger.warn(
          'OutboundGuard: salida vacía tras sanitizar. No se envía nada.',
        );
        return '';
      }

      return finalText;
    } catch (error: any) {
      const logger = this.scopedLogger({ userId, instanceName, remoteJid });

      const rawError =
        error?.response?.data || error?.message || JSON.stringify(error);
      const msgStr = rawError?.toString?.() ?? String(rawError);

      // 🔹 Detectar errores de autenticación tanto de OpenAI como de Google (Gemini)
      const isAuthError =
        msgStr.includes('Incorrect API key provided') || // OpenAI
        msgStr.includes('MODEL_AUTHENTICATION') || // OpenAI
        msgStr.includes('API key not valid') || // GoogleGenerativeAI
        msgStr.includes('API_KEY_INVALID') || // GoogleGenerativeAI ErrorInfo
        error?.status === 401;

      if (isAuthError) {
        logger.error(
          'Error de autenticación con el proveedor de IA (API Key inválida).',
          rawError,
        );

        try {
          const apiUrl = `${server_url}/message/sendText/${instanceName}`;
          const notificationPhones =
            await this.agentNotificationService.getNotificationPhones(
              userId,
              remoteJid,
            );

          if (notificationPhones.length > 0) {
            const aviso =
              '⚠️ La *APIKey* introducida en *Agente IA* es inválida o no tiene permisos. Por favor revisa e ingresa una API Key válida.\n\n' +
              '👉 https://agente.ia-app.com/profile';

            await Promise.all(
              notificationPhones.map((phone) =>
                this.nodeSenderService.sendTextNode(apiUrl, apikey, phone, aviso),
              ),
            );
          } else {
            logger.warn(
              'Error de autenticación: no se envió aviso porque no hay número de notificación configurado.',
            );
          }
        } catch (sendErr: any) {
          logger.error(
            'Error enviando notificación por API Key inválida.',
            sendErr?.message || sendErr,
          );
        }

        // No respondemos nada al usuario final
        return '';
      }

      // 🔹 Otros errores genéricos del proveedor de IA (timeout, 500, etc.)
      logger.error(
        'Error procesando entrada con el proveedor de IA.',
        rawError,
      );

      // Aquí, por ahora, NO notificamos por WhatsApp para evitar usar variables fuera de scope.
      // Si luego quieres, se puede agregar una notificación genérica similar pero con su propio bloque try/catch.

      return '';
    }
  }

  /**
   * Tool Ejecutar_Flujos (AGENTE INTERNO DE FLUJOS).
   */
  private async handleExecuteWorkflowTool(
    args: inputWorkflow,
    userId: string,
    sessionId: string,
    server_url: string,
    apikey: string,
    instanceName: string,
    remoteJid: string,
  ): Promise<string> {
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });
    logger.log('Se está ejecutando la tool Ejecutar_Flujos... 😎');

    const workflows = await this.workflowService
      .getWorkflow(userId)
      .catch(() => []);

    if (!Array.isArray(workflows) || workflows.length === 0) {
      return 'No hay flujos configurados actualmente.';
    }

    const detectionResult = await this.openAIToolDetection({
      input: args,
      sessionId,
      userId,
    });
    const raw = detectionResult.content?.toString()?.trim();

    if (!raw || raw.toLowerCase() === 'ninguno') {
      return 'Disculpa, no encontré ningún flujo relacionado a tu solicitud.';
    }

    let nombresDetectados: string[] = [];
    try {
      const parsed = JSON.parse(raw);
      nombresDetectados = parsed?.nombre_flujo || [];

      if (!Array.isArray(nombresDetectados) || nombresDetectados.length === 0) {
        return 'No se detectó ningún flujo compatible con tu solicitud.';
      }
    } catch (e: any) {
      logger.error(
        'Error al parsear el contenido JSON de OpenAI (detección de flujos)',
        e.message,
      );
      return 'Ocurrió un error interno al buscar el flujo adecuado.';
    }

    logger.log(`Flujos detectados: ${JSON.stringify(nombresDetectados)}`);

    for (const nombre of nombresDetectados) {
      const currentWorkflow = workflows.find(
        (w) => w.name?.toLowerCase?.() === nombre?.toLowerCase?.(),
      );

      if (!currentWorkflow) {
        logger.warn(`El flujo "${nombre}" no fue encontrado en BD.`);
        continue;
      }

      const alreadyExecuted =
        await this.chatHistoryService.hasIntentionBeenExecuted(
          sessionId,
          currentWorkflow.name,
        );

      if (!alreadyExecuted) {
        await this.chatHistoryService.registerExecutedIntention(
          sessionId,
          currentWorkflow.name,
          'intention',
        );

        await this.workflowService.executeWorkflow(
          currentWorkflow.name,
          server_url,
          apikey,
          instanceName,
          remoteJid,
          userId,
        );

        logger.log(
          `[Workflow]: ${currentWorkflow.name} ejecutado, registrando en sesión ${remoteJid}`,
        );

        await this.sessionService.registerWorkflow(
          { id: currentWorkflow.id, name: currentWorkflow.name },
          remoteJid,
          instanceName,
          userId,
        );

        return `Flujo *${currentWorkflow.name}* iniciado correctamente.`;
      } else {
        return `El flujo *${currentWorkflow.name}* ya fue ejecutado anteriormente en esta conversación.`;
      }
    }

    return 'No pude iniciar ningún flujo en este momento. ¿Te puedo ayudar con otra cosa?';
  }

  // Transcribe audio (usado por message-type-handler)
  async transcribeAudio(
    audioUrl: string,
    audioType: string,
    apikeyOpenAi: string,
    data: any,
    defaultModel: string,
    defaultProvider: string,
  ): Promise<string> {
    const logger = this.scopedLogger({}); // sin contexto disponible en firma
    try {
      const axiosRes = await axios.get(audioUrl, {
        responseType: 'arraybuffer',
      });
      const audioBuffer = Buffer.from(axiosRes.data);
      const base64Audio = Buffer.from(axiosRes.data).toString('base64');
      const audioStream = Readable.from(audioBuffer);
      (audioStream as any).path = 'audio.ogg';

      if (defaultProvider === 'openai') {
        // LangChain NO expone .audio.transcriptions; para Whisper usa el SDK oficial.
        const openai = new OpenAI({ apiKey: apikeyOpenAi });

        const mime = (audioType || '').toLowerCase();
        const ext = mime.includes('ogg')
          ? 'ogg'
          : mime.includes('webm')
            ? 'webm'
            : mime.includes('wav')
              ? 'wav'
              : mime.includes('mpeg') || mime.includes('mp3')
                ? 'mp3'
                : mime.includes('mp4')
                  ? 'mp4'
                  : mime.includes('m4a')
                    ? 'm4a'
                    : 'ogg';

        const file = await toFile(audioBuffer, `audio.${ext}`, {
          type: audioType || 'application/octet-stream',
        });

        const transcription = await openai.audio.transcriptions.create({
          file,
          model: 'whisper-1',
          response_format: 'text',
        });

        return transcription;
      }

      this.initializeClient(apikeyOpenAi, defaultModel, defaultProvider);

      const message = new HumanMessage({
        content: [
          {
            type: 'text',
            text: 'Transcribe de forma clara y detallada este audio.',
          },
          defaultProvider == 'openai'
            ? {
                type: 'input_audio',
                input_audio: { data: base64Audio, format: `${audioType}` },
              }
            : { type: 'media', data: base64Audio, mimeType: `${audioType}` },
        ],
      });
      const state = await this.aiClient.invoke([message]);
      return state.content.toString();
    } catch (error: any) {
      logger.error(
        'Error transcribiendo audio.',
        error?.response?.data || error.message,
      );
      logger.error(
        'Error transcribiendo audio.',
        error?.message || JSON.stringify(error, null, 2),
      );
      return '[ERROR_TRANSCRIBING_AUDIO]';
    }
  }

  // Describe imagen (usado por message-type-handler).
  async describeImage(
    data: any,
    imageBase64: string,
    imageType: string,
    apikeyOpenAi: string,
    defaultModel: string,
    defaultProvider: string,
  ): Promise<string> {
    const logger = this.scopedLogger({});
    try {
      this.initializeClient(apikeyOpenAi, defaultModel, defaultProvider);
      const message = new HumanMessage({
        content: [
          {
            type: 'text',
            text: 'Describe de forma clara y detallada el contenido de esta imagen.',
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${imageType == '' ? 'image/jpeg' : imageType};base64,${imageBase64}`,
            },
          },
        ],
      });
      const response = await this.aiClient.invoke([message]);
      return response.content.toString() ?? '[ERROR_DESCRIBING_IMAGE]';
    } catch (error: any) {
      logger.error(
        'Error describiendo imagen.',
        error?.response?.data || error.message,
      );
      return '[ERROR_DESCRIBING_IMAGE]';
    }
  }

  async classifyBoolean(args: {
    userId: string;
    systemPrompt: string;
    userJson: any;
  }): Promise<boolean> {
    const { userId, systemPrompt, userJson } = args;
    const logger = this.scopedLogger({ userId });

    try {
      const client = await this.getClientForUser(userId);

      const res = await client.invoke([
        new SystemMessage({ content: [{ type: 'text', text: systemPrompt }] }),
        new SystemMessage({
          content: [
            {
              type: 'text',
              text: 'Devuelve SOLO JSON válido: {"ok": true} o {"ok": false}. Sin texto extra.',
            },
          ],
        }),
        new HumanMessage({
          content: [{ type: 'text', text: JSON.stringify(userJson) }],
        }),
      ]);

      const content = (res?.content ?? '').toString();
      const jsonStr = content.match(/\{[\s\S]*\}/)?.[0];
      if (!jsonStr) return false;

      try {
        const parsed = JSON.parse(jsonStr);
        return parsed?.ok === true;
      } catch {
        return false;
      }
    } catch (e: any) {
      logger.warn(`classifyBoolean error: ${e?.message ?? e}`);
      return false;
    }
  }

  async generateFollowUpMessage(args: {
    userId: string;
    sessionId: string;
    goal?: string;
    customPrompt?: string;
    attempt: number;
    pushName?: string;
    registroResumen?: string;
    fallbackMessage?: string;
  }): Promise<string> {
    const {
      userId,
      sessionId,
      goal = '',
      customPrompt = '',
      attempt,
      pushName = '',
      registroResumen = '',
      fallbackMessage = '',
    } = args;
    const logger = this.scopedLogger({ userId });

    try {
      const client = await this.getClientForUser(userId);
      const systemPrompt = await this.promptService
        .getPromptUserId(userId, CRM_AGENT_PROMPT_IDS.systemPrompAI)
        .catch(() => '');
      const extraRules = await this.promptService
        .getPromptPadre('cm842kthc0000qd2l66nbnytv')
        .catch(() => '');

      const promptAI = `${extraRules} ${systemPrompt}`.trim();
      const chatHistory =
        await this.chatHistoryService.getChatHistory(sessionId);
      const recentMessages = chatHistory.slice(-12);

      const response = await client.invoke([
        new SystemMessage({ content: [{ type: 'text', text: promptAI }] }),
        new SystemMessage({
          content: [
            {
              type: 'text',
              text: 'Genera un único mensaje de seguimiento por WhatsApp. Debe sonar humano, breve, claro y orientado a retomar la conversación. No uses JSON, no expliques reglas, no menciones prompts internos ni herramientas. Máximo 3 líneas.',
            },
          ],
        }),
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                leadName: pushName,
                followUpGoal: goal,
                followUpPrompt: customPrompt,
                attempt,
                latestRegistro: registroResumen,
                recentMessages,
                fallbackMessage,
              }),
            },
          ],
        }),
      ]);

      return (response?.content ?? '').toString().trim();
    } catch (e: any) {
      logger.warn(`generateFollowUpMessage error: ${e?.message ?? e}`);
      return fallbackMessage.trim();
    }
  }
}
