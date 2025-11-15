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
import { inputWorkflow, OpenAIDetectionResult, openAIToolDetection, proccessInput } from 'src/types/open-ai';
import { NotificacionToolService } from './tools/notificacion/notificacion.service';
import { AiCreditsService } from '../ai-credits/ai-credits.service';
import { tools } from './utils/tools';
import { ERROR_OPENAI_EMPTY_RESPONSE, systemPromptWorkflow } from './utils/rulesPrompt';
import { PromptCompressorService } from './services/prompt-compressor/prompt-compressor.service';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SessionService } from '../session/session.service';
import { tool } from '@langchain/core/tools';

// Refactor
import { LlmClientFactory } from './services/llmClientFactory/llmClientFactory.service';
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { langchainTools } from './utils/langchainTools';

@Injectable()
export class AiAgentService {
  private openAiClient: OpenAI;
  // Refactor
  private aiClient;
  // Refactor
  private readonly initWorkflowName: string = 'INICIO_BIENVENIDA';

  constructor(
    private readonly logger: LoggerService,
    private readonly promptService: PromptService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly workflowService: WorkflowService,
    private readonly notificacionTool: NotificacionToolService,
    private readonly aiCredits: AiCreditsService,
    private readonly llmClientFactory: LlmClientFactory,
    private readonly sessionService: SessionService
  ) { }

  /**
   * Logger con contexto fijo:
   * [UID=...][I=...][R=...]
   */
  private scopedLogger(ctx: { userId?: string; instanceName?: string; remoteJid?: string }) {
    const tag = `[UID=${ctx.userId ?? '-'}][I=${ctx.instanceName ?? '-'}][R=${ctx.remoteJid ?? '-'}]`;
    return {
      log: (msg: string, context = 'AiAgentService') => this.logger.log(`${tag} ${msg}`, context),
      warn: (msg: string, context = 'AiAgentService') => this.logger.warn(`${tag} ${msg}`, context),
      error: (msg: string, err?: any, context = 'AiAgentService') => this.logger.error(`${tag} ${msg}`, err, context),
    };
  }

  /**
  * Inicializa el cliente de OpenAI con una API Key proporcionada.
  *
  * @param {string} apikeyOpenAi
  */
  private initializeClient(apikeyOpenAi: string, model: string, provider: string): BaseChatModel {
    console.log('error? busca los...', provider, model, apikeyOpenAi, 'fueron los modelos',)
    this.aiClient = this.llmClientFactory.getClient({ provider: provider, apiKey: apikeyOpenAi, model: model })
    return this.aiClient
  };

  /**
  * Valida si una API Key parece válida.
  */
  private isValidApiKey(apikeyOpenAi: string): boolean {
    return typeof apikeyOpenAi === 'string' && apikeyOpenAi.startsWith('sk-') && apikeyOpenAi.length >= 40;
  };

  /**
   * 🔧 Hotfix robusto: algunos modelos devuelven JSON {"tool": "..."} en texto.
   * - Limpia fences (```json ... ```), tolera texto alrededor y sinónimos.
   */

  private async getWeather(location: string): Promise<string> {
    return `Soleado y 25°C en ${location}`;
  };

  /**
   * 🔸 SIEMPRE FINALIZA COMO AGENTE PRINCIPAL
   */
  private async respondAsMainAgent(params: {
    userId: string;
    sessionId: string;
    userPrompt: string;
    principalSystemPrompt: string;
    followupText: string;
  }): Promise<string> {
    const { userId, sessionId, userPrompt, principalSystemPrompt, followupText } = params;

    const chatHistory = await this.chatHistoryService.getChatHistory(sessionId);

    const systemMessage = new SystemMessage({
      content: [{
        type: 'text',
        text: `${principalSystemPrompt}`
      }]
    });



    const historyMessages = chatHistory.map(text => new HumanMessage({ content: [{ type: "text", text }] }));
    const rawUser = new HumanMessage({ content: [{ type: 'text', text: userPrompt }] });

    const completion = await this.aiClient.invoke([
      systemMessage,
      ...historyMessages,
      rawUser,
    ]);

    const totalTokens = completion?.usage_metadata?.total_tokens;
    const tokensUsed = totalTokens ? parseInt(totalTokens.toString(), 10) : 0;
    await this.aiCredits.trackTokens(userId, tokensUsed);

    const rawOut = completion.content?.toString()?.trim() || followupText;
    return rawOut
  }

