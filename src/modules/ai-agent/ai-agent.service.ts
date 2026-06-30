import axios from 'axios';
import * as cheerio from 'cheerio';

import { Readable } from 'stream';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { CrmFollowUpStatus, LeadStatus } from '@prisma/client';
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
import { GoogleSheetsService } from '../google-sheets/google-sheets.service';

// Refactor
import { LlmClientFactory } from './services/llmClientFactory/llmClientFactory.service';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { NodeSenderService } from '../workflow/services/node-sender.service.ts/node-sender.service';
import { AgentNotificationService } from './services/notificacionService/notificacion.service';

// LangGraph + Tools
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { PrismaService } from 'src/database/prisma.service';
import { systemPromptWorkflow } from './utils/rulesPrompt';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import { CRM_AGENT_PROMPT_IDS } from '../../types/CRM_AGENT_PROMPT_IDS';
import { BASE_CHANNEL_AGENT_ID, CHANNEL_AGENT_IDS, resolveChannelKey } from '../../types/channel-agent-ids';

// Mapa código de país → timezone (prefijos más largos primero para evitar coincidencias parciales)
const COUNTRY_TZ_MAP: [string, string][] = [
  ['593', 'America/Guayaquil'],
  ['598', 'America/Montevideo'],
  ['595', 'America/Asuncion'],
  ['591', 'America/La_Paz'],
  ['507', 'America/Panama'],
  ['506', 'America/Costa_Rica'],
  ['505', 'America/Managua'],
  ['504', 'America/Tegucigalpa'],
  ['503', 'America/El_Salvador'],
  ['502', 'America/Guatemala'],
  ['58',  'America/Caracas'],
  ['57',  'America/Bogota'],
  ['56',  'America/Santiago'],
  ['55',  'America/Sao_Paulo'],
  ['54',  'America/Argentina/Buenos_Aires'],
  ['53',  'America/Havana'],
  ['52',  'America/Mexico_City'],
  ['51',  'America/Lima'],
  ['34',  'Europe/Madrid'],
  ['1',   'America/New_York'],
];

@Injectable()
export class AiAgentService {
  readonly initWorkflowName: string = 'BIENVENIDA';

