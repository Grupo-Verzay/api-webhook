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

  private async getClientForUser(userId: string, temperature?: number): Promise<BaseChatModel> {
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

    // 2) API Key activa + temperatura
    const cfg = await this.prisma.userAiConfig.findFirst({
      where: { userId, isActive: true, providerId: user.defaultProviderId },
      select: { apiKey: true, temperature: true },
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
    // temperature: parámetro explícito tiene prioridad; si no, usa el del usuario; si no, 0
    const resolvedTemperature = temperature ?? cfg.temperature ?? 0;
    return this.llmClientFactory.getClient({
      provider: provider.name as any,
      apiKey: cfg.apiKey,
      model: model.name,
      temperature: resolvedTemperature,
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
      const defaultTools = this.buildHardcodedDefaultTools(params);
      defaultTools.push(this.buildMarcarDescartadoTool(params));
      return defaultTools;
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

    // Tool de sistema: siempre disponible independientemente de configs
    tools.push(this.buildMarcarDescartadoTool(params));

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
      case 'etiquetar_contacto':
        return this.buildEtiquetarContactoTool(cfg, params);
      case 'registrar_nota_seguimiento':
        return this.buildRegistrarNotaSeguimientoTool(cfg, params);
      case 'crear_recordatorio':
        return this.buildCrearRecordatorioTool(cfg, params);
      case 'buscar_plantilla':
        return this.buildBuscarPlantillaTool(cfg, params);
      case 'leer_google_sheets':
        return this.buildLeerGoogleSheetsTool(cfg, params);
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
        const normalizedCampo = campo.trim().toUpperCase();
        logger.log(`Tool "${cfg.toolKey}" (buscar_cliente_por_dato): campo="${normalizedCampo}" valor="${valor}"`);
        const data = await this.externalClientDataService.getByDataField(userId, normalizedCampo, valor);
        if (!data || Object.keys(data).length === 0) {
          return `No se encontró ningún registro con ${normalizedCampo}: ${valor} en el sistema.\n\n[INSTRUCCIÓN INTERNA — NO MOSTRAR AL USUARIO]: No encontraste este dato en la base de datos. Informa al usuario que no tienes esa información disponible. PROHIBIDO inventar, estimar o completar con conocimiento propio.`;
        }
        const formattedData = this.externalClientDataService.formatForAgent(data);
        return `${formattedData}\n\n[INSTRUCCIÓN INTERNA — NO MOSTRAR AL USUARIO]: Estos son los ÚNICOS datos válidos. Úsalos para responder al usuario con el formato que indique el sistema, pero los valores (precios, modelos, marcas, etc.) deben ser EXACTAMENTE los que aparecen arriba. PROHIBIDO usar valores distintos, inventar, estimar o dejar placeholders sin reemplazar.`;
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          campo: z.string().describe('Nombre exacto del campo (columna) por el que buscar, en mayúsculas. Ejemplos: "CEDULA-RIF", "CORREO", "NOMBRE", "MEDIDA", "SKU", "REFERENCIA".'),
          valor: z.string().describe('Valor exacto a buscar en ese campo. Ejemplos: "V27548446", "juan@email.com", "185/65R14".'),
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
          return `No se encontró ningún registro con ${cfg.searchField!.toUpperCase()}: ${valor}.\n\n[INSTRUCCIÓN INTERNA — NO MOSTRAR AL USUARIO]: No encontraste este dato en la base de datos. Informa al usuario que no tienes esa información disponible. PROHIBIDO inventar, estimar o completar con conocimiento propio.`;
        }
        const formattedData = this.externalClientDataService.formatForAgent(data);
        return `${formattedData}\n\n[INSTRUCCIÓN INTERNA — NO MOSTRAR AL USUARIO]: Estos son los ÚNICOS datos válidos. Úsalos para responder al usuario con el formato que indique el sistema, pero los valores (precios, modelos, marcas, etc.) deben ser EXACTAMENTE los que aparecen arriba. PROHIBIDO usar valores distintos, inventar, estimar o dejar placeholders sin reemplazar.`;
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
      async ({ date, serviceId }: { date: string; serviceId: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (consultar_slots_disponibles) date="${date}" serviceId="${serviceId}"`);
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

          const reminder =
            `\n\n[INSTRUCCIÓN INTERNA — NO MOSTRAR AL USUARIO]: Cuando el usuario elija un horario, llama INMEDIATAMENTE a \`crear_cita\` con:\n` +
            `  • serviceId: "${serviceId}"\n` +
            `  • startTime: copia el valor ISO UTC exacto del slot elegido (como aparece arriba)\n` +
            `  • endTime: copia el valor ISO UTC exacto de fin del slot elegido\n` +
            `Nunca confirmes la cita sin haber llamado \`crear_cita\` exitosamente.`;
          return `Horarios disponibles para el ${date} (${total}):\n${localSlots.join('\n')}${reminder}`;
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
          serviceId: z.string().describe('ID exacto (UUID) del servicio seleccionado, tal como lo devolvió listar_servicios_agenda'),
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

          const successText = message
            ? `${message} — ${confirmDate}`
            : `Cita agendada exitosamente para el ${confirmDate}.`;
          return `${successText}\n\n[INSTRUCCIÓN INTERNA — NO MOSTRAR AL USUARIO]: La cita fue registrada. Muestra SOLO el mensaje de confirmación anterior. NO agregues frases como "Recibirás un recordatorio", "¿Puedo ayudarte con algo más?" ni ningún texto adicional.`;
        } catch (err: any) {
          const errMsg = err?.response?.data?.message ?? err?.message ?? 'error desconocido';
          logger.error(`[crear_cita] Error: ${errMsg}`);
          return `No fue posible agendar la cita: ${errMsg}`;
        }
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription ||
          'OBLIGATORIO: Llama esta herramienta en el momento en que el usuario confirme o elija un horario de cita. ' +
          'Es la ÚNICA forma de registrar la cita en el sistema — sin llamarla, la cita NO existe. ' +
          'Usa el serviceId devuelto por listar_servicios_agenda y los valores ISO UTC exactos de consultar_slots_disponibles.',
        schema: z.object({
          serviceId: z.string().describe('ID del servicio seleccionado por el cliente (obtenido de listar_servicios_agenda)'),
          startTime: z.string().describe('Hora de inicio de la cita en formato ISO UTC. Ejemplo: "2025-05-20T14:00:00.000Z"'),
          endTime: z.string().describe('Hora de fin de la cita en formato ISO UTC. Ejemplo: "2025-05-20T15:00:00.000Z"'),
        }),
      },
    );
  }

  private buildEtiquetarContactoTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string;
  }): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async ({ nombre_etiqueta }: { nombre_etiqueta: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (etiquetar_contacto) llamada con: ${nombre_etiqueta}`);
        try {
          const session = await this.prisma.session.findFirst({
            where: { userId, remoteJid },
            select: { id: true },
          });
          if (!session) return 'No se encontró la sesión del contacto.';

          const slug = nombre_etiqueta
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');

          let tag = await this.prisma.tag.findFirst({ where: { userId, slug } });
          if (!tag) {
            tag = await this.prisma.tag.create({
              data: { userId, name: nombre_etiqueta.trim(), slug },
            });
          }

          await this.prisma.sessionTag.upsert({
            where: { sessionId_tagId: { sessionId: session.id, tagId: tag.id } },
            create: { sessionId: session.id, tagId: tag.id },
            update: {},
          });

          return `Etiqueta "${tag.name}" aplicada correctamente al contacto.`;
        } catch (err: any) {
          logger.error(`[etiquetar_contacto] Error: ${err?.message}`);
          return 'No se pudo aplicar la etiqueta. Intenta nuevamente.';
        }
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          nombre_etiqueta: z.string().describe('Nombre de la etiqueta a aplicar al contacto (ej: "interesado", "cliente activo", "soporte pendiente")'),
        }),
      },
    );
  }

  private buildRegistrarNotaSeguimientoTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string;
  }): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async ({ nota }: { nota: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (registrar_nota_seguimiento) llamada.`);
        try {
          const session = await this.prisma.session.findFirst({
            where: { userId, remoteJid },
            select: { id: true, seguimientos: true },
          });
          if (!session) return 'No se encontró la sesión del contacto.';

          const timestamp = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
          const nuevaNota = `[${timestamp}] ${nota}`;
          const seguimientosActualizados = session.seguimientos
            ? `${session.seguimientos}\n${nuevaNota}`
            : nuevaNota;

          await this.prisma.session.update({
            where: { id: session.id },
            data: { seguimientos: seguimientosActualizados },
          });

          return `Nota de seguimiento registrada: "${nota}"`;
        } catch (err: any) {
          logger.error(`[registrar_nota_seguimiento] Error: ${err?.message}`);
          return 'No se pudo registrar la nota. Intenta nuevamente.';
        }
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          nota: z.string().describe('Texto de la nota o seguimiento a registrar para este contacto'),
        }),
      },
    );
  }

  private buildCrearRecordatorioTool(cfg: any, params: {
    userId: string; server_url: string; apikey: string; instanceName: string; remoteJid: string; pushName: string;
  }): any {
    const { userId, server_url, apikey, instanceName, remoteJid, pushName } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async ({ titulo, descripcion, fecha_iso }: { titulo: string; descripcion?: string; fecha_iso: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (crear_recordatorio) llamada: ${titulo} para ${fecha_iso}`);
        try {
          await this.prisma.reminders.create({
            data: {
              title: titulo,
              description: descripcion ?? '',
              time: fecha_iso,
              repeatType: 'NONE' as any,
              userId,
              remoteJid,
              instanceName,
              serverUrl: server_url,
              apikey,
              pushName,
            },
          });
          return `Recordatorio "${titulo}" creado para ${fecha_iso}.`;
        } catch (err: any) {
          logger.error(`[crear_recordatorio] Error: ${err?.message}`);
          return 'No se pudo crear el recordatorio. Intenta nuevamente.';
        }
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          titulo: z.string().describe('Título del recordatorio'),
          descripcion: z.string().optional().describe('Detalle adicional del recordatorio'),
          fecha_iso: z.string().describe('Fecha y hora en formato ISO 8601 (ej: 2025-06-15T10:00:00)'),
        }),
      },
    );
  }

  private buildBuscarPlantillaTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string;
  }): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async ({ busqueda }: { busqueda: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (buscar_plantilla) llamada con: ${busqueda}`);
        try {
          const templates = await this.prisma.promptTemplate.findMany({
            where: {
              isActive: true,
              OR: [
                { name: { contains: busqueda, mode: 'insensitive' } },
                { category: { contains: busqueda, mode: 'insensitive' } },
                { description: { contains: busqueda, mode: 'insensitive' } },
              ],
            },
            take: 5,
            orderBy: { name: 'asc' },
          });
          if (!templates.length) return `No se encontraron plantillas para "${busqueda}".`;
          return `Plantillas encontradas (${templates.length}):\n\n${templates
            .map((t, i) =>
              `${i + 1}. ${t.name}${t.category ? ` [${t.category}]` : ''}\n${t.description ? `   ${t.description}\n` : ''}---\n${t.content}`,
            )
            .join('\n\n')}`;
        } catch (err: any) {
          logger.error(`[buscar_plantilla] Error: ${err?.message}`);
          return 'No se pudo buscar plantillas. Intenta nuevamente.';
        }
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          busqueda: z.string().describe('Término de búsqueda: nombre, categoría o descripción de la plantilla'),
        }),
      },
    );
  }

  private buildLeerGoogleSheetsTool(cfg: any, params: {
    userId: string;
    instanceName: string;
    remoteJid: string;
  }): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async ({ url, columna, valor }: { url: string; columna?: string; valor?: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (leer_google_sheets) llamada. url="${url}"`);
        try {
          const parsed = new URL(url);
          const pathMatch = parsed.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
          if (!pathMatch) return 'URL inválida. Usa la URL completa de Google Sheets.';

          const spreadsheetId = pathMatch[1];
          const gid = (parsed.searchParams.get('gid') ?? parsed.hash.replace('#gid=', '').trim()) || '0';
          const csvUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;

          const response = await axios.get<string>(csvUrl, { responseType: 'text', timeout: 10000 });
          const csvText = (response.data as string).replace(/^﻿/, '');

          const lines = csvText.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
          if (lines.length < 2) return 'La hoja no contiene datos o está vacía.';

          const parseRow = (line: string): string[] => {
            const result: string[] = [];
            let current = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
              const ch = line[i];
              if (ch === '"') {
                if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
                else inQuotes = !inQuotes;
              } else if (ch === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
              } else {
                current += ch;
              }
            }
            result.push(current.trim());
            return result;
          };

          const headers = parseRow(lines[0]);
          const rows = lines.slice(1)
            .map((line) => {
              const values = parseRow(line);
              return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
            })
            .filter((row) => Object.values(row).some((v) => v !== ''));

          let results = rows;
          if (columna && valor) {
            results = rows.filter((row) => {
              const key = Object.keys(row).find((k) => k.toLowerCase() === columna.toLowerCase());
              return key && row[key].toLowerCase().includes(valor.toLowerCase());
            });
          }

          if (!results.length) {
            return columna
              ? `No se encontraron filas donde "${columna}" contenga "${valor}".`
              : 'La hoja no contiene datos.';
          }

          const preview = results.slice(0, 10);
          const header = `📊 Google Sheets — ${results.length} fila(s)${results.length > 10 ? ' (mostrando primeras 10)' : ''}:\n\n`;
          const body = preview
            .map((row, i) => `${i + 1}. ${Object.entries(row).map(([k, v]) => `*${k}*: ${v}`).join(' | ')}`)
            .join('\n');

          return header + body;
        } catch (err: any) {
          logger.error(`[leer_google_sheets] Error: ${err?.message}`);
          if (err?.response?.status === 403 || err?.response?.status === 401)
            return 'Error: La hoja no es pública. Comparte como "Cualquiera con el enlace puede ver".';
          return `No se pudo leer la hoja. Verifica que sea pública. Error: ${err?.message ?? 'desconocido'}`;
        }
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          url: z.string().describe('URL completa de la hoja de Google Sheets (debe ser pública)'),
          columna: z.string().optional().describe('Nombre de columna para filtrar resultados (opcional)'),
          valor: z.string().optional().describe('Valor a buscar en la columna indicada (opcional)'),
        }),
      },
    );
  }

  /**
   * Tool de sistema siempre disponible.
   * El agente la llama cuando el usuario expresa rechazo explícito.
   * Marca el lead como DESCARTADO, desactiva el agente y cancela follow-ups pendientes.
   */
  private buildMarcarDescartadoTool(params: {
    userId: string;
    sessionId: string;
    instanceName: string;
    remoteJid: string;
  }): any {
    const { userId, sessionId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async ({ motivo }: { motivo: string }) => {
        logger.log(`Tool "Marcar_Descartado" llamada. motivo="${motivo}"`);
        const sessionIdNum = parseInt(sessionId, 10);
        if (isNaN(sessionIdNum)) return 'Error: sessionId inválido.';

        // 1. Marcar sesión como DESCARTADO y deshabilitar agente
        await this.prisma.session.update({
          where: { id: sessionIdNum },
          data: {
            leadStatus: 'DESCARTADO' as any,
            leadStatusReason: motivo.slice(0, 500),
            leadStatusUpdatedAt: new Date(),
            agentDisabled: true,
          },
        });

        // 2. Cancelar follow-ups IA (CrmFollowUp)
        const cancelledCrm = await this.prisma.crmFollowUp.updateMany({
          where: { sessionId: sessionIdNum, status: 'PENDING' as any },
          data: { status: 'CANCELLED' as any, cancelledAt: new Date() },
        });

        // 3. Cancelar seguimientos de flujos (Seguimiento) por remoteJid
        const cancelledSeg = await (this.prisma as any).seguimiento.updateMany({
          where: { remoteJid, followUpStatus: 'pending' },
          data: { followUpStatus: 'cancelled' },
        });

        // 4. Resetear estados de flujos activos (en espera de intención del usuario)
        await this.prisma.sessionWorkflowState.updateMany({
          where: { sessionId: sessionIdNum, intentionStatus: 'waiting' },
          data: { intentionStatus: 'cancelled', currentNodeId: null },
        });

        logger.log(
          `Lead DESCARTADO. CrmFollowUp: ${cancelledCrm.count}, Seguimientos flujo: ${cancelledSeg.count ?? 0}`,
        );
        return `OK: lead DESCARTADO. CrmFollowUp cancelados: ${cancelledCrm.count}, seguimientos de flujo cancelados: ${cancelledSeg.count ?? 0}.`;
      },
      {
        name: 'Marcar_Descartado',
        description:
          'Llama esta tool ÚNICAMENTE cuando el usuario exprese de forma clara que NO está interesado, rechaza el servicio/precio, o no quiere ser contactado (ej: "no me interesa", "mejor en otro momento", "muy caro", "no gracias", "en otro momento", "no me parecen los precios"). Marca al lead como DESCARTADO, desactiva el agente y cancela todos los seguimientos automáticos pendientes.',
        schema: z.object({
          motivo: z.string().describe('Razón del descarte expresada por el usuario'),
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

      if (/instrucción\s+interna/i.test(s)) return true;

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
      // Inyectar regla crítica de agendamiento si el usuario tiene tools de agenda activas
      const hasAgendaTools = toolConfigs.some(
        (c: any) =>
          ['listar_servicios_agenda', 'consultar_slots_disponibles', 'crear_cita'].includes(c.toolType) &&
          c.isEnabled,
      );
      const userForTz = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { timezone: true, mapsUrl: true, enableVoiceResponses: true, voiceInstructions: true },
      });
      const agentTz = userForTz?.timezone || 'America/Bogota';
      const nowLabel = new Intl.DateTimeFormat('es-CO', {
        timeZone: agentTz,
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      }).format(new Date());

      const agendaRuleBlock = hasAgendaTools
        ? `\n\n---\n## REGLA CRÍTICA DE AGENDAMIENTO\n**Fecha actual: ${nowLabel}** (zona horaria: ${agentTz}). Usa esta fecha como referencia cuando el usuario mencione "hoy", "mañana", "el lunes", "el 29", etc.\n\nNunca confirmes una cita al usuario sin antes haber llamado exitosamente a la herramienta \`crear_cita\` y recibido una respuesta exitosa.\n\nFlujo obligatorio:\n1. Llama \`consultar_slots_disponibles\` para obtener los horarios disponibles.\n2. Presenta los slots al usuario en hora local.\n3. Cuando el usuario elija un slot, llama \`crear_cita\` con el startTime y endTime EXACTOS devueltos por \`consultar_slots_disponibles\` (valores ISO UTC). NO los reformatees ni construyas fechas propias.\n4. Solo si \`crear_cita\` responde con éxito, confirma la cita al usuario con el mensaje de confirmación. NO agregues frases como "Recibirás un recordatorio por este medio" ni "¿Puedo ayudarte con algo más?" después de confirmar la cita.\n5. Si \`crear_cita\` falla, informa al usuario que hubo un error y ofrece otro horario.\n---`
        : '';

      const hasDataQueryTools = toolConfigs.some(
        (c: any) =>
          ['buscar_cliente_por_dato', 'search_by_field'].includes(c.toolType) &&
          c.isEnabled,
      );
      const dataQueryRuleBlock = hasDataQueryTools
        ? `\n\n---\n## REGLA CRÍTICA: CONSULTA DE DATOS\nCuando el usuario pregunte por información específica del negocio (precios, modelos, medidas, disponibilidad, datos de clientes, etc.), SIEMPRE usa la herramienta de búsqueda correspondiente ANTES de responder. NUNCA uses tu conocimiento propio o de entrenamiento para dar información de productos, precios, existencias u otros datos del catálogo. Si la herramienta no devuelve resultados, informa al usuario que no tienes esa información — NO inventes respuestas.\n---`
        : '';

      const defaultMapsUrl = 'https://maps.google.com/?q=0,0';
      const mapsBlock = userForTz?.mapsUrl && userForTz.mapsUrl.trim() !== defaultMapsUrl
        ? `\n\n---\nUBICACIÓN DEL NEGOCIO: Cuando el usuario pregunte por la dirección, ubicación o cómo llegar, comparte este enlace: ${userForTz.mapsUrl.trim()}\n---`
        : '';

      const voiceBlock = userForTz?.enableVoiceResponses
        ? `\n\n---\nNOTA INTERNA — MODO AUDIO ACTIVO: Tus respuestas se convierten a nota de voz automáticamente. Reglas de escritura para audio:\n- Escribe en lenguaje conversacional y natural, como si hablaras.\n- Usa frases cortas y directas.\n- Evita listas con guiones o asteriscos; convierte las listas en frases seguidas con comas o puntos.\n- NUNCA incluyas firma, despedida formal, nombre de la empresa al final, ni frases como "Quedo a tu disposición" o "Saludos".\n- NUNCA menciones que no puedes enviar audios ni hagas referencia a limitaciones técnicas.\n---`
        : '';

      const promptAI = `${extraRules} ${systemPrompt}${externalDataBlock}${agendaRuleBlock}${dataQueryRuleBlock}${mapsBlock}${voiceBlock}`.trim();

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

      // Sumar tokens de todos los AIMessages del resultado LangGraph
      const totalTokensUsed = (result?.messages ?? []).reduce(
        (sum: number, msg: any) => {
          const meta = msg?.usage_metadata;
          if (!meta) return sum;
          return sum + (meta.total_tokens ?? (meta.input_tokens ?? 0) + (meta.output_tokens ?? 0));
        },
        0,
      );
      await this.aiCredits.trackTokens(userId, totalTokensUsed);

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

      // CAPA C: Intent Triggers — disparadores automáticos por intención del usuario
      await this.checkAndFireIntentTriggers({
        input,
        userId,
        sessionId,
        server_url,
        apikey,
        instanceName,
        remoteJid,
      });

      return finalText;
    } catch (error: any) {
      const logger = this.scopedLogger({ userId, instanceName, remoteJid });

      const rawError =
        error?.response?.data || error?.message || JSON.stringify(error);
      const msgStr = rawError?.toString?.() ?? String(rawError);

      // 🔹 Detectar errores de autenticación tanto de OpenAI como de Google (Gemini)
      const isAuthError =
        msgStr.includes('Incorrect API key provided') || // OpenAI
        msgStr.includes('No API key provided') || // OpenAI clave vacía
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
        `Error procesando entrada con el proveedor de IA. Detalle: ${JSON.stringify(rawError)}`,
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

  private async checkAndFireIntentTriggers(params: {
    input: string;
    userId: string;
    sessionId: string;
    server_url: string;
    apikey: string;
    instanceName: string;
    remoteJid: string;
  }): Promise<void> {
    const { input, userId, sessionId, server_url, apikey, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    try {
      const triggers = await this.prisma.intentTrigger.findMany({
        where: { userId, isActive: true },
      });

      if (!triggers.length) return;

      const workflows = await this.workflowService.getWorkflow(userId).catch(() => []);

      for (const trigger of triggers) {
        let matches = false;

        if (trigger.mode === 'keywords') {
          const keywords = trigger.condition
            .split(',')
            .map((k: string) => k.trim().toLowerCase())
            .filter(Boolean);
          matches = keywords.some((kw: string) => input.toLowerCase().includes(kw));
        } else {
          matches = await this.classifyInputWithPrompt(input, trigger.condition);
        }

        if (!matches) continue;

        const workflow = Array.isArray(workflows)
          ? workflows.find((w: any) => w.id === trigger.workflowId)
          : null;

        if (!workflow) {
          logger.warn(`IntentTrigger "${trigger.name}": flujo ${trigger.workflowId} no encontrado.`);
          continue;
        }

        const alreadyExecuted = await this.chatHistoryService
          .hasIntentionBeenExecuted(sessionId, workflow.name)
          .catch(() => false);

        if (alreadyExecuted) continue;

        logger.log(`IntentTrigger "${trigger.name}" disparado → flujo "${workflow.name}"`);

        await this.chatHistoryService.registerExecutedIntention(sessionId, workflow.name, 'intent_trigger');
        await this.workflowService.executeWorkflow(workflow.name, server_url, apikey, instanceName, remoteJid, userId);
        await this.sessionService.registerWorkflow({ id: workflow.id, name: workflow.name }, remoteJid, instanceName, userId);
      }
    } catch (err: any) {
      logger.error('Error en checkAndFireIntentTriggers:', err?.message || err);
    }
  }

  private async classifyInputWithPrompt(input: string, condition: string): Promise<boolean> {
    try {
      const response = await this.aiClient.invoke([
        new SystemMessage({
          content: `Eres un clasificador. Responde ÚNICAMENTE con "SI" o "NO".\n¿El siguiente mensaje del usuario cumple con esta condición: "${condition}"?`,
        }),
        new HumanMessage({ content: input }),
      ]);
      const text = typeof response.content === 'string' ? response.content : '';
      return text.trim().toUpperCase().startsWith('SI');
    } catch {
      return false;
    }
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
      const client = await this.getClientForUser(userId, 0.5);
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