  /**
  * Detección de tools (segundo agente)
  */
  private async openAIToolDetection({
    input,
    sessionId,
    userId
  }: openAIToolDetection): Promise<OpenAIDetectionResult> {
    const logger = this.scopedLogger({ userId });
    try {
      const chatHistory = await this.chatHistoryService.getChatHistory(sessionId);
      const workflows = await this.workflowService.getWorkflow(userId);

      const formattedList = workflows.map((flow, index) => {
        return `{
    "id": ${index + 1},
    "nombre": "${flow.name}",
    "descripcion": "${flow.description || 'Sin descripción'}"
   }`
      }).join(',\n');

      logger.log(`Lista de flujos (texto): ${JSON.stringify(formattedList)}`);
      logger.log(`Lista de flujos (obj): ${JSON.stringify(workflows)}`);

      const customWorkflowPrompt = systemPromptWorkflow(input, JSON.stringify(formattedList));

      const messagesR = [
        new SystemMessage({
          content: [
            { type: "text", text: customWorkflowPrompt },
          ]
        }),
        ...chatHistory.map(text => new HumanMessage({
          content: [{ type: "text", text }],
        })),
        new HumanMessage({
          content: [{ type: "text", text: JSON.stringify(input) }],
        })
      ]

      const responseR = await this.aiClient.invoke(messagesR)

      const choice = responseR.content.toString()
      const content = choice.trim()
      const totalTokensR = responseR?.usage_metadata?.total_tokens;
      const tokensUsedR = totalTokensR ? parseInt(totalTokensR.toString(), 10) : 0;
      await this.aiCredits.trackTokens(userId, tokensUsedR);

      if (!choice || !content) {
        logger.warn('Content inválido o vacío');
        return { content: null };
      }

      return { content }
    } catch (error) {
      logger.error('Error procesando entrada con OpenAI.', (error as any)?.response?.data || (error as any).message);
      return { content: null }
    }
  };