  private readonly agentFailures = new Map<string, { consecutive: number; lastAlertAt: number }>();
  private readonly FAILURE_THRESHOLD = 3;
  private readonly FAILURE_ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;

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
    private readonly googleSheetsService: GoogleSheetsService,
  ) {}

  private async resolveNotifSender(
    userId: string,
    fallbackUrl: string,
    fallbackApikey: string,
  ): Promise<{ notifUrl: string; notifApikey: string }> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { ownerId: true },
      });
      if (user?.ownerId) {
        const owner = await this.prisma.user.findUnique({
          where: { id: user.ownerId },
          select: {
            apiKey: { select: { url: true } },
            instancias: {
              where: { instanceType: 'Whatsapp' },
              select: { instanceName: true, instanceId: true },
              take: 1,
            },
          },
        });
        const inst = owner?.instancias?.[0];
        const srv = owner?.apiKey?.url?.trim();
        if (inst && srv) {
          const base = srv.replace(/\/+$/, '');
          const normalizedBase = /^https?:\/\//i.test(base) ? base : `https://${base}`;
          return {
            notifUrl: `${normalizedBase}/message/sendText/${encodeURIComponent(inst.instanceName)}`,
            notifApikey: inst.instanceId,
          };
        }
      }
    } catch {
      // fallback al remitente original
    }
    return { notifUrl: fallbackUrl, notifApikey: fallbackApikey };
  }

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
    return this.llmClientFactory.getClient({
      provider,
      apiKey: apikeyOpenAi,
      model,
    });
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
   * Agente interno de detección de flujos.
   */
  private async openAIToolDetection(
    { input, sessionId, userId }: openAIToolDetection,
    client: BaseChatModel,
  ): Promise<OpenAIDetectionResult> {
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

      const responseR = await client.invoke(messagesR);

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
    client: BaseChatModel;
    directSentState?: { sent: boolean };
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

    // Busca la config de escribir_google_sheets para inyectarla en notificacion_asesor.
    // Garantiza que Google Sheets siempre se escriba cuando el agente notifique al asesor
    // sobre un comprobante, sin depender del orden en que el LLM llame las herramientas.
    const escribirSheetsCfgRaw = allConfigs.find(
      (c: any) => c.toolType === 'escribir_google_sheets' && c.isEnabled,
    );
    let _autoGoogleSheetsCfg: { spreadsheetId: string; sheetName: string } | null = null;
    if (escribirSheetsCfgRaw?.promptTemplate) {
      try {
        const _u = new URL(escribirSheetsCfgRaw.promptTemplate);
        _autoGoogleSheetsCfg = {
          spreadsheetId: _u.searchParams.get('spreadsheetId') ?? '',
          sheetName: _u.searchParams.get('sheet') ?? 'Hoja1',
        };
      } catch { /* URL inválida — sin auto-write */ }
    }

    for (const cfg of allConfigs) {
      if (!cfg.isEnabled) continue;
      if (cfg.toolType === 'auto_inject') continue; // lo maneja processInput
      if (cfg.toolType === 'client_validation') continue; // inyecta contexto en el prompt, no es una tool LangChain

      // Inyectar config de Google Sheets en notificacion_asesor para auto-write
      const enrichedCfg =
        cfg.toolType === 'notificacion_asesor' && _autoGoogleSheetsCfg
          ? { ...cfg, _googleSheetsCfg: _autoGoogleSheetsCfg }
          : cfg;

      const builtTool = this.buildToolFromConfig(enrichedCfg, params, notificationSentThisTurn);
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

  // toolTypes apropiados para una llamada de voz en tiempo real (voicebot).
  // Excluye herramientas de chat/meta (marcar_descartado, ejecutar_flujos, etc.)
  // que no aplican o serían confusas habladas. Citas, productos, cotización,
  // datos de cliente, agenda y notificación al asesor sí son útiles por voz.
  private static readonly VOICEBOT_TOOL_TYPES = new Set<string>([
    'listar_servicios_agenda',
    'consultar_slots_disponibles',
    'crear_cita',
    'listar_servicios_booking',
    'consultar_slots_booking',
    'crear_cita_booking',
    'buscar_producto',
    'listar_productos',
    'consultar_inventario',
    'crear_cotizacion',
    'buscar_cliente_por_dato',
    'consultar_datos_cliente',
    'search_by_field',
    'leer_google_sheets',
    'scrape_web',
    'crear_recordatorio',
    'notificacion_asesor',
  ]);

  /**
   * Resuelve el agentId del entrenamiento a usar para el CANAL de este mensaje.
   * Mira la instancia (instanceType + metaChannel) y devuelve el agentId del canal
   * SOLO si existe un AgentPrompt propio para él; si no, cae al base (WhatsApp QR).
   */
  private async resolveChannelPromptAgentId(userId: string, instanceName: string): Promise<string> {
    if (!instanceName) return BASE_CHANNEL_AGENT_ID;
    try {
      const inst = await this.prisma.instancia.findFirst({
        where: { instanceName },
        select: { instanceType: true, metaChannel: true },
      });
      const key = resolveChannelKey(inst?.instanceType, inst?.metaChannel);
      const channelAgentId = CHANNEL_AGENT_IDS[key];
      if (channelAgentId === BASE_CHANNEL_AGENT_ID) return BASE_CHANNEL_AGENT_ID;
      const count = await this.prisma.agentPrompt.count({
        where: { userId, agentId: channelAgentId },
      });
      return count > 0 ? channelAgentId : BASE_CHANNEL_AGENT_ID;
    } catch {
      return BASE_CHANNEL_AGENT_ID;
    }
  }

  /** Deriva server_url/apikey/instanceName de WhatsApp de la cuenta (como el webhook). */
  private async resolveInstanceCreds(
    userId: string,
  ): Promise<{ server_url: string; apikey: string; instanceName: string } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        apiKey: { select: { url: true } },
        instancias: {
          where: { instanceType: 'Whatsapp' },
          select: { instanceName: true, instanceId: true },
          take: 1,
        },
      },
    });
    const inst = user?.instancias?.[0];
    const url = user?.apiKey?.url?.trim();
    if (!inst || !url) return null;
    const base = (/^https?:\/\//i.test(url) ? url : `https://${url}`).replace(/\/+$/, '');
    return { server_url: base, apikey: inst.instanceId, instanceName: inst.instanceName };
  }

  /**
   * Puente para el VOICEBOT: arma las MISMAS herramientas habilitadas de la cuenta
   * (según permisos/config) en formato OpenAI Realtime, y devuelve un `invoke` que
   * las ejecuta (reusando la lógica del agente de chat: citas reales, productos,
   * cotizaciones, etc.). Best-effort: ante cualquier fallo devuelve sin herramientas.
   */
  async buildVoicebotToolset(
    userId: string,
    remoteJid: string,
    pushName: string,
  ): Promise<{ defs: any[]; invoke: (name: string, argsJson: string) => Promise<string> }> {
    const empty = { defs: [] as any[], invoke: async () => 'Acción no disponible.' };
    try {
      const creds = await this.resolveInstanceCreds(userId);
      if (!creds) return empty;
      const client = await this.getClientForUser(userId).catch(() => null);
      if (!client) return empty;
      const allConfigs = await this.externalClientDataService
        .getToolConfigs(userId)
        .catch(() => [] as any[]);

      const params = {
        userId,
        sessionId: '',
        server_url: creds.server_url,
        apikey: creds.apikey,
        instanceName: creds.instanceName,
        remoteJid,
        pushName: pushName ?? '',
        client,
      };

      const notif = { value: false };
      const byName = new Map<string, any>();
      const defs: any[] = [];
      for (const cfg of allConfigs) {
        if (!cfg?.isEnabled) continue;
        if (!AiAgentService.VOICEBOT_TOOL_TYPES.has(cfg.toolType)) continue;
        const t = this.buildToolFromConfig(cfg, params as any, notif);
        if (!t || !t.name) continue;
        byName.set(t.name, t);
        try {
          const oa: any = convertToOpenAITool(t);
          if (oa?.function?.name) {
            defs.push({
              type: 'function',
              name: oa.function.name,
              description: oa.function.description ?? '',
              parameters: oa.function.parameters ?? { type: 'object', properties: {} },
            });
          }
        } catch {
          /* esquema no convertible — omitir esa tool */
        }
      }

      const invoke = async (name: string, argsJson: string): Promise<string> => {
        const t = byName.get(name);
        if (!t) return 'Acción no disponible.';
        let args: any = {};
        try { args = JSON.parse(argsJson || '{}'); } catch { /* args vacíos */ }
        try {
          const r = await t.invoke(args);
          return typeof r === 'string' ? r : JSON.stringify(r);
        } catch (e: any) {
          this.scopedLogger({ userId, instanceName: creds.instanceName, remoteJid }).warn(
            `[voicebot] tool "${name}" falló: ${e?.message ?? e}`,
          );
          return 'No pude completar esa acción en este momento.';
        }
      };

      return { defs, invoke };
    } catch {
      return empty;
    }
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
    client: BaseChatModel;
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
      case 'listar_servicios_booking':
        return this.buildListarServiciosBookingTool(cfg, params);
      case 'consultar_slots_booking':
        return this.buildConsultarSlotsBookingTool(cfg, params);
      case 'crear_cita_booking':
        return this.buildCrearCitaBookingTool(cfg, params);
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
      case 'escribir_google_sheets':
        return this.buildEscribirGoogleSheetsTool(cfg, params);
      case 'editar_google_sheets':
        return this.buildEditarGoogleSheetsTool(cfg, params);
      case 'scrape_web':
        return this.buildScrapeWebTool(cfg, params);
      case 'consultar_inventario':
        return this.buildConsultarInventarioTool(cfg, params);
      case 'crear_cotizacion':
        return this.buildCrearCotizacionTool(cfg, params);
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
    const googleSheetsCfg: { spreadsheetId: string; sheetName: string } | null = cfg._googleSheetsCfg ?? null;

    // @ts-ignore - evitar problemas de tipos profundos con LangChain + zod
    return tool(
      async ({ nombre, detalles, cedula, banco, referencia, monto, fecha, sinpe_transid, estado }) => {
        if (notificationSentThisTurn?.value) {
          logger.warn(
            `[NOTIF_DEDUPE] Tool "${cfg.toolKey}" omitida: ya se envió una notificación en este turno del agente.`,
          );
          return `Notificación ya enviada en este turno. Sin duplicado para "${nombre}".`;
        }
        logger.log(`Tool "${cfg.toolKey}" (notificacion_asesor) llamada para: ${nombre}`);

        // ── AUTO-WRITE Google Sheets ────────────────────────────────────────
        // Dispara si hay campos estructurados de pago O si detalles/nombre mencionan
        // palabras clave de comprobante (cubre el caso de imagen procesada por OCR).
        const _paymentKeywords = /comprobante|sinpe|transferencia|dep[oó]sito|banco|monto|recibo|pago/i;
        const _isPayment = !!(monto || referencia || sinpe_transid) ||
          _paymentKeywords.test(detalles ?? '') ||
          _paymentKeywords.test(nombre ?? '');
        if (googleSheetsCfg?.spreadsheetId && _isPayment) {
          try {
            const datos: Record<string, string> = {
              WHATSAPP: remoteJid.split('@')[0],
              NOMBRE: nombre,
              DESCRIPCION: detalles,
              ESTADO: estado ?? 'Pendiente',
            };
            if (cedula) datos['CEDULA'] = cedula;
            if (banco) datos['BANCO'] = banco;
            if (referencia) datos['REFERENCIA'] = referencia;
            if (monto) datos['MONTO'] = monto;
            if (fecha) datos['FECHA'] = fecha;
            if (sinpe_transid) datos['SINPE_TRANSID'] = sinpe_transid;

            const sheetResult = await this.googleSheetsService.appendRow(
              googleSheetsCfg.spreadsheetId,
              googleSheetsCfg.sheetName,
              datos,
            );
            logger.log(
              `[AUTO-SHEETS] Comprobante guardado en "${googleSheetsCfg.sheetName}" via notificacion_asesor: ${sheetResult.success ? '✅' : '❌ ' + sheetResult.error}`,
            );
          } catch (err: any) {
            logger.error(`[AUTO-SHEETS] Error escribiendo Google Sheets: ${err?.message}`, 'buildNotificacionAsesorTool');
          }
        }

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
          nombre: z.string().describe('Nombre completo del cliente'),
          detalles: z.string().describe('Descripción completa del comprobante o solicitud'),
          cedula: z.string().optional().describe('Cédula o identificación del cliente (solo comprobantes de pago)'),
          banco: z.string().optional().describe('Banco emisor del pago (solo comprobantes de pago)'),
          referencia: z.string().optional().describe('Número de referencia o confirmación del pago'),
          monto: z.string().optional().describe('Monto del pago con símbolo de moneda (solo comprobantes de pago)'),
          fecha: z.string().optional().describe('Fecha del comprobante de pago'),
          sinpe_transid: z.string().optional().describe('ID de transacción SINPE móvil'),
          estado: z.string().optional().describe('Estado del pago: Pendiente, Verificado, Rechazado'),
        }),
      },
    );
  }

  private buildEjecutarFlujosTool(cfg: any, params: {
    userId: string; sessionId: string; server_url: string;
    apikey: string; instanceName: string; remoteJid: string;
    client: BaseChatModel;
  }, notificationSentThisTurn?: { value: boolean }): any {
    const { userId, sessionId, server_url, apikey, instanceName, remoteJid, client } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async ({ nombre_flujo, detalles }: { nombre_flujo: string; detalles: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (ejecutar_flujos) → "${nombre_flujo}"`);
        const follow = await this.handleExecuteWorkflowTool(
          { nombre_flujo: [nombre_flujo], descripcion: detalles } as any,
          userId, sessionId, server_url, apikey, instanceName, remoteJid, client,
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
        const rows = await this.externalClientDataService.getByDataField(userId, normalizedCampo, valor);
        if (!rows.length) {
          return `No se encontró ningún registro con ${normalizedCampo}: ${valor} en el sistema.\n\n[INSTRUCCIÓN INTERNA — NO MOSTRAR AL USUARIO]: No encontraste este dato en la base de datos. Informa al usuario que no tienes esa información disponible. PROHIBIDO inventar, estimar o completar con conocimiento propio.`;
        }
        const formattedData = rows.map((r) => this.externalClientDataService.formatForAgent(r)).join('\n');
        return `${formattedData}\n\n[INSTRUCCIÓN INTERNA — NO MOSTRAR AL USUARIO]: Estos son los ÚNICOS datos válidos (${rows.length} registro(s)). Úsalos para responder al usuario con el formato que indique el sistema, pero los valores (precios, modelos, marcas, etc.) deben ser EXACTAMENTE los que aparecen arriba. PROHIBIDO usar valores distintos, inventar, estimar o dejar placeholders sin reemplazar.`;
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
        const rows = await this.externalClientDataService.getByDataField(userId, cfg.searchField!, valor);
        if (!rows.length) {
          return `No se encontró ningún registro con ${cfg.searchField!.toUpperCase()}: ${valor}.\n\n[INSTRUCCIÓN INTERNA — NO MOSTRAR AL USUARIO]: No encontraste este dato en la base de datos. Informa al usuario que no tienes esa información disponible. PROHIBIDO inventar, estimar o completar con conocimiento propio.`;
        }
        const formattedData = rows.map((r) => this.externalClientDataService.formatForAgent(r)).join('\n');
        return `${formattedData}\n\n[INSTRUCCIÓN INTERNA — NO MOSTRAR AL USUARIO]: Estos son los ÚNICOS datos válidos (${rows.length} registro(s)). Úsalos para responder al usuario con el formato que indique el sistema, pero los valores (precios, modelos, marcas, etc.) deben ser EXACTAMENTE los que aparecen arriba. PROHIBIDO usar valores distintos, inventar, estimar o dejar placeholders sin reemplazar.`;
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
          if (query) {
            const tokens = query.trim().split(/\s+/).filter(Boolean);
            if (tokens.length <= 1) {
              where.title = { contains: query.trim(), mode: 'insensitive' };
            } else {
              where.AND = tokens.map((t) => ({ title: { contains: t, mode: 'insensitive' } }));
            }
          }
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

  private buildConsultarInventarioTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string;
  }): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async ({ producto }: { producto?: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (consultar_inventario): producto="${producto ?? 'todos'}"`);
        const where: any = { userId, isActive: true };
        if (producto?.trim()) where.title = { contains: producto.trim(), mode: 'insensitive' };

        const products = await this.prisma.product.findMany({ where, orderBy: { title: 'asc' } });
        if (products.length === 0) return 'No se encontraron productos en el inventario.';

        const lines = products.map((p) =>
          `• ${p.title}${p.sku ? ` [SKU: ${p.sku}]` : ''} — Precio: $${Number(p.price).toLocaleString('es-CO')} — Stock: ${p.stock > 0 ? p.stock : '⚠️ Sin stock'}`,
        );
        return `Inventario (${products.length} producto${products.length !== 1 ? 's' : ''}):\n${lines.join('\n')}`;
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          producto: z.string().optional().describe('Nombre o parte del nombre del producto a consultar. Si se omite, devuelve todo el inventario.'),
        }),
      },
    );
  }

  private buildCrearCotizacionTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string; pushName: string;
  }): any {
    const { userId, instanceName, remoteJid, pushName } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async ({ clientName, items }: { clientName: string; items: Array<{ titulo: string; cantidad: number; precioUnitario: number }> }) => {
        logger.log(`Tool "${cfg.toolKey}" (crear_cotizacion): cliente="${clientName}" ítems=${items.length}`);
        if (!clientName?.trim() || !Array.isArray(items) || items.length === 0) {
          return 'Faltan datos para crear la cotización (clientName e items son requeridos).';
        }

        const cotizacionItems = items.map((i) => ({
          title: i.titulo?.trim() ?? 'Ítem',
          quantity: Math.max(1, Number(i.cantidad) || 1),
          unitPrice: Math.max(0, Number(i.precioUnitario) || 0),
          subtotal: Math.max(0, (Number(i.precioUnitario) || 0) * Math.max(1, Number(i.cantidad) || 1)),
        }));

        const total = cotizacionItems.reduce((s, i) => s + i.subtotal, 0);

        await this.prisma.cotizacion.create({
          data: {
            userId,
            clientName: clientName.trim(),
            status: 'borrador',
            total,
            items: { create: cotizacionItems },
          },
        });

        const resumen = cotizacionItems
          .map((i) => `  • ${i.title} x${i.quantity} = $${i.subtotal.toLocaleString('es-CO')}`)
          .join('\n');
        return `Cotización creada para *${clientName.trim()}*:\n${resumen}\n*Total: $${total.toLocaleString('es-CO')}*\n\nPuedes verla en la sección Cotizaciones de la app.`;
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          clientName: z.string().describe('Nombre del cliente para la cotización'),
          items: z.array(z.object({
            titulo: z.string().describe('Nombre o descripción del producto/servicio'),
            cantidad: z.number().describe('Cantidad de unidades'),
            precioUnitario: z.number().describe('Precio unitario'),
          })).describe('Lista de productos/servicios a cotizar'),
        }),
      },
    );
  }

  // ─── Agenda / citas ──────────────────────────────────────────────────────

  private getClientTimezone(remoteJid: string, fallback: string): string {
    const digits = (remoteJid ?? '').split('@')[0].replace(/\D/g, '');
    for (const [prefix, tz] of COUNTRY_TZ_MAP) {
      if (digits.startsWith(prefix)) return tz;
    }
    return fallback;
  }

  /**
   * Parsea expresiones de hora en español/inglés y devuelve { hour, minute }.
   * Maneja: "10", "10 am", "10:30", "10:00 am", "diez", "diez y media", etc.
   */
  private parseLocalHourFromInput(input: string): { hour: number; minute: number } | null {
    const s = (input ?? '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/^(a las?|las?)\s+/, '')
      .trim();

    const WORD_HOURS: Record<string, number> = {
      'medianoche': 0, 'una': 1, 'dos': 2, 'tres': 3, 'cuatro': 4,
      'cinco': 5, 'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9,
      'diez': 10, 'once': 11, 'doce': 12, 'mediodia': 12,
    };

    for (const [word, h] of Object.entries(WORD_HOURS)) {
      if (s.startsWith(word)) {
        const rest = s.slice(word.length).trim();
        const isPm = /pm|tarde|noche/.test(rest);
        const minute = /y media/.test(rest) ? 30 : /y cuarto/.test(rest) ? 15 : 0;
        let hour = h;
        if (isPm && hour > 0 && hour < 12) hour += 12;
        return { hour, minute };
      }
    }

    // "10", "10:30", "10:00 am", "10am", "10 pm"
    const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (m) {
      let hour = parseInt(m[1], 10);
      const minute = parseInt(m[2] ?? '0', 10);
      const ampm = m[3];
      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;
      return { hour, minute };
    }

    return null;
  }

  /**
   * Dado un tiempo informal ("10 am", "diez") y una fecha YYYY-MM-DD,
   * busca en los slots disponibles aquel cuya hora local coincide y devuelve sus ISO UTC.
   */
  private async resolveSlotByTimeExpression(
    userId: string,
    date: string,
    timeExpr: string,
    timezone: string,
    nextjsUrl: string,
    runnerKey: string,
  ): Promise<{ startTime: string; endTime: string } | null> {
    const parsed = this.parseLocalHourFromInput(timeExpr);
    if (!parsed) return null;

    let slots: any[] = [];
    try {
      const res = await axios.get(
        `${nextjsUrl}/api/schedule/slots?userId=${encodeURIComponent(userId)}&date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(timezone)}`,
        { headers: { Authorization: `Bearer ${runnerKey}` } },
      );
      slots = res.data?.slots ?? [];
    } catch {
      return null;
    }

    return (
      slots.find((s: any) => {
        const d = new Date(s.startTime);
        const localH = parseInt(
          d.toLocaleString('en-US', { timeZone: timezone, hour: '2-digit', hour12: false }),
          10,
        );
        const localM = parseInt(
          d.toLocaleString('en-US', { timeZone: timezone, minute: '2-digit' }),
          10,
        );
        return localH === parsed.hour && localM === parsed.minute;
      }) ?? null
    );
  }

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
              `${i + 1}. [serviceId="${s.id}"] ${s.name}${s.description ? ` — ${s.description}` : ''}`,
            )
            .join('\n');
          return `Servicios disponibles (${total}):\n${list}\n\n⚠️ IMPORTANTE: Usa el valor exacto de serviceId (entre comillas) al llamar consultar_slots_disponibles y crear_cita. NO inventes ni modifiques el ID.`;
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

          // Mostrar horarios en la zona horaria del CLIENTE (detectada por código de país)
          const clientTz = this.getClientTimezone(remoteJid, timezone);
          const tzCity = clientTz.split('/').pop()?.replace(/_/g, ' ') ?? clientTz;
          const localSlots = slots.map((s: any, i: number) => {
            const start = new Date(s.startTime).toLocaleTimeString('es-CO', {
              timeZone: clientTz,
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
            const end = new Date(s.endTime).toLocaleTimeString('es-CO', {
              timeZone: clientTz,
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
            return `• [${i + 1}] ${start} – ${end} (hora ${tzCity})  startTime="${s.startTime}" endTime="${s.endTime}"`;
          });

          const reminder =
            `\n\n[INSTRUCCIÓN INTERNA — NO MOSTRAR AL USUARIO]\n` +
            `Cuando el usuario confirme o elija un horario, llama INMEDIATAMENTE a \`crear_cita\` con:\n` +
            `  • serviceId: "${serviceId}"\n` +
            `  • date: "${date}"\n` +
            `  • startTime: el valor startTime del slot elegido tal como aparece arriba entre comillas.\n` +
            `  • endTime: el valor endTime del slot elegido tal como aparece arriba entre comillas.\n` +
            `RECONOCIMIENTO DE HORA DEL USUARIO:\n` +
            `  — Si dice "10", "10 am", "10:00", "las 10", "diez" → es el slot con hora 10:00 a.m.\n` +
            `  — Si dice "el primero", "opción 1", "1" → es el slot [1]\n` +
            `  — Si dice "el segundo", "opción 2", "2" → es el slot [2]\n` +
            `  — Si dice una hora que coincide con un slot, usa ese slot.\n` +
            `Si no estás 100% seguro del ISO, pasa startTime como la hora que dijo el usuario (ej: "10 am") ` +
            `y el campo date="${date}" — el sistema lo resolverá automáticamente.\n` +
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
      async ({ serviceId, startTime, endTime, date }: { serviceId: string; startTime: string; endTime?: string; date?: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (crear_cita) serviceId="${serviceId}" startTime="${startTime}" date="${date ?? '—'}"`);
        try {
          const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { timezone: true },
          });
          const timezone = user?.timezone || 'UTC';

          const isIso = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s);

          let resolvedStart = startTime;
          let resolvedEnd = endTime ?? '';

          // Si startTime no es ISO UTC, intentar resolver el slot por expresión de hora informal
          if (!isIso(startTime) || !isIso(endTime)) {
            const slotDate =
              date ??
              (isIso(startTime) ? startTime.slice(0, 10) : undefined);

            if (slotDate) {
              logger.log(`[crear_cita] startTime no es ISO, resolviendo "${startTime}" para fecha "${slotDate}"`);
              const slot = await this.resolveSlotByTimeExpression(
                userId, slotDate, startTime, timezone, nextjsUrl, runnerKey,
              );
              if (slot) {
                resolvedStart = slot.startTime;
                resolvedEnd = slot.endTime;
                logger.log(`[crear_cita] Slot resuelto: startTime="${resolvedStart}"`);
              } else {
                return (
                  `No encontré un horario disponible que coincida con "${startTime}" para el ${slotDate}. ` +
                  `Muestra los horarios con consultar_slots_disponibles y pide al usuario que elija uno.`
                );
              }
            } else {
              return (
                `Necesito saber la fecha para resolver "${startTime}". ` +
                `Llama primero a consultar_slots_disponibles para obtener los horarios del día.`
              );
            }
          }

          const res = await axios.post(
            `${nextjsUrl}/api/schedule/appointment`,
            {
              userId,
              serviceId,
              pushName,
              phone: remoteJid,
              instanceName,
              startTime: resolvedStart,
              endTime: resolvedEnd,
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
          // Confirmación en timezone del CLIENTE (detectada por código de país)
          const clientTz = this.getClientTimezone(remoteJid, timezone);
          const tzCity = clientTz.split('/').pop()?.replace(/_/g, ' ') ?? clientTz;
          const confirmDate = appointment?.startTime
            ? `${new Date(appointment.startTime).toLocaleString('es-CO', {
                timeZone: clientTz,
                dateStyle: 'full',
                timeStyle: 'short',
              })} (hora ${tzCity})`
            : resolvedStart;

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
          'OBLIGATORIO: Llama esta herramienta cuando el usuario confirme o elija un horario de cita. ' +
          'Es la ÚNICA forma de registrar la cita — sin llamarla, la cita NO existe. ' +
          'Usa el serviceId de listar_servicios_agenda y los valores startTime/endTime de consultar_slots_disponibles. ' +
          'Si el usuario dice una hora informal ("10 am", "diez", "10:00"), pásala en startTime junto con date.',
        schema: z.object({
          serviceId: z.string().describe('ID del servicio (de listar_servicios_agenda)'),
          startTime: z.string().describe(
            'Hora de inicio: ISO UTC ("2025-05-20T14:00:00.000Z") o expresión informal ("10 am", "10:00", "diez"). ' +
            'Si es expresión informal, incluye también el campo date.',
          ),
          endTime: z.string().optional().describe(
            'Hora de fin ISO UTC. Puede omitirse si startTime es expresión informal (se resuelve automáticamente).',
          ),
          date: z.string().optional().describe(
            'Fecha en formato YYYY-MM-DD (ej: "2025-05-20"). Requerida cuando startTime no es ISO UTC.',
          ),
        }),
      },
    );
  }

  private buildListarServiciosBookingTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string;
  }): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });
    const nextjsUrl = (process.env.NEXTJS_URL ?? '').replace(/\/+$/, '');
    const runnerKey = process.env.CRM_FOLLOW_UP_RUNNER_KEY ?? '';

    // @ts-ignore
    return tool(
      async () => {
        logger.log(`Tool "${cfg.toolKey}" (listar_servicios_booking) llamada.`);
        try {
          const res = await axios.get(
            `${nextjsUrl}/api/bookings/services?userId=${encodeURIComponent(userId)}`,
            { headers: { Authorization: `Bearer ${runnerKey}` } },
          );
          const { services = [], total = 0, teamName = '' } = res.data ?? {};
          if (!Array.isArray(services) || services.length === 0) {
            return 'No hay servicios de reserva configurados en este momento.';
          }
          const list = services
            .map((s: any, i: number) => {
              const memberNames = s.members?.map((m: any) => m.name).join(', ') ?? '';
              const membersText = memberNames ? ` — Especialistas: ${memberNames}` : '';
              return `${i + 1}. [serviceId="${s.id}"] ${s.name} (${s.duration} min)${s.description ? ` — ${s.description}` : ''}${membersText}`;
            })
            .join('\n');
          const header = teamName ? `Servicios disponibles en ${teamName} (${total}):\n` : `Servicios disponibles (${total}):\n`;
          return `${header}${list}\n\n⚠️ IMPORTANTE: Usa el valor exacto de serviceId (entre comillas) al llamar consultar_slots_booking y crear_cita_booking. NO inventes ni modifiques el ID.`;
        } catch (err: any) {
          logger.error(`[listar_servicios_booking] Error: ${err?.message}`);
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

  private buildConsultarSlotsBookingTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string;
  }): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });
    const nextjsUrl = (process.env.NEXTJS_URL ?? '').replace(/\/+$/, '');
    const runnerKey = process.env.CRM_FOLLOW_UP_RUNNER_KEY ?? '';

    // @ts-ignore
    return tool(
      async ({ date, serviceId, memberId }: { date: string; serviceId: string; memberId?: string }) => {
        logger.log(`Tool "${cfg.toolKey}" (consultar_slots_booking) date="${date}" serviceId="${serviceId}" memberId="${memberId ?? '—'}"`);
        try {
          const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { timezone: true },
          });
          const timezone = user?.timezone || 'UTC';

          let url =
            `${nextjsUrl}/api/bookings/slots?userId=${encodeURIComponent(userId)}` +
            `&serviceId=${encodeURIComponent(serviceId)}&date=${encodeURIComponent(date)}`;
          if (memberId) url += `&memberId=${encodeURIComponent(memberId)}`;

          const res = await axios.get(url, { headers: { Authorization: `Bearer ${runnerKey}` } });
          const { slots = [], total = 0, serviceName = '' } = res.data ?? {};

          if (!Array.isArray(slots) || slots.length === 0) {
            return `No hay horarios disponibles para el ${date}${serviceName ? ` (${serviceName})` : ''}.`;
          }

          const clientTz = this.getClientTimezone(remoteJid, timezone);
          const tzCity = clientTz.split('/').pop()?.replace(/_/g, ' ') ?? clientTz;
          const localSlots = slots.map((s: any, i: number) => {
            const start = new Date(s.startTime).toLocaleTimeString('es-CO', {
              timeZone: clientTz, hour: '2-digit', minute: '2-digit', hour12: true,
            });
            const end = new Date(s.endTime).toLocaleTimeString('es-CO', {
              timeZone: clientTz, hour: '2-digit', minute: '2-digit', hour12: true,
            });
            const specialist = s.memberName ? ` [Especialista: ${s.memberName}]` : '';
            return `• [${i + 1}] ${start} – ${end} (hora ${tzCity})${specialist}  startTime="${s.startTime}" endTime="${s.endTime}" memberId="${s.memberId}"`;
          });

          const reminder =
            `\n\n[INSTRUCCIÓN INTERNA — NO MOSTRAR AL USUARIO]\n` +
            `Cuando el usuario confirme o elija un horario, llama INMEDIATAMENTE a \`crear_cita_booking\` con:\n` +
            `  • serviceId: "${serviceId}"\n` +
            `  • date: "${date}"\n` +
            `  • startTime: el valor startTime del slot elegido tal como aparece arriba entre comillas.\n` +
            `  • endTime: el valor endTime del slot elegido tal como aparece arriba entre comillas.\n` +
            `  • memberId: el valor memberId del slot elegido tal como aparece arriba entre comillas.\n` +
            `RECONOCIMIENTO DE HORA DEL USUARIO:\n` +
            `  — Si dice "10", "10 am", "10:00", "las 10", "diez" → es el slot con hora 10:00 a.m.\n` +
            `  — Si dice "el primero", "opción 1", "1" → es el slot [1]\n` +
            `  — Si dice "el segundo", "opción 2", "2" → es el slot [2]\n` +
            `  — Si dice una hora que coincide con un slot, usa ese slot.\n` +
            `Nunca confirmes la cita sin haber llamado \`crear_cita_booking\` exitosamente.`;
          return `Horarios disponibles para el ${date}${serviceName ? ` (${serviceName})` : ''} (${total}):\n${localSlots.join('\n')}${reminder}`;
        } catch (err: any) {
          logger.error(`[consultar_slots_booking] Error: ${err?.message}`);
          return 'No fue posible consultar los horarios disponibles. Inténtalo más tarde.';
        }
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          date: z.string().describe('Fecha a consultar en formato YYYY-MM-DD. Ejemplo: "2025-05-20"'),
          serviceId: z.string().describe('ID exacto (UUID) del servicio seleccionado, tal como lo devolvió listar_servicios_booking'),
          memberId: z.string().optional().describe('ID del especialista para filtrar slots. Opcional; si se omite, muestra slots de todos los especialistas del servicio.'),
        }),
      },
    );
  }

  private buildCrearCitaBookingTool(cfg: any, params: {
    userId: string; instanceName: string; remoteJid: string; pushName: string;
  }): any {
    const { userId, instanceName, remoteJid, pushName } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });
    const nextjsUrl = (process.env.NEXTJS_URL ?? '').replace(/\/+$/, '');
    const runnerKey = process.env.CRM_FOLLOW_UP_RUNNER_KEY ?? '';

    // @ts-ignore
    return tool(
      async ({ serviceId, startTime, endTime, memberId, date }: {
        serviceId: string; startTime: string; endTime?: string; memberId?: string; date?: string;
      }) => {
        logger.log(`Tool "${cfg.toolKey}" (crear_cita_booking) serviceId="${serviceId}" startTime="${startTime}" memberId="${memberId ?? '—'}" date="${date ?? '—'}"`);
        try {
          const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { timezone: true },
          });
          const timezone = user?.timezone || 'UTC';

          const isIso = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s);

          let resolvedStart = startTime;
          let resolvedEnd = endTime ?? '';
          let resolvedMemberId = memberId ?? '';

          if (!isIso(startTime) || !isIso(endTime)) {
            const slotDate = date ?? (isIso(startTime) ? startTime.slice(0, 10) : undefined);
            if (slotDate) {
              logger.log(`[crear_cita_booking] Resolviendo slot informal "${startTime}" para fecha "${slotDate}"`);
              const parsed = this.parseLocalHourFromInput(startTime);
              if (parsed) {
                try {
                  let slotUrl =
                    `${nextjsUrl}/api/bookings/slots?userId=${encodeURIComponent(userId)}` +
                    `&serviceId=${encodeURIComponent(serviceId)}&date=${encodeURIComponent(slotDate)}`;
                  if (resolvedMemberId) slotUrl += `&memberId=${encodeURIComponent(resolvedMemberId)}`;
                  const slotRes = await axios.get(slotUrl, { headers: { Authorization: `Bearer ${runnerKey}` } });
                  const slots: any[] = slotRes.data?.slots ?? [];
                  const matched = slots.find((s: any) => {
                    const d = new Date(s.startTime);
                    const localH = parseInt(d.toLocaleString('en-US', { timeZone: timezone, hour: '2-digit', hour12: false }), 10);
                    const localM = parseInt(d.toLocaleString('en-US', { timeZone: timezone, minute: '2-digit' }), 10);
                    return localH === parsed.hour && localM === parsed.minute;
                  }) ?? null;
                  if (matched) {
                    resolvedStart = matched.startTime;
                    resolvedEnd = matched.endTime;
                    if (!resolvedMemberId && matched.memberId) resolvedMemberId = matched.memberId;
                  } else {
                    return (
                      `No encontré un horario disponible que coincida con "${startTime}" para el ${slotDate}. ` +
                      `Muestra los horarios con consultar_slots_booking y pide al usuario que elija uno.`
                    );
                  }
                } catch {
                  return (
                    `No encontré un horario disponible que coincida con "${startTime}". ` +
                    `Muestra los horarios con consultar_slots_booking y pide al usuario que elija uno.`
                  );
                }
              } else {
                return (
                  `Necesito saber la fecha para resolver "${startTime}". ` +
                  `Llama primero a consultar_slots_booking para obtener los horarios del día.`
                );
              }
            } else {
              return (
                `Necesito saber la fecha para resolver "${startTime}". ` +
                `Llama primero a consultar_slots_booking para obtener los horarios del día.`
              );
            }
          }

          const body: Record<string, string> = {
            userId, serviceId, pushName, phone: remoteJid, instanceName,
            startTime: resolvedStart, endTime: resolvedEnd, timezone,
          };
          if (resolvedMemberId) body.memberId = resolvedMemberId;

          const res = await axios.post(
            `${nextjsUrl}/api/bookings/appointment`,
            body,
            { headers: { Authorization: `Bearer ${runnerKey}`, 'Content-Type': 'application/json' } },
          );

          const { message, appointment } = res.data ?? {};
          const clientTz = this.getClientTimezone(remoteJid, timezone);
          const tzCity = clientTz.split('/').pop()?.replace(/_/g, ' ') ?? clientTz;
          const confirmDate = appointment?.startTime
            ? `${new Date(appointment.startTime).toLocaleString('es-CO', {
                timeZone: clientTz, dateStyle: 'full', timeStyle: 'short',
              })} (hora ${tzCity})`
            : resolvedStart;

          const successText = message
            ? `${message} — ${confirmDate}`
            : `Cita agendada exitosamente para el ${confirmDate}.`;
          return `${successText}\n\n[INSTRUCCIÓN INTERNA — NO MOSTRAR AL USUARIO]: La cita fue registrada. Muestra SOLO el mensaje de confirmación anterior. NO agregues frases adicionales.`;
        } catch (err: any) {
          const errMsg = err?.response?.data?.error ?? err?.response?.data?.message ?? err?.message ?? 'error desconocido';
          logger.error(`[crear_cita_booking] Error: ${errMsg}`);
          return `No fue posible agendar la cita: ${errMsg}`;
        }
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription ||
          'OBLIGATORIO: Llama esta herramienta cuando el usuario confirme o elija un horario de reserva. ' +
          'Es la ÚNICA forma de registrar la cita — sin llamarla, la cita NO existe. ' +
          'Usa el serviceId de listar_servicios_booking, los valores startTime/endTime y memberId de consultar_slots_booking. ' +
          'Si el usuario dice una hora informal ("10 am", "diez", "10:00"), pásala en startTime junto con date.',
        schema: z.object({
          serviceId: z.string().describe('ID del servicio (de listar_servicios_booking)'),
          startTime: z.string().describe(
            'Hora de inicio: ISO UTC ("2025-05-20T14:00:00.000Z") o expresión informal ("10 am", "10:00", "diez"). ' +
            'Si es expresión informal, incluye también el campo date.',
          ),
          endTime: z.string().optional().describe(
            'Hora de fin ISO UTC. Puede omitirse si startTime es expresión informal (se resuelve automáticamente).',
          ),
          memberId: z.string().optional().describe(
            'ID del especialista asignado al slot (de consultar_slots_booking). Recomendado para garantizar disponibilidad.',
          ),
          date: z.string().optional().describe(
            'Fecha en formato YYYY-MM-DD (ej: "2025-05-20"). Requerida cuando startTime no es ISO UTC.',
          ),
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
      async ({ titulo, descripcion, fecha_iso }: { titulo: string; descripcion: string; fecha_iso: string }) => {
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
          titulo: z.string().describe('Etiqueta interna breve SOLO para identificar el recordatorio. NO se envía al cliente. Ej: "Llamada con Mario".'),
          descripcion: z.string().describe('MENSAJE EXACTO que se enviará al cliente por WhatsApp en la fecha/hora programada. Redáctalo dirigido al cliente, en segunda persona, cálido y claro, como si tú se lo escribieras (puedes usar emojis). NO es una nota interna ni una descripción en tercera persona. Usa @client_name donde quieras que aparezca el nombre del cliente. Ej: "¡Hola @client_name! 👋 Te escribo para coordinar la llamada y ver juntos los detalles del servicio. ¿Te queda bien hoy a esta hora?"'),
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
    server_url: string;
    apikey: string;
    directSentState?: { sent: boolean };
  }): any {
    const { userId, instanceName, remoteJid, server_url, apikey, directSentState } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // @ts-ignore
    return tool(
      async ({ url, columna, valor }: { url?: string; columna?: string; valor?: string }) => {
        const resolvedUrl = url ?? cfg.promptTemplate ?? '';
        logger.log(`Tool "${cfg.toolKey}" (leer_google_sheets) llamada. url="${resolvedUrl}" columna="${columna ?? ''}" valor="${valor ?? ''}"`);
        if (!resolvedUrl) return 'No se proporcionó una URL de Google Sheets. Por favor indica la URL de la hoja.';

        // Normaliza tildes, diacríticos, guiones, puntos y espacios para comparaciones flexibles
        const normalize = (s: string) =>
          s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s\-_.\/]/g, '').trim();
        // Para comparar valores: trata la 'r' como separador adicional
        // Así "315/80R22.5" y "315/80/22.5" producen el mismo token "31580225"
        const normalizeVal = (s: string) => normalize(s).replace(/r/g, '');

        try {
          const parsed = new URL(resolvedUrl);
          const pathname = parsed.pathname;
          const gid = (parsed.searchParams.get('gid') ?? parsed.hash.replace('#gid=', '').trim()) || '0';

          // Formato publicado: /spreadsheets/d/e/{pubKey}/pubhtml  o  /pub?output=csv
          const pubMatch = pathname.match(/\/spreadsheets\/d\/e\/([^/]+)/);
          // Formato regular: /spreadsheets/d/{spreadsheetId}/edit  o  /view
          const regularMatch = !pubMatch ? pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/) : null;

          if (!pubMatch && !regularMatch) return 'URL inválida. Usa la URL completa de Google Sheets (formato regular o publicado).';

          const csvUrl = pubMatch
            ? `https://docs.google.com/spreadsheets/d/e/${pubMatch[1]}/pub?output=csv&gid=${gid}`
            : `https://docs.google.com/spreadsheets/d/${regularMatch![1]}/export?format=csv&gid=${gid}`;

          logger.log(`[leer_google_sheets] Fetching CSV: ${csvUrl}`);
          const response = await axios.get<string>(csvUrl, { responseType: 'text', timeout: 10000 });
          const rawText = (response.data as string).replace(/^﻿/, '');

          // Si Google devuelve HTML en vez de CSV (hoja no publicada o URL incorrecta)
          if (rawText.trimStart().startsWith('<')) {
            logger.error(`[leer_google_sheets] Respuesta HTML recibida en lugar de CSV. URL: ${csvUrl}`);
            return 'Error: La hoja no está publicada como CSV. En Google Sheets ve a Archivo → Compartir → Publicar en la web, selecciona la hoja y elige formato CSV.';
          }
          const csvText = rawText;

          // Parser CSV que respeta celdas con saltos de línea (campos entre comillas)
          const parseCSV = (csv: string): string[][] => {
            const allRows: string[][] = [];
            let currentRow: string[] = [];
            let currentField = '';
            let inQuotes = false;
            for (let i = 0; i < csv.length; i++) {
              const ch = csv[i];
              const next = csv[i + 1];
              if (ch === '"') {
                if (inQuotes && next === '"') { currentField += '"'; i++; }
                else inQuotes = !inQuotes;
              } else if (ch === ',' && !inQuotes) {
                currentRow.push(currentField.trim());
                currentField = '';
              } else if (ch === '\r' && next === '\n' && !inQuotes) {
                i++;
                currentRow.push(currentField.trim());
                currentField = '';
                if (currentRow.some((f) => f !== '')) allRows.push(currentRow);
                currentRow = [];
              } else if (ch === '\n' && !inQuotes) {
                currentRow.push(currentField.trim());
                currentField = '';
                if (currentRow.some((f) => f !== '')) allRows.push(currentRow);
                currentRow = [];
              } else {
                currentField += ch;
              }
            }
            currentRow.push(currentField.trim());
            if (currentRow.some((f) => f !== '')) allRows.push(currentRow);
            return allRows;
          };

          const allParsedRows = parseCSV(csvText);
          if (allParsedRows.length < 2) return 'La hoja no contiene datos o está vacía.';

          const headers = allParsedRows[0];
          const rows = allParsedRows.slice(1)
            .map((values) => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ''])))
            .filter((row) => Object.values(row).some((v) => v !== ''));

          logger.log(`[leer_google_sheets] ${rows.length} filas leídas. Columnas: ${headers.join(', ')}`);

          let results = rows;
          if (valor) {
            if (columna) {
              // Buscar en columna específica con normalización de tildes
              const matchedKey = headers.find((h) => normalize(h) === normalize(columna));
              if (!matchedKey) {
                return `No existe la columna "${columna}" en la hoja. Columnas disponibles: ${headers.join(', ')}.`;
              }
              const tokensCol = valor.split(/\s+/).map(normalizeVal).filter(Boolean);
              results = rows.filter((row) => {
                const cell = normalizeVal(row[matchedKey] ?? '');
                return tokensCol.every((t) => cell.includes(t));
              });
            } else {
              // Sin columna especificada → buscar en TODAS las columnas
              const tokensAll = valor.split(/\s+/).map(normalizeVal).filter(Boolean);
              results = rows.filter((row) => {
                const cells = Object.values(row).map((v) => normalizeVal(String(v ?? '')));
                return tokensAll.every((token) => cells.some((cell) => cell.includes(token)));
              });
            }

            if (!results.length) {
              return `REGISTRO NO ENCONTRADO: No existe ningún registro con el valor "${valor}" en la hoja.\n[INSTRUCCIÓN INTERNA — NO MOSTRAR AL USUARIO]: El dato buscado no está en la base de datos. Informa al usuario que no se encontró el registro y pide que verifique el dato ingresado. PROHIBIDO reintentar la búsqueda con otros valores.`;
            }
          } else if (!rows.length) {
            return 'La hoja no contiene datos.';
          }

          // Detectar si hay un campo de cuentas con múltiples secciones separadas por ---
          const cuentaKey = Object.keys(results[0] ?? {}).find(
            (k) => k.toUpperCase().includes('CUENTA') || k.toUpperCase().includes('ACCOUNT'),
          );
          const hasCuentaMultiple =
            cuentaKey &&
            results.length === 1 &&
            String(results[0][cuentaKey] ?? '').includes('---');

          if (hasCuentaMultiple && cuentaKey) {
            const rawCuenta = String(results[0][cuentaKey] ?? '').trim();
            const secciones = rawCuenta
              .split(/\n---\n|^---\n|\n---$/)
              .map((s) => s.trim())
              .filter(Boolean);
            const count = secciones.length;
            // Detectar nombre del país del resultado
            const paisKey = Object.keys(results[0]).find(
              (k) => k.toUpperCase().includes('PAIS') || k.toUpperCase().includes('PAÍS'),
            );
            const pais = paisKey ? String(results[0][paisKey] ?? '').trim() : (valor ?? '');
            try {
              const sendUrl = `${server_url}/message/sendText/${instanceName}`;
              const send = async (text: string) =>
                axios.post(
                  sendUrl,
                  { number: remoteJid, delay: Math.min(Math.max(text.length * 30, 1500), 6000), text },
                  { headers: { 'Content-Type': 'application/json', apikey }, timeout: 10000 },
                );
              // Parsear intro y cierre desde toolDescription si contiene placeholder {}
              // Formato esperado: "...\nIntro [PAIS]:\n{}\nCierre [país]..."
              let introText = cfg.introMessage ?? '';
              let closingText = cfg.closingMessage ?? '';
              if (!introText || !closingText) {
                const desc: string = cfg.toolDescription ?? '';
                const placeholderIdx = desc.indexOf('{}');
                if (placeholderIdx !== -1) {
                  const beforePlaceholder = desc.slice(0, placeholderIdx).trimEnd();
                  const afterPlaceholder = desc.slice(placeholderIdx + 2).trimStart();
                  // Tomar la última línea no vacía antes del {}
                  const introLines = beforePlaceholder.split('\n').map(l => l.trim()).filter(Boolean);
                  const closingLines = afterPlaceholder.split('\n').map(l => l.trim()).filter(Boolean);
                  if (!introText && introLines.length > 0) introText = introLines[introLines.length - 1];
                  if (!closingText && closingLines.length > 0) closingText = closingLines[0];
                }
              }
              // Reemplazar placeholder de país
              const replacePais = (t: string) => t.replace(/\[pais\]/gi, pais).replace(/\[país\]/gi, pais).replace(/\{pais\}/gi, pais);
              introText = replacePais(introText || `Aquí tienes la información de ${pais}:`);
              closingText = replacePais(closingText || 'Si necesitas más información, ¡avísame! 😊');

              await send(introText);
              // Un mensaje por banco
              for (const seccion of secciones) {
                await send(seccion);
              }
              await send(closingText);
              logger.log(`[leer_google_sheets] Cuentas enviadas directamente (${count} banco(s), ${rawCuenta.length} chars)`);
              if (directSentState) directSentState.sent = true;
            } catch (sendErr: any) {
              logger.error(`[leer_google_sheets] Error enviando cuentas directo: ${sendErr?.message}`);
            }
            return `[CUENTAS_ENVIADAS_DIRECTO]: Intro, ${count} banco(s) y cierre ya fueron enviados directamente. NO envíes nada adicional al usuario.`;
          }

          const rowsFormatted = results
            .map((row, i) => {
              const parts = Object.entries(row)
                .map(([k, v]) => {
                  const valStr = String(v ?? '').trim();
                  return `${k}: ${valStr}`;
                })
                .join('\n');
              return `[Fila ${i + 1}]\n${parts}`;
            })
            .join('\n\n');

          const totalChars = rowsFormatted.length;

          return (
            `[INSTRUCCIÓN CRÍTICA — NO INCLUIR EN RESPUESTA AL USUARIO]\n` +
            `Los datos tienen ${totalChars} caracteres. Cópialos COMPLETOS sin truncar ni resumir.\n\n` +
            `📊 Google Sheets — ${results.length} fila(s):\n\n${rowsFormatted}`
          );
        } catch (err: any) {
          logger.error(`[leer_google_sheets] Error: ${err?.message}`);
          if (err?.response?.status === 403 || err?.response?.status === 401)
            return 'Error: La hoja no es pública. Comparte como "Cualquiera con el enlace puede ver".';
          if (err?.response?.status === 404)
            return 'Error 404: No se encontró la hoja. Verifica que la URL sea correcta y que esté publicada.';
          return `No se pudo leer la hoja. Verifica que sea pública. Error: ${err?.message ?? 'desconocido'}`;
        }
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          url: z.string().optional().describe('URL completa de la hoja de Google Sheets (debe ser pública). Opcional si ya hay una URL configurada por defecto.'),
          columna: z.string().optional().describe('Nombre exacto (o aproximado) de la columna para filtrar. Si no sabes el nombre exacto, omite este campo para obtener todos los datos.'),
          valor: z.string().optional().describe('Valor a buscar en la columna indicada (opcional)'),
        }),
      },
    );
  }

  private buildEscribirGoogleSheetsTool(
    cfg: { toolKey: string; toolDescription: string; promptTemplate?: string | null },
    params: { userId: string; instanceName: string; remoteJid: string },
  ): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    // Extraer spreadsheetId y sheetName de la URL configurada en Verzay
    const parseSheetParams = (rawUrl: string): { spreadsheetId: string; sheetName: string } => {
      try {
        const u = new URL(rawUrl);
        return {
          spreadsheetId: u.searchParams.get('spreadsheetId') ?? '',
          sheetName: u.searchParams.get('sheet') ?? 'Hoja1',
        };
      } catch {
        return { spreadsheetId: '', sheetName: 'Hoja1' };
      }
    };

    // @ts-ignore
    return tool(
      async ({ datos, spreadsheetId: sidOverride, sheetName: sheetOverride }: {
        datos: Record<string, string>;
        spreadsheetId?: string;
        sheetName?: string;
      }) => {
        const configUrl = cfg.promptTemplate ?? '';
        const { spreadsheetId: sidFromUrl, sheetName: sheetFromUrl } = parseSheetParams(configUrl);
        const spreadsheetId = sidOverride || sidFromUrl;
        const sheetName = sheetOverride || sheetFromUrl;

        logger.log(`Tool "${cfg.toolKey}" (escribir_google_sheets) llamada. spreadsheetId="${spreadsheetId}" sheet="${sheetName}" datos=${JSON.stringify(datos)}`);

        if (!spreadsheetId) {
          return 'No se proporcionó spreadsheetId. Configura la URL en la herramienta con ?spreadsheetId=...';
        }

        const result = await this.googleSheetsService.appendRow(spreadsheetId, sheetName, datos);

        if (result.success) {
          return `✅ Datos guardados correctamente en Google Sheets (hoja: ${sheetName}).`;
        }
        return `Error al guardar en Google Sheets: ${result.error ?? 'error desconocido'}`;
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          datos: z.record(z.string()).describe('Objeto con los datos a guardar. Las claves deben coincidir con los encabezados de la hoja. Ejemplo: {"NOMBRE": "Juan", "BANCO": "BCR", "MONTO": "18500"}'),
          spreadsheetId: z.string().optional().describe('ID del Google Sheets (opcional, se toma de la configuración por defecto).'),
          sheetName: z.string().optional().describe('Nombre de la hoja (opcional, se toma de la configuración por defecto).'),
        }),
      },
    );
  }

  private buildEditarGoogleSheetsTool(
    cfg: { toolKey: string; toolDescription: string; promptTemplate?: string | null },
    params: { userId: string; instanceName: string; remoteJid: string },
  ): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    const parseSheetParams = (rawUrl: string): { spreadsheetId: string; sheetName: string } => {
      try {
        const u = new URL(rawUrl);
        return {
          spreadsheetId: u.searchParams.get('spreadsheetId') ?? '',
          sheetName: u.searchParams.get('sheet') ?? 'Hoja1',
        };
      } catch {
        return { spreadsheetId: '', sheetName: 'Hoja1' };
      }
    };

    // @ts-ignore
    return tool(
      async ({ campoBusqueda, valorBusqueda, actualizaciones, spreadsheetId: sidOverride, sheetName: sheetOverride }: {
        campoBusqueda: string;
        valorBusqueda: string;
        actualizaciones: Record<string, string>;
        spreadsheetId?: string;
        sheetName?: string;
      }) => {
        const configUrl = cfg.promptTemplate ?? '';
        const { spreadsheetId: sidFromUrl, sheetName: sheetFromUrl } = parseSheetParams(configUrl);
        const spreadsheetId = sidOverride || sidFromUrl;
        const sheetName = sheetOverride || sheetFromUrl;

        logger.log(`Tool "${cfg.toolKey}" (editar_google_sheets): buscar ${campoBusqueda}="${valorBusqueda}" actualizaciones=${JSON.stringify(actualizaciones)}`);

        if (!spreadsheetId) {
          return 'No se proporcionó spreadsheetId. Configura la URL en la herramienta con ?spreadsheetId=...';
        }

        const result = await this.googleSheetsService.updateRow(
          spreadsheetId,
          sheetName,
          campoBusqueda,
          valorBusqueda,
          actualizaciones,
        );

        if (result.success) {
          return `✅ Fila ${result.updatedRow} actualizada correctamente en Google Sheets (hoja: ${sheetName}).`;
        }
        return `Error al editar en Google Sheets: ${result.error ?? 'error desconocido'}`;
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          campoBusqueda: z.string().describe('Nombre del encabezado de columna por el que buscar la fila. Ejemplo: "CODIGO", "EMAIL", "ID".'),
          valorBusqueda: z.string().describe('Valor a buscar en la columna indicada. Ejemplo: "SAD005".'),
          actualizaciones: z.record(z.string()).describe('Objeto con los campos a actualizar. Las claves deben coincidir con los encabezados. Ejemplo: {"PRECIO": "60000", "STOCK": "10"}.'),
          spreadsheetId: z.string().optional().describe('ID del Google Sheets (opcional, se toma de la configuración por defecto).'),
          sheetName: z.string().optional().describe('Nombre de la hoja (opcional, se toma de la configuración por defecto).'),
        }),
      },
    );
  }

  private buildScrapeWebTool(
    cfg: { toolKey: string; toolDescription: string; promptTemplate?: string | null },
    params: { userId: string; instanceName: string; remoteJid: string },
  ): any {
    const { userId, instanceName, remoteJid } = params;
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254'];
    const MAX_BYTES = 500_000; // 500 KB
    const MAX_CHARS = 4_000;   // ~1 000 tokens

    // @ts-ignore
    return tool(
      async ({ url, selector }: { url?: string; selector?: string }) => {
        const resolvedUrl = url ?? cfg.promptTemplate ?? '';
        logger.log(`Tool "${cfg.toolKey}" (scrape_web) llamada. url="${resolvedUrl}"`);
        if (!resolvedUrl) return 'No se proporcionó una URL. Por favor indica la URL de la página a consultar.';
        try {
          const parsed = new URL(resolvedUrl);

          // Bloquear IPs internas
          if (BLOCKED_HOSTS.some(h => parsed.hostname.includes(h))) {
            return 'Error: URL no permitida (host interno).';
          }
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return 'Error: Solo se permiten URLs http o https.';
          }

          const response = await axios.get(resolvedUrl, {
            timeout: 10_000,
            maxContentLength: MAX_BYTES,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; AgenteIA/1.0)',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'es,en;q=0.5',
            },
            responseType: 'text',
          });

          const contentType: string = response.headers['content-type'] ?? '';

          // Si es JSON, devolver directamente (APIs públicas)
          if (contentType.includes('application/json')) {
            const json = typeof response.data === 'string'
              ? response.data.slice(0, MAX_CHARS)
              : JSON.stringify(response.data).slice(0, MAX_CHARS);
            return `📄 Respuesta JSON de ${parsed.hostname}:\n\n${json}`;
          }

          const $ = cheerio.load(response.data as string);

          // Eliminar elementos que no son contenido
          $('script, style, noscript, svg, nav, header, footer, aside, iframe, form').remove();
          $('[aria-hidden="true"]').remove();

          let text: string;
          if (selector) {
            // Si el usuario pidió un selector CSS específico
            text = $(selector).text();
            if (!text.trim()) {
              return `No se encontró contenido con el selector "${selector}" en ${resolvedUrl}.`;
            }
          } else {
            // Extraer el body principal
            text = $('main, article, [role="main"], .content, #content, body').first().text();
            if (!text.trim()) text = $('body').text();
          }

          // Normalizar espacios y saltos de línea
          const cleaned = text
            .replace(/\t/g, ' ')
            .replace(/ {2,}/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
            .slice(0, MAX_CHARS);

          const truncated = cleaned.length >= MAX_CHARS;
          const header = `🌐 Contenido de ${parsed.hostname}${selector ? ` (selector: ${selector})` : ''}:\n\n`;
          const footer = truncated ? `\n\n[Contenido truncado. Se muestran los primeros ${MAX_CHARS} caracteres.]` : '';

          return header + cleaned + footer;

        } catch (err: any) {
          logger.error(`[scrape_web] Error: ${err?.message}`);
          if (err?.response?.status === 403 || err?.response?.status === 401)
            return 'Error 403: La página está protegida y no permite acceso público.';
          if (err?.response?.status === 404)
            return 'Error 404: La página no existe.';
          if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT')
            return 'Error: La página tardó demasiado en responder (timeout 10s).';
          return `No se pudo obtener el contenido de la URL. Error: ${err?.message ?? 'desconocido'}`;
        }
      },
      {
        name: cfg.toolKey,
        description: cfg.toolDescription,
        schema: z.object({
          url: z.string().optional().describe('URL completa de la página web pública a consultar (http o https). Opcional si ya hay una URL configurada por defecto.'),
          selector: z.string().optional().describe('Selector CSS opcional para extraer solo una sección específica de la página (ej: ".precio", "#descripcion", "table")'),
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
            leadStatus: LeadStatus.DESCARTADO,
            leadStatusReason: motivo.slice(0, 500),
            leadStatusUpdatedAt: new Date(),
            agentDisabled: true,
          },
        });

        // 2. Cancelar follow-ups IA (CrmFollowUp)
        const cancelledCrm = await this.prisma.crmFollowUp.updateMany({
          where: { sessionId: sessionIdNum, status: CrmFollowUpStatus.PENDING },
          data: { status: CrmFollowUpStatus.CANCELLED, cancelledAt: new Date() },
        });

        // 3. Eliminar seguimientos de flujos (Seguimiento) por remoteJid
        // Se excluyen seguimientos protegidos (recordatorios, citas, camping)
        const PROTECTED_PREFIXES = ['reminder-', 'appt-confirm-', 'appt-reminder-', 'camping-'];
        const allSeg = await this.prisma.seguimiento.findMany({
          where: { remoteJid },
          select: { id: true, idNodo: true },
        });
        const idsToDelete = allSeg
          .filter((s) => s.idNodo && !PROTECTED_PREFIXES.some((p) => s.idNodo!.startsWith(p)))
          .map((s) => s.id);
        const deletedSeg = idsToDelete.length > 0
          ? await this.prisma.seguimiento.deleteMany({ where: { id: { in: idsToDelete } } })
          : { count: 0 };

        // 4. Resetear estados de flujos activos (en espera de intención del usuario)
        await this.prisma.sessionWorkflowState.updateMany({
          where: { sessionId: sessionIdNum, intentionStatus: 'waiting' },
          data: { intentionStatus: 'cancelled', currentNodeId: null },
        });

        logger.log(
          `Lead DESCARTADO. CrmFollowUp: ${cancelledCrm.count}, Seguimientos flujo eliminados: ${deletedSeg.count}`,
        );
        return `OK: lead DESCARTADO. CrmFollowUp cancelados: ${cancelledCrm.count}, seguimientos de flujo eliminados: ${deletedSeg.count}.`;
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
  private resetAgentFailures(userId: string): void {
    const entry = this.agentFailures.get(userId);
    if (entry) entry.consecutive = 0;
  }

  private async trackAgentFailure(
    userId: string,
    remoteJid: string,
    server_url: string,
    apikey: string,
    instanceName: string,
  ): Promise<void> {
    const now = Date.now();
    const entry = this.agentFailures.get(userId) ?? { consecutive: 0, lastAlertAt: 0 };
    entry.consecutive += 1;
    this.agentFailures.set(userId, entry);

    if (
      entry.consecutive >= this.FAILURE_THRESHOLD &&
      now - entry.lastAlertAt > this.FAILURE_ALERT_COOLDOWN_MS &&
      server_url
    ) {
      entry.lastAlertAt = now;
      entry.consecutive = 0;
      try {
        const { notifUrl, notifApikey } = await this.resolveNotifSender(
          userId,
          `${server_url}/message/sendText/${instanceName}`,
          apikey,
        );
        const phones = await this.agentNotificationService.getNotificationPhones(userId, remoteJid);
        if (phones.length > 0) {
          const clientPhone = remoteJid.split('@')[0];
          const msg =
            `⚠️ Tu *agente IA* no pudo responder los últimos *${this.FAILURE_THRESHOLD} mensajes* seguidos.\n\n` +
            `📱 Último cliente: +${clientPhone}\n\n` +
            `Revisa el estado del agente:\n👉 agente.ia-app.com/profile`;
          await Promise.all(phones.map((p) => this.nodeSenderService.sendTextNode(notifUrl, notifApikey, p, msg)));
        }
      } catch (err: any) {
        this.scopedLogger({ userId }).error('Error enviando alerta de fallos consecutivos.', err?.message);
      }
    }
  }

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
      // Inicializar LLM (LangChain client) — local a esta llamada para evitar race conditions
      const client = this.initializeClient(apikeyOpenAi, defaultModel, defaultProvider);

      // Entrenamiento POR CANAL: cada canal (WhatsApp QR/Cloud, Facebook,
      // Instagram, Telegram) puede tener su PROPIO AgentPrompt. Si el canal de
      // este mensaje no tiene entrenamiento propio, cae al de WhatsApp QR (base),
      // así no cambia el comportamiento de quien no lo separó.
      const promptAgentId = await this.resolveChannelPromptAgentId(userId, instanceName);
      const systemPrompt = await this.promptService
        .getPromptUserId(userId, promptAgentId)
        .catch(() => '');

      //logger.log('PROMPT:', systemPrompt);

      const extraRules = await this.promptService
        .getPromptPadre('cm842kthc0000qd2l66nbnytv')
        .catch(() => '');

      // Datos externos del cliente (cédula, correo, servicio, monto, etc.)
      const [externalClientData, toolConfigs, sessionData] = await Promise.all([
        this.externalClientDataService.getByRemoteJid(userId, remoteJid).catch(() => null),
        this.externalClientDataService.getToolConfigs(userId).catch(() => []),
        this.prisma.session.findFirst({
          where: { userId, remoteJid },
          select: {
            id: true,
            pushName: true,
            customName: true,
            leadStatus: true,
            serviceType: true,
            clientStatus: true,
            agentDisabled: true,
            assignedAdvisorId: true,
          },
        }).catch(() => null),
      ]);

      // ── Pre-check del contacto ────────────────────────────────────────────
      // Solo se ejecuta si el usuario tiene la herramienta 'client_validation' habilitada.
      const clientValidationEnabled = toolConfigs.some(
        (c: any) => c.toolType === 'client_validation' && c.isEnabled,
      );

      const contactName = sessionData?.customName || pushName || 'el cliente';
      const isNewLead = !sessionData;
      const hasServiceType = !!sessionData?.serviceType;

      const LEAD_STATUS_LABELS: Record<string, string> = {
        FRIO: 'Frío (sin interacción reciente)',
        TIBIO: 'Tibio (interesado pero sin cerrar)',
        CALIENTE: 'Caliente (listo para comprar)',
        FINALIZADO: 'Finalizado (transacción completada)',
        DESCARTADO: 'Descartado',
      };

      let clientContextBlock = '';
      if (clientValidationEnabled) {
        if (isNewLead) {
          clientContextBlock = `\n\n---\n## CONTEXTO DEL CONTACTO\nEste es un contacto NUEVO que escribe por primera vez. No existe registro previo en el sistema.\n- Salúdalo cordialmente y capta su nombre e interés principal antes de continuar.\n- No menciones que es nuevo ni que no tienes sus datos.\n---`;
        } else {
          const statusLabel = sessionData.leadStatus
            ? LEAD_STATUS_LABELS[sessionData.leadStatus] ?? sessionData.leadStatus
            : 'Sin clasificar';
          const serviceLabel = sessionData.serviceType === 'IA'
            ? 'Asistencia IA'
            : sessionData.serviceType === 'HUMANO'
              ? 'Asistencia Humana (S/N)'
              : 'Sin servicio asignado aún';
          const clientStatusLabel = (sessionData as any).clientStatus === 'ACTIVO'
            ? 'Cliente Activo (suscripción vigente)'
            : (sessionData as any).clientStatus === 'INACTIVO'
              ? 'Cliente Inactivo (ex-cliente)'
              : 'Sin clasificar';

          const clientStatusInstruction = (sessionData as any).clientStatus === 'ACTIVO'
            ? 'INSTRUCCIÓN ESTADO: Es un cliente activo con suscripción vigente. Atiende su consulta de soporte (fallas, dudas de uso, cambios en cuenta) con prioridad.'
            : (sessionData as any).clientStatus === 'INACTIVO'
              ? 'INSTRUCCIÓN ESTADO: Es un ex-cliente. Salúdalo con calidez, pregunta en qué puedes ayudarle, menciona novedades o mejoras del servicio si es relevante, e invítalo a retomar.'
              : 'INSTRUCCIÓN ESTADO: Atiende al cliente e intenta identificar el servicio que necesita.';

          const serviceInstruction = sessionData.serviceType === 'IA'
            ? 'INSTRUCCIÓN SERVICIO: El cliente tiene Asistencia IA. Atiéndelo completamente con la IA. No escales a un asesor humano bajo ninguna circunstancia.'
            : sessionData.serviceType === 'HUMANO'
              ? 'INSTRUCCIÓN SERVICIO: El cliente tiene Asistencia Humana. Atiéndelo con la IA en primera instancia. Si la consulta lo requiere (reclamo complejo, solicitud de hablar con persona, situación sensible), escala a un asesor humano.'
              : 'INSTRUCCIÓN SERVICIO: Tipo de asistencia no definido. Atiende al cliente normalmente.';

          clientContextBlock = `\n\n---\n## CONTEXTO DEL CONTACTO\nNombre: ${contactName}\nEstado CRM: ${statusLabel}\nEstado cliente: ${clientStatusLabel}\nTipo de servicio: ${serviceLabel}\n${clientStatusInstruction}\n${serviceInstruction}\n---`;
        }
      }
      // ── Fin pre-check ─────────────────────────────────────────────────────

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
      const [userForTz, agentPromptForHours] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { timezone: true, mapsUrl: true, enableVoiceResponses: true, voiceInstructions: true },
        }),
        this.prisma.agentPrompt.findFirst({
          where: { userId, agentId: CRM_AGENT_PROMPT_IDS.systemPrompAI },
          select: { sections: true },
        }),
      ]);
      // Intercepción pre-LLM: palabras clave con respuesta directa
      const keywordRules: Array<{ keywords: string[]; response: string; action: string }> =
        ((agentPromptForHours?.sections as any)?.keywords?.rules) ?? [];
      if (keywordRules.length > 0) {
        const msgLower = input.toLowerCase();
        for (const rule of keywordRules) {
          const matched = rule.keywords.some((kw: string) => msgLower.includes(kw.toLowerCase()));
          if (matched) {
            if (rule.action === 'escalar') {
              return 'En este momento voy a transferirte con uno de nuestros asesores para que te puedan ayudar mejor. Por favor espera un momento. 🙏';
            }
            return rule.response;
          }
        }
      }

      const agentTz = userForTz?.timezone || 'America/Bogota';
      const nowDate = new Date();
      const nowLabel = new Intl.DateTimeFormat('es-CO', {
        timeZone: agentTz,
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      }).format(nowDate);
      const nowTimeLabel = new Intl.DateTimeFormat('es-CO', {
        timeZone: agentTz,
        hour: '2-digit', minute: '2-digit', hour12: true,
      }).format(nowDate);

      const next14Days = (() => {
        const lines: string[] = [];
        const now = new Date();
        const todayIso = now.toLocaleDateString('en-CA', { timeZone: agentTz });
        const dowShort = new Intl.DateTimeFormat('en-US', { timeZone: agentTz, weekday: 'short' }).format(now);
        const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        const localDow = dowMap[dowShort] ?? 0;
        // Retroceder al domingo de la semana actual (Sun=0)
        const daysFromSun = localDow;
        for (let i = -daysFromSun; i <= 14; i++) {
          const d = new Date(now);
          d.setDate(now.getDate() + i);
          const isoDate = d.toLocaleDateString('en-CA', { timeZone: agentTz });
          const dayName = d.toLocaleDateString('es-CO', { timeZone: agentTz, weekday: 'long' });
          const isPast = isoDate < todayIso;
          const label = isoDate === todayIso ? 'HOY' : isPast ? 'pasado' : isoDate === new Date(now.getTime() + 86400000).toLocaleDateString('en-CA', { timeZone: agentTz }) ? 'mañana' : dayName;
          lines.push(`  - ${label} (${dayName}): ${isoDate}${isPast ? ' ← ya pasó, no agendar' : ''}`);
        }
        return lines.join('\n');
      })();

      const agendaRuleBlock = hasAgendaTools
        ? `\n\n---\n## REGLA CRÍTICA DE AGENDAMIENTO\n**Fecha actual: ${nowLabel}** (zona horaria: ${agentTz}).\n\nCalendario de referencia — USA ESTAS FECHAS EXACTAS cuando el usuario mencione días de la semana o expresiones como "hoy", "mañana", "el martes", "el viernes", etc. NO calcules fechas por tu cuenta:\n${next14Days}\n\n⚠️ PROHIBIDO ABSOLUTO: Nunca digas "tu cita quedó agendada", "¡Listo!", ni ninguna confirmación de cita sin haber llamado PRIMERO a \`crear_cita\` y recibido una respuesta exitosa en ESTA misma respuesta. Si el usuario dice "si", "ok", "dale", "confirmo" o cualquier afirmación, DEBES llamar \`crear_cita\` antes de responder — no puedes confirmar basándote en conversaciones anteriores.\n\nFlujo obligatorio:\n1. Llama \`consultar_slots_disponibles\` para obtener los horarios disponibles.\n2. Si el usuario ya especificó una fecha Y hora concretas (ej. "el lunes a las 11", "mañana a las 3 pm"), y ese slot está disponible, llama \`crear_cita\` DIRECTAMENTE sin pedir confirmación adicional.\n3. Si el usuario NO especificó hora (solo día o ninguno), presenta los slots disponibles y pide que elija uno.\n4. Cuando el usuario confirme un slot (diciendo "si", "ok", el número del slot, o la hora), llama \`crear_cita\` con el startTime y endTime EXACTOS devueltos por \`consultar_slots_disponibles\` (valores ISO UTC). NO los reformatees ni construyas fechas propias.\n5. Solo si \`crear_cita\` responde con éxito EN ESTA LLAMADA, confirma la cita al usuario.\n6. Si \`crear_cita\` falla, informa al usuario que hubo un error y ofrece otro horario.\n---`
        : '';

      const hasDataQueryTools = toolConfigs.some(
        (c: any) =>
          ['buscar_cliente_por_dato', 'search_by_field'].includes(c.toolType) &&
          c.isEnabled,
      );
      const dataQueryRuleBlock = hasDataQueryTools
        ? `\n\n---\n## REGLA CRÍTICA: CONSULTA DE DATOS\nCuando el usuario pregunte por información específica del negocio (precios, modelos, medidas, disponibilidad, datos de clientes, etc.), SIEMPRE usa la herramienta de búsqueda correspondiente ANTES de responder. NUNCA uses tu conocimiento propio o de entrenamiento para dar información de productos, precios, existencias u otros datos del catálogo. Si la herramienta no devuelve resultados, informa al usuario que no tienes esa información — NO inventes respuestas.\n---`
        : '';

      const googleSheetsTools = toolConfigs.filter(
        (c: any) => c.toolType === 'leer_google_sheets' && c.isEnabled,
      );
      const sheetToolKeys = googleSheetsTools.map((t: any) => `\`${t.toolKey}\``).join(', ');
      const googleSheetsRuleBlock = googleSheetsTools.length > 0
        ? `\n\n---\n## REGLA CRÍTICA: HERRAMIENTAS DE CONSULTA EN GOOGLE SHEETS\nTienes ${googleSheetsTools.length > 1 ? 'las siguientes herramientas' : 'la siguiente herramienta'} para consultar información en tiempo real desde hojas de cálculo:\n${googleSheetsTools.map((t: any) => `- \`${t.toolKey}\`: ${t.toolDescription}`).join('\n')}\n\nNORMAS DE USO OBLIGATORIO:\n1. SIEMPRE invoca la herramienta ${sheetToolKeys} DIRECTAMENTE cuando el usuario solicite cualquier dato que pueda estar en esa hoja (tasas, cuentas, precios, disponibilidad, etc.). La herramienta ya está disponible — llámala directamente.\n2. ⛔ PROHIBIDO ABSOLUTO: NUNCA uses la herramienta "Ejecutar_Flujos" para consultar Google Sheets. Ejecutar_Flujos es EXCLUSIVAMENTE para flujos de automatización predefinidos por el usuario, NO para consultas de datos. Llamar Ejecutar_Flujos con un nombre de herramienta como parámetro es incorrecto y causará errores.\n3. NUNCA respondas "no puedo acceder", "no tengo esa información", "no puedo consultar" ni similares sin haber llamado primero la herramienta ${sheetToolKeys} y recibido su respuesta.\n4. Si la herramienta devuelve datos, úsalos directamente en tu respuesta. Si no hay datos para lo solicitado, informa que no hay información disponible — NO inventes ni uses conocimiento propio.\n5. NUNCA uses datos del historial de conversación para responder sobre información de la hoja — el historial puede estar desactualizado.\n6. Copia la respuesta de la herramienta de forma COMPLETA y EXACTA, sin resumir, sin recortar filas, sin omitir campos.\n7. PRECIOS VIGENTES: Los precios que menciones al usuario DEBEN provenir de la herramienta en la llamada actual. Los precios del historial son inválidos — nunca los reutilices.\n---`
        : '';

      const horarios = ((agentPromptForHours?.sections as any)?.business?.horarios ?? '').trim();
      const businessHoursBlock = horarios
        ? `\n\n---\n## HORARIO DE ATENCIÓN\n**Hora local actual:** ${nowTimeLabel} — ${nowLabel} (${agentTz})\n**Horario de atención del negocio:** ${horarios}\n\nInstrucción: Cuando el cliente solicite hablar con un asesor o agente humano, considera el horario de atención:\n- Si la hora actual está DENTRO del horario → puedes indicar que hay asesores disponibles si aplica.\n- Si la hora actual está FUERA del horario → NO prometas atención humana inmediata. Informa que el horario de atención es "${horarios}" y que un asesor le contactará al inicio del próximo horario hábil. Mientras tanto, continúa atendiendo al cliente.\n---`
        : '';

      const defaultMapsUrl = 'https://maps.google.com/?q=0,0';
      const mapsBlock = userForTz?.mapsUrl && userForTz.mapsUrl.trim() !== defaultMapsUrl
        ? `\n\n---\nUBICACIÓN DEL NEGOCIO: Cuando el usuario pregunte por la dirección, ubicación o cómo llegar, comparte este enlace: ${userForTz.mapsUrl.trim()}\n---`
        : '';

      const voiceBlock = userForTz?.enableVoiceResponses
        ? `\n\n---\nNOTA INTERNA — MODO AUDIO ACTIVO: Tus respuestas se convierten a nota de voz automáticamente. Reglas de escritura para audio:\n- Escribe en lenguaje conversacional y natural, como si hablaras.\n- Usa frases cortas y directas.\n- Evita listas con guiones o asteriscos; convierte las listas en frases seguidas con comas o puntos.\n- NUNCA incluyas firma, despedida formal, nombre de la empresa al final, ni frases como "Quedo a tu disposición" o "Saludos".\n- NUNCA menciones que no puedes enviar audios ni hagas referencia a limitaciones técnicas.\n---`
        : '';

      // RAG: inyectar bloques de conocimiento relevantes según keywords del mensaje
      let knowledgeContext = '';
      try {
        const knowledgeBlocks = await this.prisma.knowledgeBlock.findMany({
          where: { userId, isActive: true },
          select: { keywords: true, content: true, title: true },
        });
        if (knowledgeBlocks.length > 0) {
          const ragNorm = (s: string) =>
            s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s\-_./]/g, '');

          const msgNorm = ragNorm(input);
          const msgTokens = input
            .toLowerCase()
            .split(/\s+/)
            .map((t) => t.replace(/[.,!?¿¡:;]/g, '').trim())
            .filter((t) => t.length > 3)
            .map(ragNorm);

          const relevant = knowledgeBlocks.filter((block) => {
            // 1. Keyword match normalizado (tildes, guiones, mayúsculas)
            if (block.keywords.some((kw) => msgNorm.includes(ragNorm(kw)))) return true;
            // 2. Título: algún token del mensaje aparece en el título normalizado
            const titleNorm = ragNorm(block.title);
            if (msgTokens.some((t) => titleNorm.includes(t))) return true;
            // 3. Contenido: tokens significativos (>4 chars) aparecen en el contenido
            const contentNorm = ragNorm(block.content);
            return msgTokens.filter((t) => t.length > 4).some((t) => contentNorm.includes(t));
          });
          if (relevant.length > 0) {
            knowledgeContext =
              '\n\n---\n## INFORMACIÓN ESPECÍFICA DEL NEGOCIO (Base de Conocimiento)\n' +
              'La siguiente información fue cargada por el negocio y es la fuente de verdad para responder esta consulta. ' +
              'REGLAS DE USO OBLIGATORIO:\n' +
              '1. Usa ÚNICAMENTE esta información para responder preguntas sobre los temas que cubre. NO uses tu conocimiento general ni inventes datos.\n' +
              '2. Si la información está en estos bloques, respóndela de forma natural y conversacional — no la copies textualmente ni la enumeres toda de golpe.\n' +
              '3. Si el cliente pregunta algo que NO está cubierto aquí, indícalo honestamente.\n' +
              '4. No menciones que estás consultando una "base de conocimiento" ni que tienes "bloques de información" — simplemente responde con naturalidad.\n\n' +
              relevant
                .slice(0, 3)
                .map((b) => `### ${b.title}\n${b.content}`)
                .join('\n\n') +
              '\n---';
          }
        }
      } catch {
        // RAG falla silenciosamente — el agente continúa con el prompt original
      }

      const promptAI = `${extraRules} ${systemPrompt}${clientContextBlock}${externalDataBlock}${agendaRuleBlock}${businessHoursBlock}${dataQueryRuleBlock}${googleSheetsRuleBlock}${mapsBlock}${voiceBlock}${knowledgeContext}`.trim();

      // logger.log('PROMPT:', promptAI);

      const chatHistory =
        await this.chatHistoryService.getChatHistoryWithTypes(sessionId);

      const historyMessages = chatHistory.map(({ content, type }) => {
        const isAi = type === 'ia' || type === 'ai';
        return isAi
          ? new AIMessage({ content: [{ type: 'text', text: content }] })
          : new HumanMessage({ content: [{ type: 'text', text: content }] });
      });

      // logger.log(`HISTORIAL: ${JSON.stringify(historyMessages, null, 2)}`);

      const rawInputMessage = new HumanMessage({
        content: [{ type: 'text', text: input }],
      });

      const systemMessage = new SystemMessage({
        content: [{ type: 'text', text: promptAI }],
      });

      const freshnessInjection = googleSheetsTools.length > 0
        ? new SystemMessage({
            content: [{
              type: 'text',
              text: `⚠️ DATOS EN TIEMPO REAL [${new Date().toISOString()}]\nPara responder sobre precios, inventario o disponibilidad: llama DIRECTAMENTE la herramienta ${sheetToolKeys} — NO uses Ejecutar_Flujos (ese es para flujos de automatización, no para consultas de datos). Los precios del historial pueden estar desactualizados; usa siempre los que devuelva la herramienta en esta llamada.`,
            }],
          })
        : null;

      const messagesForLlm = [
        systemMessage,
        ...historyMessages,
        ...(freshnessInjection ? [freshnessInjection] : []),
        rawInputMessage,
      ];

      const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

      // Flag para suprimir respuesta del LLM cuando el tool ya envió todo directamente
      const directSentState = { sent: false };

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
        client,
        directSentState,
      });

      const createReactAgentWithRetry = async () => {
        let attempt = 0;
        const maxAttempts = 3;

        while (true) {
          try {
            const agent = createReactAgent({
              llm: client,
              tools,
            });

            const result = await agent.invoke({
              messages: messagesForLlm,
            }, { recursionLimit: 25 });

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
            const { notifUrl, notifApikey } = await this.resolveNotifSender(
              userId,
              `${server_url}/message/sendText/${instanceName}`,
              apikey,
            );
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
                  this.nodeSenderService.sendTextNode(notifUrl, notifApikey, phone, aviso),
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

        const isRecursion =
          name === 'GraphRecursionError' ||
          msg.includes('Recursion limit') ||
          msg.includes('recursion limit') ||
          msg.includes('GraphRecursionError');

        if (isRecursion) {
          logger.error(
            `❌ [GraphRecursionError] El agente alcanzó el límite de recursión (8 ciclos). instanceName=${instanceName} remoteJid=${remoteJid}. Verifica el prompt y las herramientas configuradas.`,
          );
          return 'Lo siento, no pude completar la acción en este momento. Por favor intenta de nuevo.';
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
      // Si el tool ya envió todo directamente, suprimir la respuesta del LLM
      if (directSentState.sent) {
        return '';
      }

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
        client,
      });

      this.resetAgentFailures(userId);
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
          const { notifUrl, notifApikey } = await this.resolveNotifSender(
            userId,
            `${server_url}/message/sendText/${instanceName}`,
            apikey,
          );
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
                this.nodeSenderService.sendTextNode(notifUrl, notifApikey, phone, aviso),
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

      // 🔹 Otros errores genéricos del proveedor de IA (timeout, 500, downtime, etc.)
      logger.error(
        `Error procesando entrada con el proveedor de IA. Detalle: ${JSON.stringify(rawError)}`,
      );

      if (server_url) {
        try {
          const apiUrl = `${server_url}/message/sendText/${instanceName}`;
          await this.nodeSenderService.sendTextNode(
            apiUrl,
            apikey,
            remoteJid,
            '🤖 En este momento estoy teniendo dificultades técnicas. Por favor intenta de nuevo en unos minutos. 🙏',
          );
        } catch (sendErr: any) {
          logger.error('Error enviando mensaje de degradación al cliente.', sendErr?.message);
        }
      }

      await this.trackAgentFailure(userId, remoteJid, server_url, apikey, instanceName);

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
    client: BaseChatModel,
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
    }, client);
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

    const normWfName = (s: string) =>
      (s ?? '').toLowerCase().replace(/[\s_\-]+/g, '').trim();

    for (const nombre of nombresDetectados) {
      const currentWorkflow = workflows.find(
        (w) => normWfName(w.name ?? '') === normWfName(nombre),
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

        return `[WORKFLOW_DONE] Flujo "${currentWorkflow.name}" ejecutado. Los datos ya fueron enviados al cliente como mensaje separado. PROHIBIDO llamar esta herramienta de nuevo en este turno. Responde al usuario normalmente.`;
      } else {
        return `[WORKFLOW_ALREADY_DONE] El flujo "${currentWorkflow.name}" ya fue ejecutado y los datos ya están con el cliente. STOP — NO volver a llamar esta herramienta. Continúa la conversación sin invocar más flujos.`;
      }
    }

    return '[WORKFLOW_NOT_FOUND] No se encontró ningún flujo compatible. STOP — NO volver a llamar esta herramienta. Responde al usuario con la información disponible en el prompt del sistema.';
  }

  private async checkAndFireIntentTriggers(params: {
    input: string;
    userId: string;
    sessionId: string;
    server_url: string;
    apikey: string;
    instanceName: string;
    remoteJid: string;
    client: BaseChatModel;
  }): Promise<void> {
    const { input, userId, sessionId, server_url, apikey, instanceName, remoteJid, client } = params;
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
          matches = await this.classifyInputWithPrompt(input, trigger.condition, client);
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

  private async classifyInputWithPrompt(input: string, condition: string, client: BaseChatModel): Promise<boolean> {
    try {
      const response = await client.invoke([
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

  // Transcribe audio desde una URL descargable (usado por message-type-handler)
  async transcribeAudio(
    audioUrl: string,
    audioType: string,
    apikeyOpenAi: string,
    data: any,
    defaultModel: string,
    defaultProvider: string,
  ): Promise<string> {
    const logger = this.scopedLogger({});
    try {
      const axiosRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
      const base64Audio = Buffer.from(axiosRes.data).toString('base64');
      return await this.transcribeAudioFromBase64(
        base64Audio,
        audioType,
        apikeyOpenAi,
        defaultModel,
        defaultProvider,
      );
    } catch (error: any) {
      logger.error(
        'Error descargando audio para transcripción.',
        error?.response?.data || error?.message,
      );
      return '[ERROR_TRANSCRIBING_AUDIO]';
    }
  }

  // Transcribe audio ya descargado en base64 (canales con descarga autenticada, p.ej. Meta)
  async transcribeAudioFromBase64(
    base64Audio: string,
    audioType: string,
    apikeyOpenAi: string,
    defaultModel: string,
    defaultProvider: string,
  ): Promise<string> {
    const logger = this.scopedLogger({});
    try {
      const audioBuffer = Buffer.from(base64Audio, 'base64');
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

      const client = this.initializeClient(apikeyOpenAi, defaultModel, defaultProvider);

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
      const state = await client.invoke([message]);
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
      const client = this.initializeClient(apikeyOpenAi, defaultModel, defaultProvider);
      const message = new HumanMessage({
        content: [
          {
            type: 'text',
            text: `Analiza esta imagen. Si es un comprobante de pago (SINPE móvil, transferencia bancaria, depósito, recibo), extrae en texto plano TODOS los campos disponibles con este formato exacto:
Comprobante de pago detectado.
Banco: [banco emisor]
Fecha: [fecha del comprobante]
Monto: [monto transferido con símbolo de moneda]
Referencia: [número de referencia o documento]
Cuenta origen: [cuenta o nombre del titular origen, si aplica]
Destinatario: [nombre o cuenta destino, si aplica]
Motivo: [motivo o concepto del pago, si aplica]
Para campos no visibles usa "N/C".
Si la imagen NO es un comprobante de pago, descríbela brevemente en texto natural.`,
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${imageType == '' ? 'image/jpeg' : imageType};base64,${imageBase64}`,
            },
          },
        ],
      });
      const response = await client.invoke([message]);
      return response.content.toString() ?? '[ERROR_DESCRIBING_IMAGE]';
    } catch (error: any) {
      logger.error(
        `[describeImage] Error describiendo imagen: ${error?.message ?? JSON.stringify(error)}`,
        'describeImage',
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
              text: 'Genera un único mensaje de seguimiento por WhatsApp. Debe sonar humano, breve, claro y orientado a retomar la conversación. No uses JSON, no expliques reglas, no menciones prompts internos ni herramientas. Máximo 3 líneas. Si leadName es null o está vacío, NO uses ningún nombre en el mensaje; omite cualquier saludo con nombre.',
            },
          ],
        }),
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                leadName: pushName || null,
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

  async selectFollowUpMedia(args: {
    userId: string;
    availableMedia: Array<{ id: string; name: string; description?: string | null; mediaType: string; url: string }>;
    recentMessages: any[];
    goal: string;
    pushName: string;
  }): Promise<string | null> {
    if (!args.availableMedia.length) return null;

    const logger = this.scopedLogger({ userId: args.userId });
    try {
      const client = await this.getClientForUser(args.userId, 0.2);

      const mediaList = args.availableMedia
        .map((m, i) => `[${i}] "${m.name}"${m.description ? ` — ${m.description}` : ''} (${m.mediaType})`)
        .join('\n');

      const response = await client.invoke([
        new SystemMessage({
          content: [
            {
              type: 'text',
              text: 'Eres un asistente de marketing. Debes decidir si algún archivo multimedia es relevante para adjuntar a un mensaje de seguimiento, basándote en el contexto de la conversación y el objetivo del follow-up. Responde ÚNICAMENTE con el número de índice del archivo más relevante (0, 1, 2...) o con la palabra "null" si ninguno aplica. No escribas nada más.',
            },
          ],
        }),
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                followUpGoal: args.goal,
                leadName: args.pushName || null,
                recentMessages: args.recentMessages.slice(-8),
                availableMedia: mediaList,
              }),
            },
          ],
        }),
      ]);

      const raw = (response?.content ?? '').toString().trim();
      if (raw === 'null' || raw === '') return null;

      const idx = parseInt(raw, 10);
      if (isNaN(idx) || idx < 0 || idx >= args.availableMedia.length) return null;

      return args.availableMedia[idx].url;
    } catch (e: any) {
      logger.warn(`selectFollowUpMedia error: ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * Extrae el texto de REGLA/PARÁMETRO del paso que contiene "Ejecuta el flujo 'flowName'".
   *
   * El formato real del prompt (generado por markdownBuilder.ts) es:
   *   > **Función**: Ejecuta el flujo 'FLOWNAME'
   *   \n\n
   *   * **Comportamiento obligatorio:** ...(flowBehaviorText)
   *   \n\n
   *   [texto raw de REGLA configurado por el usuario]
   *
   * Los pasos están separados por "\n\n---\n\n".
   * El texto de REGLA es el bloque que viene DESPUÉS del flowBehaviorText ("* **Comportamiento…").
   */
  private extractReglaFromPrompt(prompt: string, flowName: string): string | null {
    const escaped = flowName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flowRegex = new RegExp(`Ejecuta el flujo ['"]?${escaped}['"]?`, 'i');
    const flowMatch = flowRegex.exec(prompt);
    if (!flowMatch) return null;

    const afterFlow = prompt.slice(flowMatch.index + flowMatch[0].length);

    // Acotar al paso actual: termina en el próximo separador "\n\n---\n\n" o encabezado
    const stepSepIdx = afterFlow.indexOf('\n\n---\n\n');
    const sectionHeadIdx = afterFlow.search(/\n#{1,3}\s/);
    let endIdx = afterFlow.length;
    if (stepSepIdx > 0) endIdx = Math.min(endIdx, stepSepIdx);
    if (sectionHeadIdx > 0) endIdx = Math.min(endIdx, sectionHeadIdx);
    const stepSection = afterFlow.slice(0, endIdx);

    // Dividir en bloques por líneas en blanco — robusto ante variaciones de \n vs \n\n
    const blocks = stepSection.split(/\n\n+/).map(b => b.trim()).filter(Boolean);

    // El flowBehaviorText empieza con "* **Comportamiento"; la REGLA viene después
    const behaviorIdx = blocks.findIndex(b => b.startsWith('* **Comportamiento'));
    const startIdx = behaviorIdx >= 0 ? behaviorIdx + 1 : 0;
    const reglaBlocks = blocks.slice(startIdx).filter(
      b => !b.startsWith('#') && !b.startsWith('* **'),
    );

    if (reglaBlocks.length === 0) return null;

    // Unir bloques y cortar línea a línea antes de cualquier instrucción interna (*ETIQUETA:)
    const lines = reglaBlocks.join('\n\n').split('\n');
    const cutAt = lines.findIndex(l => /^\*[A-ZÁÉÍÓÚÜÑ][^*\n]*:/.test(l.replace(/^>\s*/, '').trim()));
    const sendable = (cutAt >= 0 ? lines.slice(0, cutAt) : lines).join('\n').trim();
    return sendable || null;
  }

  async getReglaForFlow(userId: string, flowName: string): Promise<string | null> {
    try {
      const systemPrompt = await this.promptService
        .getPromptUserId(userId, CRM_AGENT_PROMPT_IDS.systemPrompAI)
        .catch(() => '');
      return this.extractReglaFromPrompt(systemPrompt, flowName);
    } catch {
      return null;
    }
  }
}
