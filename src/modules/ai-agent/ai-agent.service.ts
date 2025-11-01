import axios from 'axios';
import OpenAI from 'openai';
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
import { ERROR_OPENAI_EMPTY_RESPONSE, extraRules, systemPromptWorkflow } from './utils/rulesPrompt';
import { PromptCompressorService } from './services/prompt-compressor/prompt-compressor.service';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
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
    private readonly promptCompressor: PromptCompressorService,
    private readonly llmClientFactory: LlmClientFactory,
  ) { }

  /**
  * Inicializa el cliente de OpenAI con una API Key proporcionada.
  *
  * @param {string} apikeyOpenAi
  */
  private initializeClient(apikeyOpenAi: string,  model:string,provider:string): BaseChatModel {
    console.log('error? busca los...',provider,model,apikeyOpenAi,'fueron los modelos',)
    // if (!this.isValidApiKey(apikeyOpenAi)) {
    //   this.logger.error('API Key inválida o no proporcionada.', '', 'AiAgentService');
    // }
    // this.openAiClient = new OpenAI({ apiKey: apikeyOpenAi });
    //const apiKey = 'AIzaSyAD9lijxH_RCeKTOi0YEuTI4CznvKdP3jA' // solo para pruebas con gemini
    // const apikeyAlternativa = 'AIzaSyD-Llg1QYeLc39gM02FEA_TdxGpsInfclQ'
    //Modelo de ia a utilizar
    this.aiClient = this.llmClientFactory.getClient({ provider: provider,apiKey:apikeyOpenAi, model:model })
    return this.aiClient
  };

  /**
  * Valida si una API Key parece válida.
  *
  * @param {string} apikeyOpenAi
  * @returns {boolean}
  */
  private isValidApiKey(apikeyOpenAi: string): boolean {
    return typeof apikeyOpenAi === 'string' && apikeyOpenAi.startsWith('sk-') && apikeyOpenAi.length >= 40;
  };

  /**
  * Procesa la entrada de texto del usuario.
  *
  * @param {string} input
  * @param {string} userId
  * @param {string} apikeyOpenAi
  * @param {string} sessionId - ID de la sesión (ej: instance_name + remotejid)
  * @returns {Promise<string>}
  */

  private async getWeather(location: string): Promise<string> {
    // Aquí podrías hacer una llamada real a una API de clima
    return `Soleado y 25°C en ${location}`; // Respuesta simulada
  };

  /**
   * 🔸 NUEVO: SIEMPRE FINALIZA COMO AGENTE PRINCIPAL
   * Dado un resultado de tool o de sistema, el agente principal responde al usuario.
   */
  private async respondAsMainAgent(params: {
    userId: string;
    sessionId: string;
    userPrompt: string;        // Lo que el usuario dijo originalmente (o contexto relevante)
    principalSystemPrompt: string; // promptAI ya armado (extraRules + flujos + systemPrompt)
    followupText: string;      // Resultado crudo de tool / texto a “traducir” para el usuario
  }): Promise<string> {
    const { userId, sessionId, userPrompt, principalSystemPrompt, followupText } = params;

    const chatHistory = await this.chatHistoryService.getChatHistory(sessionId);

    const systemMessage = new SystemMessage({
      content: [{
        type: 'text',
        text:
`${principalSystemPrompt}

REGLA CRÍTICA:
- Si se ejecutó una tool, EL AGENTE PRINCIPAL es quien da la respuesta final al usuario.
- Responde de forma natural, útil y **sin revelar detalles internos** (IDs, nombres de tools).
- Usa el resultado siguiente para construir la respuesta final al usuario.

[RESULTADO_TOOL]
${followupText}`
      }]
    });

    const historyMessages = chatHistory.map(text => new HumanMessage({
      content: [{ type: "text", text }],
    }));

    const rawUser = new HumanMessage({
      content: [{ type: 'text', text: userPrompt }]
    });

    const completion = await this.aiClient.invoke([
      systemMessage,
      ...historyMessages,
      rawUser,
    ]);

    const totalTokens = completion?.usage_metadata?.total_tokens;
    const tokensUsed = totalTokens ? parseInt(totalTokens.toString(), 10) : 0;
    await this.aiCredits.trackTokens(userId, tokensUsed);

    return completion.content?.toString()?.trim() || followupText;
  }

  /**
  * Se procesa la tool con openAI - segundo agente
  *
  * @private
  * @param input - msg
  * @param sessionId - Nombre de la instancia en Evolution API
  * @param userId - Identificador del usuario
  * @returns {Promise<string>}
  */
  private async openAIToolDetection({
    input,
    sessionId,
    userId
  }: openAIToolDetection): Promise<OpenAIDetectionResult> {
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

      this.logger.log(`Lista de flujos: ${JSON.stringify(formattedList)}`);
      this.logger.log(`Lista de flujos: ${JSON.stringify(workflows)}`);

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
        this.logger.warn('Content inválido o vacío');
        return { content: null };
      }

      return { content }
    } catch (error) {
      this.logger.error('Error procesando entrada con OpenAI.', error?.response?.data || error.message, 'AiAgentService');
      return { content: null }
    }
  };

  /**
  * Se procesa el texto 
  *
  * @private
  * @param input - msg
  * @param userId - User ID
  * @param apikeyOpenAi - API Key Open AI
  * @param sessionId - Nombre de la instancia en Evolution API
  * @param server_url - URL base del servidor Evolution
  * @param apikey - API Key para autorización con Evolution
  * @param instanceName - Nombre de la instancia en Evolution API
  * @param remoteJid - Número del cliente en formato WhatsApp
  * @returns {Promise<string>}
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
    remoteJid
  }: proccessInput): Promise<string> {
    let promptAI = ''; // Declarar aquí para que esté disponible en el catch
    try {
      this.initializeClient(apikeyOpenAi,defaultModel,defaultProvider);

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

      // Extrae respuesta literal post-flujo (si existe) desde el system prompt
      const match = systemPrompt.match(/Comportamiento: Después de ejecutar el flujo, tu única respuesta es la que se te indique en Regla\/parámetro\.\n\n\*\s*([^\n]+)/i);
      const workflowSuccessResponse = match ? match[1].trim() : "¡Hola! ¿En qué puedo ayudarte?";
      this.logger.log(`Respuesta literal de workflow extraída: ${workflowSuccessResponse}`);

      const hasInicioBienvenida = workflows?.some(
        (w: any) =>
          typeof w?.name === 'string' &&
          w.name.trim().toLowerCase() === this.initWorkflowName.toLowerCase()
      );

      // 🔹 prompt del AGENTE PRINCIPAL (se reutiliza para toda respuesta final)
      const workflowTrigger = `lista de flujos disponibles ${formattedList}`
      promptAI = `${extraRules} ${workflowTrigger} ${systemPrompt}`;

      // Si es primer mensaje y hay INICIO_BIENVENIDA -> ejecutar tool y responder como Agente Principal
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
          workflowSuccessResponse
        );

        // result ya es “final” como agente principal (por la ruta común)
        return result;
      }

      // =====================================================================
      // INICIO - Construcción de mensajes para el LLM
      // =====================================================================
      const historyMessages = chatHistory.map(text => new HumanMessage({
        content: [{ type: "text", text }],
      }));

      const rawInputMessage = new HumanMessage({
        content: [{ type: "text", text: input }],
      });

      const systemMessage = new SystemMessage({
        content: [{ type: "text", text: promptAI }],
      });

      this.logger.debug(`PROMPT AI =======> ${JSON.stringify(promptAI)}`);
      this.logger.debug(`CHAT HISTORY (CRUDE) =======> ${JSON.stringify(chatHistory)}`);

      const messagesForLlm = [
        systemMessage,
        ...historyMessages,
        rawInputMessage,
      ];
      // =====================================================================
      // FIN - Construcción de mensajes para el LLM
      // =====================================================================

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
            this.logger.warn(`Rate limit: reintento #${attempt} en ${backoff}ms`);
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

      // Procesamiento de tool -> SIEMPRE responde el agente principal
      if (toolCall) {
        this.logger.log(`Tool encontrada, preparando ejecución...`);
        let args;
        try {
          args = toolCall.args;
        } catch (e) {
          this.logger.error('Error al parsear los argumentos del toolCall', e.message);
          // Pasar error al principal para que él responda
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
          case 'notificacion': {
            this.logger.log('Activada notificacion a...', remoteJid);
            await this.notificacionTool.handleNotificacionTool(
              args, userId, server_url, apikey, instanceName, remoteJid
            );

            const toolExecutionResult = "Notificación a asesor enviada exitosamente.";
            return await this.respondAsMainAgent({
              userId,
              sessionId,
              userPrompt: input,
              principalSystemPrompt: promptAI,
              followupText: toolExecutionResult
            });
          }

          case 'execute_workflow': {
            // Se encarga internamente y regresa YA como agente principal
            return await this.handleExecuteWorkflowTool(
              args,
              userId,
              apikeyOpenAi,
              sessionId,
              server_url,
              apikey,
              instanceName,
              remoteJid,
              input,                 // userPrompt real
              workflowSuccessResponse
            );
          }

          default:
            this.logger.warn(`Tool no soportada: ${toolCall.name}`, 'AiAgentService');
            return await this.respondAsMainAgent({
              userId,
              sessionId,
              userPrompt: input,
              principalSystemPrompt: promptAI,
              followupText: `La herramienta "${toolCall.name}" no está soportada.`
            });
        }
      }

      // Si no hubo tool, responde normal (contenido directo)
      const direct = choice?.content?.toString()?.trim();
      if (direct) return direct;

      // Fallback
      return await this.respondAsMainAgent({
        userId,
        sessionId,
        userPrompt: input,
        principalSystemPrompt: promptAI,
        followupText: ERROR_OPENAI_EMPTY_RESPONSE
      });

    } catch (error) {
      this.logger.error('Error procesando entrada con OpenAI.', error?.response?.data || error.message, 'AiAgentService');
      // Fallback también como agente principal
      const systemPrompt = await this.promptService.getPromptUserId(userId).catch(() => '');
      const workflows = await this.workflowService.getWorkflow(userId).catch(() => []);
      const formattedList = Array.isArray(workflows) ? workflows.map((flow, index) => {
        return `{
    "id": ${index + 1},
    "nombre": "${flow?.name || ''}",
    "descripcion": "${flow?.description || 'Sin descripción'}"
   }`;
      }).join(',\n') : '';

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
    successResponseLiteral?: string
  ): Promise<string> {
    this.logger.log('Se esta ejecutando una tool... 😎')

    // Prepara el prompt principal para la respuesta final
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
    } catch (e) {
      this.logger.error('Error al parsear el contenido JSON de OpenAI', e.message);
      return await this.respondAsMainAgent({
        userId,
        sessionId,
        userPrompt,
        principalSystemPrompt: principalPrompt,
        followupText: '[ERROR_PARSE_RAW_CONTENT]'
      });
    }

    this.logger.log(`Flujos detectados: ${JSON.stringify(nombresDetectados)}`);

    for (const nombre of nombresDetectados) {
      const currentWorkflow = workflows.find(
        (w) => w.name?.toLowerCase?.() === nombre?.toLowerCase?.()
      );

      if (!currentWorkflow) {
        this.logger.warn(`El flujo "${nombre}" no fue encontrado.`);
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

        // Si es INICIO_BIENVENIDA y tenemos literal → lo usa el Agente Principal
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

        // Para otros flujos, mensaje estándar hacia el principal
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

    // Si ninguno aplicó
    return await this.respondAsMainAgent({
      userId,
      sessionId,
      userPrompt,
      principalSystemPrompt: principalPrompt,
      followupText: 'No pude iniciar ningún flujo en este momento. ¿Te puedo ayudar con otra cosa?'
    });
  };

  /**
   * (Queda por compatibilidad — ya no se usa directamente desde tools;
   *  toda finalización va por respondAsMainAgent)
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
  * Transcribe un archivo de audio utilizando el agente.
  * y devuelve su transcripcion
  *
  * @param {string} audioUrl
  * @returns {Promise<string>
  */
  async transcribeAudio(audioUrl: string, audioType: string, apikeyOpenAi: string, data: any,defaultModel:string,
    defaultProvider:string,): Promise<string> {
    try {
      this.initializeClient(apikeyOpenAi,defaultModel,
    defaultProvider,);
      const axiosRes = await axios.get(audioUrl, { responseType: "arraybuffer" });
      const base64Audio = Buffer.from(axiosRes.data).toString("base64");
      const message = new HumanMessage({
        content: [
          { type: "text", text: "Transcribe de forma clara y detallada este audio." },
          {
            "type": "media",
            "data": base64Audio,
            "mimeType": `${audioType}`
          },
        ],
      })
      const state = await this.aiClient.invoke([message])
      return state.content.toString()
    } catch (error) {
      this.logger.error('Error transcribiendo audio.', error?.response?.data || error.message, 'AiAgentService');
      return '[ERROR_TRANSCRIBING_AUDIO]';
    }
  };

  /**
  * Describe una imagen utilizando OpenAI GPT-4 con input de imagen.
  *
  * @param {string} imageUrl
  * @returns {Promise<string>}
  */
  async describeImage(data: any, imageBase64: string, imageType: string, apikeyOpenAi: string,defaultModel:string,
    defaultProvider:string): Promise<string> {
    try {
      this.initializeClient(apikeyOpenAi,defaultModel,
    defaultProvider,);
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
    } catch (error) {
      this.logger.error('Error describiendo imagen.', error?.response?.data || error.message, 'AiAgentService');
      return '[ERROR_DESCRIBING_IMAGE]';
    }
  };
}