  /**
  * Proceso principal de entrada
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
      this.initializeClient(apikeyOpenAi, defaultModel, defaultProvider);

      const systemPrompt = await this.promptService.getPromptUserId(userId);
      const chatHistory = await this.chatHistoryService.getChatHistory(sessionId);
      const noHistory = !Array.isArray(chatHistory) || chatHistory.length === 0;
      const workflows = await this.workflowService.getWorkflow(userId);

      const formattedList = workflows.map((flow, index) => {
        return `{
    "id": ${index + 1},
    "nombre": "${flow.name}",
    "descripcion": "${flow.description || 'Sin descripción'}"
   }`;
      }).join(',\n');

      const match = systemPrompt.match(/Comportamiento: Después de ejecutar el flujo, tu única respuesta es la que se te indique en Regla\/parámetro\.\n\n\*\s*([^\n]+)/i);
      const workflowSuccessResponse = match ? match[1].trim() : "¡Hola! ¿En qué puedo ayudarte?";
      logger.log(`Respuesta literal de workflow extraída: ${workflowSuccessResponse}`);

      const hasInicioBienvenida = workflows?.some(
        (w: any) =>
          typeof w?.name === 'string' &&
          w.name.trim().toLowerCase() === this.initWorkflowName.toLowerCase()
      );

      const workflowTrigger = `lista de flujos disponibles ${formattedList}`

      const extraRules = await this.promptService.getPromptPadre('cm842kthc0000qd2l66nbnytv').catch(() => '');
      promptAI = `${extraRules} ${workflowTrigger} ${systemPrompt}`;
      

      if (noHistory && hasInicioBienvenida) {
        const result = await this.handleExecuteWorkflowTool(
          { nombre_flujo: [this.initWorkflowName] } as any,
          userId,
          apikeyOpenAi,
          sessionId,
          server_url,
          apikey,
          instanceName,
          remoteJid,
          this.initWorkflowName,
          extraRules,
          workflowSuccessResponse,
        );
        return result;
      }

      const historyMessages = chatHistory.map(text => new HumanMessage({
        content: [{ type: "text", text }],
      }));

      const rawInputMessage = new HumanMessage({
        content: [{ type: "text", text: input }],
      });

      const systemMessage = new SystemMessage({
        content: [{ type: "text", text: promptAI }],
      });

      const messagesForLlm = [
        systemMessage,
        ...historyMessages,
        rawInputMessage,
      ];

      const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

      const createChatCompletion = async (): Promise<any> => {
        let attempt = 0;
        const maxAttempts = 3;
        while (true) {
          try {
            const clientResp = await this.aiClient.bindTools(langchainTools).invoke(messagesForLlm);
            return clientResp
          } catch (err: any) {
            attempt++;
            const isRate = err?.code === 'rate_limit_exceeded' || err?.status === 429;
            if (!isRate || attempt >= maxAttempts) throw err;
            const backoff = Math.floor((2 ** attempt) * 1000 + Math.random() * 1000);
            logger.warn(`Rate limit: reintento #${attempt} en ${backoff}ms`);
            await sleep(backoff);
          }
        }
      };

      const response = await createChatCompletion();
      const choice = response;
      const toolCall = choice.tool_calls?.shift?.();

      const totalTokensMain = response?.usage_metadata?.total_tokens;
      const tokensUsedMain = totalTokensMain ? parseInt(totalTokensMain.toString(), 10) : 0;
      await this.aiCredits.trackTokens(userId, tokensUsedMain);

      if (toolCall) {
        logger.log(`Tool encontrada, preparando ejecución...`);
        let args;
        try {
          args = toolCall.args;
        } catch (e: any) {
          logger.error('Error al parsear los argumentos del toolCall', e.message);
          //Esto pasa cuando la tool sale error o no encuentra
          return await this.respondAsMainAgent({
            userId,
            sessionId,
            userPrompt: input,
            principalSystemPrompt: promptAI,
            followupText: '[ERROR_TOOL_ARGS_PARSING]'
          });
        }

        const toolName = toolCall.name;

        switch (toolName) {
          case 'Notificacion_Asesor': {
            const res = await this.notificacionTool.handleNotificacionTool(
              args, userId, server_url, apikey, instanceName, remoteJid
            );
            
            //Ejecuta el agentes despues de notificacion
            const clientRes =await this.respondAsMainAgent({
              userId,
              sessionId,
              userPrompt: input,
              principalSystemPrompt: promptAI,
              followupText: res === 'ok' ? 'Notificación enviada.' : 'No se pudo notificar al asesor.'
            });
            
            return `${clientRes}`
          }
          case 'Ejecutar_Flujos': {
            return await this.handleExecuteWorkflowTool(
              args,
              userId,
              apikeyOpenAi,
              sessionId,
              server_url,
              apikey,
              instanceName,
              remoteJid,
              input,
              extraRules,
              workflowSuccessResponse,
            );
          }

          default:
            logger.warn(`Tool no soportada: ${toolCall.name}`);

            //Todvia no se en que momento se ejecuta
            const flujosR = await this.respondAsMainAgent({
              userId,
              sessionId,
              userPrompt: input,
              principalSystemPrompt: '',
              followupText: `La herramienta "${toolCall.name}" no está soportada.`
            });

            return `${flujosR}`
        }
      }

      // 🔧 Hotfix: si el modelo devolvió JSON en texto con {"tool": "..."} en vez de tool_calls

      //Revisando si es este
      const RFlujos= await this.respondAsMainAgent({
        userId,
        sessionId,
        userPrompt: input,
        principalSystemPrompt: promptAI,
        followupText: ERROR_OPENAI_EMPTY_RESPONSE
      });

      return `${RFlujos}`

    } catch (error) {
      const logger = this.scopedLogger({ userId, instanceName, remoteJid });
      logger.error('Error procesando entrada con OpenAI.', (error as any)?.response?.data || (error as any).message);
      const systemPrompt = await this.promptService.getPromptUserId(userId).catch(() => '');
      const workflows = await this.workflowService.getWorkflow(userId).catch(() => []);
      const formattedList = Array.isArray(workflows) ? workflows.map((flow, index) => {
        return `{
    "id": ${index + 1},
    "nombre": "${flow?.name || ''}",
    "descripcion": "${flow?.description || 'Sin descripción'}"
   }`;
      }).join(',\n') : '';

      const extraRules = await this.promptService.getPromptPadre(userId).catch(() => '');
      const promptAI = `${extraRules} lista de flujos disponibles ${formattedList} ${systemPrompt}`;

      return await this.respondAsMainAgent({
        userId,
        sessionId,
        userPrompt: '[ERROR_PROCESSING_OPENAI_INPUT]',
        principalSystemPrompt: promptAI,
        followupText: 'Ocurrió un error procesando tu solicitud. ¿Deseas intentarlo de nuevo?'
      });
    }
  };

  private async handleExecuteWorkflowTool(
    args: inputWorkflow,
    userId: string,
    apikeyOpenAi: string,
    sessionId: string,
    server_url: string,
    apikey: string,
    instanceName: string,
    remoteJid: string,
    userPrompt: string,
    extraRules:string,
    successResponseLiteral?: string,
  ): Promise<string> {
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });
    logger.log('Se esta ejecutando una tool... 😎')

    const systemPrompt = await this.promptService.getPromptUserId(userId).catch(() => '');
    const workflows = await this.workflowService.getWorkflow(userId).catch(() => []);
    const formattedList = Array.isArray(workflows) ? workflows.map((flow, index) => {
      return `{
    "id": ${index + 1},
    "nombre": "${flow?.name || ''}",
    "descripcion": "${flow?.description || 'Sin descripción'}"
   }`;
    }).join(',\n') : '';

    const principalPrompt = `${extraRules} lista de flujos disponibles ${formattedList} ${systemPrompt}`;

    const detectionResult = await this.openAIToolDetection({
      input: args,
      sessionId,
      userId
    });
    const raw = detectionResult.content?.toString()?.trim();

    if (!raw || raw.toLowerCase() === 'ninguno') {
      return await this.respondAsMainAgent({
        userId,
        sessionId,
        userPrompt,
        principalSystemPrompt: principalPrompt,
        followupText: 'Disculpa, no encontré información relacionada. ¿Te puedo ayudar con algo más?'
      });
    }

    let nombresDetectados: string[] = [];
    try {
      const parsed = JSON.parse(raw);
      nombresDetectados = parsed?.nombre_flujo || [];

      if (!Array.isArray(nombresDetectados) || nombresDetectados.length === 0) {
        return await this.respondAsMainAgent({
          userId,
          sessionId,
          userPrompt,
          principalSystemPrompt: principalPrompt,
          followupText: 'No se detectó ningún flujo compatible con tu solicitud.'
        });
      }
    } catch (e: any) {
      logger.error('Error al parsear el contenido JSON de OpenAI', e.message);
      return await this.respondAsMainAgent({
        userId,
        sessionId,
        userPrompt,
        principalSystemPrompt: principalPrompt,
        followupText: '[ERROR_PARSE_RAW_CONTENT]'
      });
    }

    logger.log(`Flujos detectados: ${JSON.stringify(nombresDetectados)}`);

    for (const nombre of nombresDetectados) {
      const currentWorkflow = workflows.find(
        (w) => w.name?.toLowerCase?.() === nombre?.toLowerCase?.()
      );

      if (!currentWorkflow) {
        logger.warn(`El flujo "${nombre}" no fue encontrado.`);
        continue;
      }

      const alreadyExecuted = await this.chatHistoryService.hasIntentionBeenExecuted(
        sessionId,
        currentWorkflow.name
      );

      if (!alreadyExecuted) {
        await this.chatHistoryService.registerExecutedIntention(
          sessionId,
          currentWorkflow.name,
          'intention'
        );

        await this.workflowService.executeWorkflow(
          currentWorkflow.name,
          server_url,
          apikey,
          instanceName,
          remoteJid,
          userId
        );
        logger.log(`[Workflow]: ${currentWorkflow.name} ejecutado, registrando en session ${remoteJid}`)
        await this.sessionService.registerWorkflow(currentWorkflow.name, remoteJid, instanceName, userId)

        if (currentWorkflow.name.trim().toUpperCase() === this.initWorkflowName.toUpperCase()
          && successResponseLiteral) {
          return await this.respondAsMainAgent({
            userId,
            sessionId,
            userPrompt,
            principalSystemPrompt: principalPrompt,
            followupText: successResponseLiteral
          });
        }

        const follow = `✅ Flujo *${currentWorkflow.name}* iniciado correctamente.`;

        return await this.respondAsMainAgent({
          userId,
          sessionId,
          userPrompt,
          principalSystemPrompt: principalPrompt,
          followupText: follow
        });

      } else {
        const follow = `ℹ️ Ya ejecutado: *${currentWorkflow.name}*`;
        return await this.respondAsMainAgent({
          userId,
          sessionId,
          userPrompt,
          principalSystemPrompt: principalPrompt,
          followupText: follow
        });
      }
    }

    return await this.respondAsMainAgent({
      userId,
      sessionId,
      userPrompt,
      principalSystemPrompt: principalPrompt,
      followupText: 'No pude iniciar ningún flujo en este momento. ¿Te puedo ayudar con otra cosa?'
    });
  };

  /**
   * (Compatibilidad)
   */
  private async processAgentFollowup(
    followupText: string,
    userPrompt: string,
  ): Promise<string> {
    const finalPrompt = `El flujo automatizado respondió: "${followupText}". Ahora responde al usuario de manera natural y útil.`;
    const messages = [
      new SystemMessage({
        content: [
          {
            type: "text",
            text: "Eres un asistente útil que traduce resultados de flujos automatizados a lenguaje natural para el usuario final."
          },
          { type: 'text', text: followupText }
        ]
      }),
      new HumanMessage({
        content: [
          { type: 'text', text: userPrompt },
        ]
      }),
      new HumanMessage({
        content: [
          { type: 'text', text: finalPrompt },
        ]
      }),
    ]

    const completionR = await this.aiClient.invoke(messages)
    const finalMessageR = completionR.content.toString() || followupText;
    return finalMessageR;
  }

