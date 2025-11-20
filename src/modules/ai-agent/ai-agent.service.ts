  import axios from 'axios';
  import OpenAI from 'openai';

  import fs from "fs";
  import path from "path";

  import { Readable } from "stream";
  import { Injectable } from '@nestjs/common';
  import { LoggerService } from 'src/core/logger/logger.service';
  import { PromptService } from '../prompt/prompt.service';
  import { ChatHistoryService } from '../chat-history/chat-history.service';
  import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
  import { WorkflowService } from '../workflow/services/workflow.service.ts/workflow.service';
  import {
    inputWorkflow,
    OpenAIDetectionResult,
    openAIToolDetection,
    proccessInput,
  } from 'src/types/open-ai';
  import { NotificacionToolService } from './tools/notificacion/notificacion.service';
  import { AiCreditsService } from '../ai-credits/ai-credits.service';
  import { ERROR_OPENAI_EMPTY_RESPONSE, systemPromptWorkflow } from './utils/rulesPrompt';
  import { PromptCompressorService } from './services/prompt-compressor/prompt-compressor.service';
  import { BaseChatModel } from '@langchain/core/language_models/chat_models';
  import { SessionService } from '../session/session.service';
  import { tool } from '@langchain/core/tools';

  // Refactor
  import { LlmClientFactory } from './services/llmClientFactory/llmClientFactory.service';
  import {
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    SystemMessage,
    ToolMessage,
  } from "@langchain/core/messages";
  import { langchainTools } from './utils/langchainTools';

  @Injectable()
  export class AiAgentService {
    private openAiClient: OpenAI;
    // Cliente LLM (LangChain / OpenAI envuelto)
    private aiClient: any = null;

    // Nombre del flujo de bienvenida inicial
    private readonly initWorkflowName: string = 'INICIO_BIENVENIDA';

    constructor(
      private readonly logger: LoggerService,
      private readonly promptService: PromptService,
      private readonly chatHistoryService: ChatHistoryService,
      private readonly workflowService: WorkflowService,
      private readonly notificacionTool: NotificacionToolService,
      private readonly aiCredits: AiCreditsService,
      private readonly llmClientFactory: LlmClientFactory,
      private readonly sessionService: SessionService,
      private readonly promptCompressor: PromptCompressorService,
    ) { }

    // Logger con contexto fijo: [UID=...][I=...][R=...]
    private scopedLogger(ctx: { userId?: string; instanceName?: string; remoteJid?: string }) {
      const tag = `[UID=${ctx.userId ?? '-'}][I=${ctx.instanceName ?? '-'}][R=${ctx.remoteJid ?? '-'}]`;
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
     * SIEMPRE FINALIZA COMO AGENTE PRINCIPAL.
     *
     * Esta función se ejecuta SIEMPRE que:
     * - No hubo tool_call, o
     * - Se ejecutó una tool (Notificacion_Asesor / Ejecutar_Flujos) y ya tenemos
     *   un texto de resultado (followupText) que se pasa como contexto.
     *
     * El agente principal recibe:
     * - system prompt principal: `${extraRules} ${systemPrompt}`
     * - historial de chat
     * - mensaje original del usuario
     * - mensaje de seguimiento con el resultado de la tool (followupText)
     */
    private async respondAsMainAgent(params: {
      userId: string;
      sessionId: string;
      userPrompt: string;
      principalSystemPrompt: string;
      followupText: string;
    }): Promise<string> {
      const {
        userId,
        sessionId,
        userPrompt,
        principalSystemPrompt,
        followupText,
      } = params;

      const chatHistory = await this.chatHistoryService.getChatHistory(sessionId);

      const systemMessage = new SystemMessage({
        content: [
          {
            type: 'text',
            text: principalSystemPrompt,
          },
        ],
      });

      const historyMessages = chatHistory.map(
        (text) =>
          new HumanMessage({
            content: [{ type: 'text', text }],
          }),
      );

      // Mensaje original del usuario
      const rawUser = new HumanMessage({
        content: [{ type: 'text', text: userPrompt }],
      });

      // Resultado de la tool como contexto adicional
      const followupMessage = new HumanMessage({
        content: [{ type: 'text', text: followupText }],
      });

      const completion = await this.aiClient.invoke([
        systemMessage,
        ...historyMessages,
        rawUser,
        followupMessage,
      ]);

      const totalTokens = completion?.usage_metadata?.total_tokens;
      const tokensUsed = totalTokens ? parseInt(totalTokens.toString(), 10) : 0;
      await this.aiCredits.trackTokens(userId, tokensUsed);

      const rawOut = completion.content?.toString()?.trim() || followupText;
      return rawOut;
    }

    /**
     * Agente interno de detección de flujos.
     *
     * Usa systemPromptWorkflow + formattedList para transformar el input
     * (nombre_flujo y descripción) en una lista de nombres de flujos exactos
     * que existen en la BD.
     */
    private async openAIToolDetection({
      input,
      sessionId,
      userId,
    }: openAIToolDetection): Promise<OpenAIDetectionResult> {
      const logger = this.scopedLogger({ userId });
      try {
        const chatHistory = await this.chatHistoryService.getChatHistory(sessionId);
        const workflows = await this.workflowService.getWorkflow(userId);

        const formattedList = workflows
          .map((flow, index) => `${index + 1}. ${flow.name}`)
          .join(',\n');

        logger.log(`Lista de flujos (texto): ${JSON.stringify(formattedList)}`);
        logger.log(`Lista de flujos (obj): ${JSON.stringify(workflows)}`);

        const customWorkflowPrompt = systemPromptWorkflow(
          input,
          JSON.stringify(formattedList),
        );

        const messagesR = [
          new SystemMessage({
            content: [{ type: 'text', text: customWorkflowPrompt }],
          }),
          ...chatHistory.map(
            (text) =>
              new HumanMessage({
                content: [{ type: 'text', text }],
              }),
          ),
          new HumanMessage({
            content: [{ type: 'text', text: JSON.stringify(input) }],
          }),
        ];

        const responseR = await this.aiClient.invoke(messagesR);

        const choice = responseR.content.toString();
        const content = choice.trim();

        const totalTokensR = responseR?.usage_metadata?.total_tokens;
        const tokensUsedR = totalTokensR ? parseInt(totalTokensR.toString(), 10) : 0;
        await this.aiCredits.trackTokens(userId, tokensUsedR);

        if (!choice || !content) {
          logger.warn('Content inválido o vacío');
          return { content: null };
        }

        return { content };
      } catch (error) {
        logger.error(
          'Error procesando entrada con OpenAI (detección de flujos).',
          (error as any)?.response?.data || (error as any).message,
        );
        return { content: null };
      }
    }

    /**
     * Proceso principal de entrada (AGENTE PRINCIPAL).
     * Llamado desde el webhook.
     *
     * Prompt principal:  `${extraRules} ${systemPrompt}`
     *
     * - Detecta si la IA quiere usar tools (Notificacion_Asesor / Ejecutar_Flujos).
     * - Ejecuta la tool en backend.
     * - Pasa el resultado al MISMO agente principal para que responda al usuario.
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
    }: proccessInput): Promise<string> {
      const logger = this.scopedLogger({ userId, instanceName, remoteJid });
      let promptAI = '';

      try {
        // Inicializar LLM (LangChain client)
        this.initializeClient(apikeyOpenAi, defaultModel, defaultProvider);

        const systemPrompt = await this.promptService
          .getPromptUserId(userId)
          .catch(() => '');
        const extraRules = await this.promptService
          .getPromptPadre('cm842kthc0000qd2l66nbnytv')
          .catch(() => '');

        // 🔹 Prompt PRINCIPAL del agente
        promptAI = `${extraRules} ${systemPrompt}`.trim();

        // 👉 LOG EXTRA: ver prompt completo en logs
        //logger.log(`Prompt principal (promptAI) usado por el agente:\n${promptAI}`);

        const chatHistory = await this.chatHistoryService.getChatHistory(sessionId);
        const noHistory =
          !Array.isArray(chatHistory) || chatHistory.length === 0;

        const workflows = await this.workflowService.getWorkflow(userId);

        const hasInicioBienvenida = workflows?.some(
          (w: any) =>
            typeof w?.name === 'string' &&
            w.name.trim().toLowerCase() ===
            this.initWorkflowName.toLowerCase(),
        );

        // 🔹 Caso especial: primera vez en el chat + flujo INICIO_BIENVENIDA
        if (noHistory && hasInicioBienvenida) {
          const args: any = {
            nombre_flujo: [this.initWorkflowName],
            descripcion: 'Inicio automático de bienvenida',
          };

          const follow = await this.handleExecuteWorkflowTool(
            args,
            userId,
            sessionId,
            server_url,
            apikey,
            instanceName,
            remoteJid,
          );

          const final = await this.respondAsMainAgent({
            userId,
            sessionId,
            userPrompt: input,
            principalSystemPrompt: promptAI,
            followupText: follow,
          });

          return final;
        }

        const historyMessages = chatHistory.map(
          (text) =>
            new HumanMessage({
              content: [{ type: 'text', text }],
            }),
        );

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

        const sleep = (ms: number) =>
          new Promise((res) => setTimeout(res, ms));

        const createChatCompletion = async (): Promise<any> => {
          let attempt = 0;
          const maxAttempts = 3;
          while (true) {
            try {
              const clientResp = await this.aiClient
                .bindTools(langchainTools)
                .invoke(messagesForLlm);
              return clientResp;
            } catch (err: any) {
              attempt++;
              const isRate =
                err?.code === 'rate_limit_exceeded' ||
                err?.status === 429;
              if (!isRate || attempt >= maxAttempts) throw err;
              const backoff = Math.floor(
                2 ** attempt * 1000 + Math.random() * 1000,
              );
              logger.warn(
                `Rate limit: reintento #${attempt} en ${backoff}ms`,
              );
              await sleep(backoff);
            }
          }
        };

        // 🔹 Primer llamado al modelo con tools
        const response = await createChatCompletion();
        const choice = response;
        const toolCall = choice.tool_calls?.shift?.();

        const totalTokensMain = response?.usage_metadata?.total_tokens;
        const tokensUsedMain = totalTokensMain
          ? parseInt(totalTokensMain.toString(), 10)
          : 0;
        await this.aiCredits.trackTokens(userId, tokensUsedMain);

        // 🔹 Si la IA pidió una tool
        if (toolCall) {
          logger.log(`Tool encontrada, preparando ejecución...`);
          let args: any;
          try {
            args = toolCall.args;
          } catch (e: any) {
            logger.error(
              'Error al parsear los argumentos del toolCall',
              e.message,
            );
            // Si los argumentos vienen dañados, el agente principal responde el error.
            const final = await this.respondAsMainAgent({
              userId,
              sessionId,
              userPrompt: input,
              principalSystemPrompt: promptAI,
              followupText: '[ERROR_TOOL_ARGS_PARSING]',
            });
            return final;
          }

          const toolName = toolCall.name;

          switch (toolName) {
            // Tool de notificación a asesor
            case 'Notificacion_Asesor': {
              const res = await this.notificacionTool.handleNotificacionTool(
                args,
                userId,
                server_url,
                apikey,
                instanceName,
                remoteJid,
              );

              const follow =
                res === 'ok'
                  ? 'Notificación enviada.'
                  : 'No se pudo notificar al asesor.';

              const final = await this.respondAsMainAgent({
                userId,
                sessionId,
                userPrompt: input,
                principalSystemPrompt: promptAI,
                followupText: follow,
              });

              return final;
            }

            // Tool de ejecutar flujos
            case 'Ejecutar_Flujos': {
              const follow = await this.handleExecuteWorkflowTool(
                args,
                userId,
                sessionId,
                server_url,
                apikey,
                instanceName,
                remoteJid,
              );

              const final = await this.respondAsMainAgent({
                userId,
                sessionId,
                userPrompt: input,
                principalSystemPrompt: promptAI,
                followupText: follow,
              });

              return final;
            }

            // Tool desconocida
            default: {
              logger.warn(`Tool no soportada: ${toolCall.name}`);

              const follow = `La herramienta "${toolCall.name}" no está soportada.`;

              const final = await this.respondAsMainAgent({
                userId,
                sessionId,
                userPrompt: input,
                principalSystemPrompt: promptAI,
                followupText: follow,
              });

              return final;
            }
          }
        }

        // 🔹 Si NO hubo tool_call → responde el agente principal directamente
        const finalSinTool = await this.respondAsMainAgent({
          userId,
          sessionId,
          userPrompt: input,
          principalSystemPrompt: promptAI,
          followupText: ERROR_OPENAI_EMPTY_RESPONSE,
        });

        return finalSinTool;
      } catch (error) {
        const logger = this.scopedLogger({ userId, instanceName, remoteJid });
        logger.error(
          'Error procesando entrada con OpenAI.',
          (error as any)?.response?.data || (error as any).message,
        );

        const systemPrompt = await this.promptService
          .getPromptUserId(userId)
          .catch(() => '');
        const extraRules = await this.promptService
          .getPromptPadre('cm842kthc0000qd2l66nbnytv')
          .catch(() => '');
        const promptAI = `${extraRules} ${systemPrompt}`.trim();

        // 👉 LOG EXTRA también en error para ver qué prompt se intentó usar
        logger.log(`Prompt principal (promptAI) usado en error:\n${promptAI}`);

        // Si el cliente LLM se cayó antes de inicializar, devolvemos un texto plano.
        if (!this.aiClient) {
          return 'Ocurrió un error procesando tu solicitud. ¿Deseas intentarlo de nuevo?';
        }

        return await this.respondAsMainAgent({
          userId,
          sessionId,
          userPrompt: '[ERROR_PROCESSING_OPENAI_INPUT]',
          principalSystemPrompt: promptAI,
          followupText:
            'Ocurrió un error procesando tu solicitud. ¿Deseas intentarlo de nuevo?',
        });
      }
    }

    /**
     * Tool Ejecutar_Flujos (AGENTE INTERNO DE FLUJOS).
     *
     * Recibe algo como:
     * {
     *   "nombre_flujo": ["DEMO"],
     *   "descripcion": "El cliente quiere un demo gratis"
     * }
     *
     * 1. Usa openAIToolDetection (systemPromptWorkflow + formattedList)
     *    para mapear al/los nombres de flujos EXACTOS en BD.
     * 2. Ejecuta el flujo correspondiente.
     * 3. Devuelve un texto tipo:
     *    "✅ Flujo *DEMO* iniciado correctamente."
     *
     * Ese texto luego se pasa al agente principal como followupText.
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

      // 🔹 Segundo agente interno: detecta nombres de flujos exactos a partir de args
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
            currentWorkflow.name,
            remoteJid,
            instanceName,
            userId,
          );

          return `✅ Flujo *${currentWorkflow.name}* iniciado correctamente.`;
        } else {
          return `ℹ️ El flujo *${currentWorkflow.name}* ya fue ejecutado anteriormente en esta conversación.`;
        }
      }

      return 'No pude iniciar ningún flujo en este momento. ¿Te puedo ayudar con otra cosa?';
    }

    //Transcribe audio (usado por message-type-handler)
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
        const axiosRes = await axios.get(audioUrl, {
          responseType: 'arraybuffer',
        });
        const audioBuffer = Buffer.from(axiosRes.data);
        const base64Audio = Buffer.from(axiosRes.data).toString('base64');
        const audioStream = Readable.from(audioBuffer);
        (audioStream as any).path = 'audio.ogg';

        if (defaultProvider == 'openai') {
          this.initializeClient(apikeyOpenAi, 'whisper-1', defaultProvider);
          const transcription = await (this.aiClient as any).audio.transcriptions.create(
            {
              file: audioStream,
              model: 'whisper-1',
              response_format: 'text',
            },
          );
          return typeof transcription === 'string'
            ? transcription
            : (transcription as any).text;
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
              : {
                type: 'media',
                data: base64Audio,
                mimeType: `${audioType}`,
              },
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
                url: `data:${
                  imageType == '' ? 'image/jpeg' : imageType
                };base64,${imageBase64}`,
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
  }
