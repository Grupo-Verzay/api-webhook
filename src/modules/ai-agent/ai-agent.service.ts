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
  private initializeClient(apikeyOpenAi: string): BaseChatModel {
    if (!this.isValidApiKey(apikeyOpenAi)) {
      this.logger.error('API Key inválida o no proporcionada.', '', 'AiAgentService');
    }
    this.openAiClient = new OpenAI({ apiKey: apikeyOpenAi });
    const apiKey = 'AIzaSyAD9lijxH_RCeKTOi0YEuTI4CznvKdP3jA'
    //Modelo de ia a utilizar
    this.aiClient = this.llmClientFactory.getClient({ provider: 'google', apiKey, model: 'gemini-2.5-flash' })
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

      const historyMessages: ChatCompletionMessageParam[] = chatHistory.map((text) => ({
        role: 'user',
        content: text,
      }));

      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: customWorkflowPrompt },
        ...historyMessages,
        { role: 'user', content: JSON.stringify(input) },
      ];

      const messagesR = [
        new SystemMessage({
          content: [
            {
              type: "text",
              text: customWorkflowPrompt
            },
          ]
        }),
        ...chatHistory.map(text => new HumanMessage({
          content: [{
            type: "text",
            text: text
          }],
        })),
        new HumanMessage({
          content: [{
            type: "text",
            text: JSON.stringify(input)
          }],
        })
      ]

      const responseR = await this.aiClient.invoke(messagesR)

      // const choice: any = response.choices?.[0];
      // const choice: any = response.choices?.[0];
      // const content = choice?.message?.content?.trim();

      const choice = responseR.content.toString()
      const content = choice.trim()
      // ⭐ CORRECCIÓN: Eliminar 'await' y validar la ruta de propiedades de forma segura.
      const totalTokensR = responseR?.usage_metadata?.total_tokens;
      const tokensUsedR = totalTokensR ? parseInt(totalTokensR.toString(), 10) : 0;
      console.log('los tokens usados son...', responseR.usage_metadata?.total_tokens, tokensUsedR) // Usar el valor corregido
      await this.aiCredits.trackTokens(userId, tokensUsedR);


      if (!choice || !content) {
        this.logger.warn('Content inválido o vacío');
        return { content: null };
      }

      return {
        content
      }

    } catch (error) {
      this.logger.error('Error procesando entrada con OpenAI.', error?.response?.data || error.message, 'AiAgentService');
      return {
        content: null
      }
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
    sessionId,
    server_url,
    apikey,
    instanceName,
    remoteJid
  }: proccessInput) {
    let promptAI = ''; // Declarar aquí para que esté disponible en el catch
    console.log('esto son los datos que estoy obteniendo para userId',userId)

    try {
      this.initializeClient(apikeyOpenAi);

      const systemPrompt = await this.promptService.getPromptUserId(userId);
      const chatHistory = await this.chatHistoryService.getChatHistory(sessionId);
      // 1) Validar la respuesta de chatHistory (sin historial)
      const noHistory = !Array.isArray(chatHistory) || chatHistory.length === 0;
      const workflows = await this.workflowService.getWorkflow(userId);

      const formattedList = workflows.map((flow, index) => {
        return `{
        "id": ${index + 1},
        "nombre": "${flow.name}",
        "descripcion": "${flow.description || 'Sin descripción'}"
      }`;
      }).join(',\n');

      // 2) Validar que en la lista (formattedList/workflows) exista this.initWorkflowName
      const hasInicioBienvenida = workflows?.some(
        (w: any) =>
          typeof w?.name === 'string' &&
          w.name.trim().toLowerCase() === this.initWorkflowName
      );

      // 3) Si NO hay historial y existe el flujo, ejecutarlo vía tool "execute_workflow"
      if (noHistory && hasInicioBienvenida) {
        // Mantengo tu misma ruta de ejecución de tools para no duplicar lógica:
        await this.handleExecuteWorkflowTool(
          { nombre_flujo: [this.initWorkflowName] } as any, // <- args esperados por tu tool
          userId,
          apikeyOpenAi,
          sessionId,
          server_url,
          apikey,
          instanceName,
          remoteJid,
          this.initWorkflowName // userPrompt (no se usa para responder; handle... retorna '')
        );

        // Importante: corta aquí para que el agente NO responda después de ejecutar el flujo
        // return '';
      }

      const workflowTrigger = `lista de flujos disponibles ${formattedList}`
      promptAI = `${extraRules} ${workflowTrigger} ${systemPrompt}`;


      // =====================================================================
      // CAMBIO: Se elimina toda lógica de compresión de historial e input.
      // Se usan los datos crudos directamente.
      // =====================================================================

      // 1) Historial (NO COMPRIMIDO)
      const historyMessages = chatHistory.map(text => new HumanMessage({
          content: [{ type: "text", text: text }],
      }));

      // 2) Input del usuario (NO COMPRIMIDO)
      const rawInputMessage = new HumanMessage({
          content: [{ type: "text", text: input }],
      });
      
      const systemMessage = new SystemMessage({
          content: [{ type: "text", text: promptAI }],
      });

      this.logger.debug(`PROMPT AI =======> ${JSON.stringify(promptAI)}`);
      this.logger.debug(`CHAT HISTORY (CRUDE) =======> ${JSON.stringify(chatHistory)}`);

      // 3) Construcción de mensajes para la invocación (System + History + Input)
      const messagesForLlm = [
          systemMessage,
          ...historyMessages,
          rawInputMessage,
      ];
      // =====================================================================
      // FIN CAMBIO
      // =====================================================================


      //Reemplaza el retry fijo de 60s por exponencial con jitter:0
      const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

      // Función auxiliar con retry automático
      const createChatCompletion = async (): Promise<any> => {
        let attempt = 0;
        const maxAttempts = 3;
        while (true) {
          try {
            // Se usa messagesForLlm directamente, que contiene los datos crudos.
            const clientResp = await this.aiClient.bindTools(langchainTools).invoke(messagesForLlm);
            return clientResp
          } catch (err: any) {
            attempt++;
            const isRate = err?.code === 'rate_limit_exceeded' || err?.status === 429;
            if (!isRate || attempt >= maxAttempts) throw err;
            const backoff = Math.floor((2 ** attempt) * 1000 + Math.random() * 1000); // 2s,4s,8s + jitter
            this.logger.warn(`Rate limit: reintento #${attempt} en ${backoff}ms`);
            await sleep(backoff);
          }
        }
      };

      const response = await createChatCompletion();
      const choice = response;
      const toolCall = choice.tool_calls.shift();

      // ⭐ CORRECCIÓN: Eliminar 'await' y validar la ruta de propiedades de forma segura.
      const totalTokensMain = response?.usage_metadata?.total_tokens;
      const tokensUsedMain = totalTokensMain ? parseInt(totalTokensMain.toString(), 10) : 0;
      console.log('los tokens usados son...', response.usage_metadata?.total_tokens, tokensUsedMain) // Usar el valor corregido
      await this.aiCredits.trackTokens(userId, tokensUsedMain);

      // Procesamiento de tool
      if (toolCall) {
        this.logger.log(`Tool encontrada, preparando ejecución...`);

        let args;
        try {
          args = toolCall.args;
        } catch (e) {
          this.logger.error('Error al parsear los argumentos del toolCall', e.message);
          const followupText = '[ERROR_TOOL_ARGS_PARSING]';
          const aiResponse = this.processAgentFollowup(followupText, promptAI);

          return aiResponse;
        }

        const toolName = toolCall.name;

        switch (toolName) {
          case 'notificacion':
            // Ejecutar la tool sin retornar nada al usuario
            console.log('Enviando notificacion a un asesor 😎')
            this.logger.log('Activada notificacion a...', remoteJid)
            await this.notificacionTool.handleNotificacionTool(
              args,
              userId,
              server_url,
              apikey,
              instanceName,
              remoteJid
            );

            // Reconstruir el contexto para el follow-up sin compresión
            const followUpMessages = [
              systemMessage,
              ...historyMessages,
              rawInputMessage,
              new AIMessage({
                content: '',
                tool_calls: [toolCall]
              }),
              new ToolMessage({
                content: '',
                tool_call_id: toolCall.id || ''
              })
            ];

            const followUp = await this.aiClient.invoke(followUpMessages)

            // ⭐ CORRECCIÓN: Eliminar 'await' y validar la ruta de propiedades de forma segura.
            const totalTokensFollowUp = followUp?.usage_metadata?.total_tokens;
            const tokensUsedFollowUp = totalTokensFollowUp ? parseInt(totalTokensFollowUp.toString(), 10) : 0;
            await this.aiCredits.trackTokens(userId, tokensUsedFollowUp);

            const followupText = '✅ Solicitud enviada. En breve te contactará un asesor.';
            const aiResponse = this.processAgentFollowup(followupText, promptAI);

            return followUp.content.toString().trim() ?? aiResponse;


          case 'execute_workflow':
            return await this.handleExecuteWorkflowTool(
              args,
              userId,
              apikeyOpenAi,
              sessionId,
              server_url,
              apikey,
              instanceName,
              remoteJid,
              promptAI,
            );

          default:
            this.logger.warn(`Tool no soportada: ${toolCall.name}`, 'AiAgentService');
        }
      }
      const followupText = ERROR_OPENAI_EMPTY_RESPONSE;
      const aiResponse = this.processAgentFollowup(followupText, promptAI);

      return choice.content?.toString().trim() ?? aiResponse;
    } catch (error) {
      this.logger.error('Error procesando entrada con OpenAI.', error?.response?.data || error.message, 'AiAgentService');
      const followupText = '[ERROR_PROCESSING_OPENAI_INPUT]';
      const aiResponse = this.processAgentFollowup(followupText, promptAI);

      return aiResponse;
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
    userPrompt: string
  ): Promise<string|void> {
    this.logger.log('Se esta ejecutando una tool... 😎')
    const detectionResult = await this.openAIToolDetection({
      // input: args.nombre_flujo,
      input: args,
      sessionId,
      userId
    });
    const res = detectionResult.content?.toString();
    const raw = res?.trim();

    if (!raw || raw.toLowerCase() === 'ninguno') {
      this.logger.log(`No se encontró ningun flujo asociado al input.`);
      const followupText = 'Disculpa, no encontré información relacionada. ¿Te puedo ayudar con algo más?';
      const aiResponse = this.processAgentFollowup(followupText, userPrompt);
      return aiResponse;
    }

    let nombresDetectados: string[] = [];
    try {
      // Intenta parsear tal cual
      const parsed = JSON.parse(raw);
      nombresDetectados = parsed?.nombre_flujo || [];

      if (!Array.isArray(nombresDetectados) || nombresDetectados.length === 0) {
        this.logger.warn('No se encontraron flujos válidos en la respuesta.');
        const followupText = 'No se detectó ningún flujo compatible con tu solicitud.';
        const aiResponse = this.processAgentFollowup(followupText, userPrompt);
        return aiResponse;
      }
    } catch (e) {
      this.logger.error('Error al parsear el contenido JSON de OpenAI', e.message);
      const followupText = '[ERROR_PARSE_RAW_CONTENT]';
      const aiResponse = this.processAgentFollowup(followupText, userPrompt);
      return aiResponse;
    }

    this.logger.log(`Flujos detectados: ${JSON.stringify(nombresDetectados)}`);

    const workflows = await this.workflowService.getWorkflow(userId);
    let workflowMessages: string[] = [];

    for (const nombre of nombresDetectados) {
      const currentWorkflow = workflows.find(
        (w) => w.name.toLowerCase() === nombre.toLowerCase()
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
        workflowMessages.push(`✅ Se ejecutó: *${currentWorkflow.name}*`);
      } else {
        const followupText = `ℹ️ Ya ejecutado: *${currentWorkflow.name}*`;
        workflowMessages.push(followupText);
        const aiResponse = this.processAgentFollowup(followupText, userPrompt);
        return aiResponse
      }
    }

    this.logger.log(`Workflow result: ${JSON.stringify(workflowMessages.join('\n'))}`);

    /* Se corta el ciclo  para evitar que el agente conteste despues de ejecutar una tool*/
    // return '';
  };

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
  async transcribeAudio(audioUrl: string, audioType: string, apikeyOpenAi: string, data: any): Promise<string> {
    try {
      this.initializeClient(apikeyOpenAi);
      const axiosRes = await axios.get(audioUrl, { responseType: "arraybuffer" });
      const base64Audio = Buffer.from(axiosRes.data).toString("base64");
      const message = new HumanMessage({
        content: [
          {
            type: "text",
            text: "Transcribe de forma clara y detallada este audio.",
          },
          {
            "type": "media",
            "data": base64Audio,  // Use base64 string directly
            "mimeType": `${audioType}`
          },
        ],
      })
      const state = await this.aiClient.invoke([message])


      // fs.unlinkSync(tempFilePath);
      return state.content.toString()
      // return transcription.text;
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
  async describeImage(data: any, imageBase64: string, imageType: string, apikeyOpenAi: string): Promise<string> {
    try {



      this.initializeClient(apikeyOpenAi);
      // Refactor
      const message = new HumanMessage({
        content: [
          {
            type: "text",
            text: "Describe de forma clara y detallada el contenido de esta imagen.",
          },
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