  /**
  * Transcribe audio
  */
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
      const axiosRes = await axios.get(audioUrl, { responseType: "arraybuffer" });
      const audioBuffer = Buffer.from(axiosRes.data);
      const base64Audio = Buffer.from(axiosRes.data).toString("base64");
      const audioStream = Readable.from(audioBuffer);
      (audioStream as any).path = "audio.ogg";

      if (defaultProvider == 'openai') {
        this.initializeClient(apikeyOpenAi, 'whisper-1', defaultProvider);
        const transcription = await this.aiClient.audio.transcriptions.create({
          file: audioStream,
          model: 'whisper-1',
          response_format: 'text',
        })
        return typeof transcription === "string"
          ? transcription
          : transcription.text;
      }
      this.initializeClient(apikeyOpenAi, defaultModel, defaultProvider);

      const message = new HumanMessage({
        content: [
          { type: "text", text: "Transcribe de forma clara y detallada este audio." },
          defaultProvider == 'openai'
            ? { type: "input_audio", input_audio: { data: base64Audio, format: `${audioType}` } }
            : { type: "media", data: base64Audio, mimeType: `${audioType}` },
        ],
      })
      const state = await this.aiClient.invoke([message])
      return state.content.toString()
    } catch (error: any) {
      logger.error('Error transcribiendo audio.', error?.response?.data || error.message);
      logger.error('Error transcribiendo audio.', error?.message || JSON.stringify(error, null, 2));
      return '[ERROR_TRANSCRIBING_AUDIO]';
    }
  };

  /**
   * Describe imagen
   */
  async describeImage(
    data: any,
    imageBase64: string,
    imageType: string,
    apikeyOpenAi: string,
    defaultModel: string,
    defaultProvider: string
  ): Promise<string> {
    const logger = this.scopedLogger({}); // sin contexto en firma
    try {
      this.initializeClient(apikeyOpenAi, defaultModel, defaultProvider);
      const message = new HumanMessage({
        content: [
          { type: "text", text: "Describe de forma clara y detallada el contenido de esta imagen." },
          {
            type: "image_url",
            image_url: { url: `data:${imageType == '' ? 'image/jpeg' : imageType};base64,${imageBase64}` },
          },
        ],
      })
      const response = await this.aiClient.invoke([message])
      return response.content.toString() ?? '[ERROR_DESCRIBING_IMAGE]'
    } catch (error: any) {
      logger.error('Error describiendo imagen.', error?.response?.data || error.message);
      return '[ERROR_DESCRIBING_IMAGE]';
    }
  };
}
