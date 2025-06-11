import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
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

@Injectable()
export class AiAgentService {
  private openAiClient: OpenAI;

  constructor(
    private readonly logger: LoggerService,
    private readonly promptService: PromptService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly workflowService: WorkflowService,
    private readonly notificacionTool: NotificacionToolService,
    private readonly aiCredits: AiCreditsService,
  ) { }

  /**
   * Inicializa el cliente de OpenAI con una API Key proporcionada.
   *
   * @param {string} apikeyOpenAi
   */
  private initializeClient(apikeyOpenAi: string): void {
    if (!this.isValidApiKey(apikeyOpenAi)) {
      this.logger.error('API Key inválida o no proporcionada.', '', 'AiAgentService');
    }
    this.openAiClient = new OpenAI({ apiKey: apikeyOpenAi });
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
      }`;
      }).join(',\n');

      this.logger.log(`Lista de flujos: ${JSON.stringify(formattedList)}`);


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

      const response = await this.openAiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
      });

      const choice: any = response.choices?.[0];
      const content = choice?.message?.content?.trim();

      //Registro de créditos por usuario
      const tokensUsed = response.usage?.total_tokens ?? 0;
      await this.aiCredits.trackTokens(userId, tokensUsed);

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

    try {
      this.initializeClient(apikeyOpenAi);

      const systemPrompt = await this.promptService.getPromptUserId(userId);
      const chatHistory = await this.chatHistoryService.getChatHistory(sessionId);
      const workflows = await this.workflowService.getWorkflow(userId);

      const formattedList = workflows.map((flow, index) => {
        return `{
        "id": ${index + 1},
        "nombre": "${flow.name}",
        "descripcion": "${flow.description || 'Sin descripción'}"
      }`;
      }).join(',\n');

      const workflowTrigger = `lista de flujos disponibles ${formattedList}`
      promptAI = `${extraRules} ${workflowTrigger} ${systemPrompt}`;

      const estimateTokens = (text: any): number => {
        if (typeof text === 'string') return Math.ceil(text.length / 4);
        if (Array.isArray(text)) return JSON.stringify(text).length / 4;
        return 0;
      };

      const historyMessages: ChatCompletionMessageParam[] = chatHistory.map((text) => ({
        role: 'user',
        content: text,
      }));


      let safeMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: promptAI },
        ...historyMessages,
        { role: 'user', content: input },
      ];


      /* Función auxiliar */
      const getTotalEstimatedTokens = (
        msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
      ): number => {
        return msgs.reduce((sum, msg) => {
          const content = (msg as any).content;
          return typeof content === 'string' ? sum + estimateTokens(content) : sum;
        }, 0);
      };

      let totalEstimatedTokens = getTotalEstimatedTokens(safeMessages);
      const maxAllowedTokens = 8192 - 300; // 300 reservados para respuesta

      // 🧠 Si se pasa, recorta el historial hacia atrás (lo más antiguo primero)
      while (totalEstimatedTokens > maxAllowedTokens && historyMessages.length > 0) {
        historyMessages.shift(); // elimina el mensaje más antiguo
        safeMessages = [
          { role: 'system', content: promptAI },
          ...historyMessages,
          { role: 'user', content: input },
        ];
        totalEstimatedTokens = getTotalEstimatedTokens(safeMessages);
      }

      // Función auxiliar con retry automático
      const createChatCompletion = async (): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
        try {
          return await this.openAiClient.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: safeMessages,
            tools,
            tool_choice: 'auto',
            max_tokens: 300
          });
        } catch (err: any) {
          this.logger.error(`[PROCESS_INPUT_ERR_OPENAICLIENT]`);
          if (err.code === 'rate_limit_exceeded' && err.type === 'tokens') {
            this.logger.warn(`Rate limit excedido por tokens, esperando 60s para reintentar...`);
            await new Promise((res) => setTimeout(res, 60000));
            return await this.openAiClient.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: safeMessages,
              tools,
              tool_choice: 'auto',
              max_tokens: 300
            });
          } else {
            throw err;
          }
        }
      };

      const response = await createChatCompletion();
      const choice: any = response.choices?.[0];
      const toolCall = choice?.message?.tool_calls?.[0];

      //Registro de créditos por usuario
      const tokensUsed = response.usage?.total_tokens ?? 0;
      await this.aiCredits.trackTokens(userId, tokensUsed);

      // Procesamiento de tool
      if (toolCall) {
        this.logger.log(`Tool encontrada, preparando ejecución...`);

        let args;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch (e) {
          this.logger.error('Error al parsear los argumentos del toolCall', e.message);
          const followupText = '[ERROR_TOOL_ARGS_PARSING]';
          const aiResponse = this.processAgentFollowup(followupText, promptAI);

          return aiResponse;
        }

        const toolName = toolCall.function.name;

        switch (toolName) {
          case 'notificacion':
            // Ejecutar la tool sin retornar nada al usuario
            await this.notificacionTool.handleNotificacionTool(
              args,
              userId,
              server_url,
              apikey,
              instanceName,
              remoteJid
            );

            // Luego continuar la conversación con una respuesta generada por la IA
            const followUp = await this.openAiClient.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [
                ...safeMessages,
                {
                  role: 'assistant',
                  tool_calls: [toolCall],
                },
                {
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: '',
                },
              ],
            });

            //Registro de créditos por usuario
            const tokensUsed = followUp.usage?.total_tokens ?? 0;
            await this.aiCredits.trackTokens(userId, tokensUsed);

            const followupText = '✅ Solicitud enviada. En breve te contactará un asesor.';
            const aiResponse = this.processAgentFollowup(followupText, promptAI);

            return followUp.choices?.[0]?.message?.content?.trim() ?? aiResponse;


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
            this.logger.warn(`Tool no soportada: ${toolCall.function.name}`, 'AiAgentService');
        }
      }
      const followupText = ERROR_OPENAI_EMPTY_RESPONSE;
      const aiResponse = this.processAgentFollowup(followupText, promptAI);

      return choice?.message?.content?.trim() ?? aiResponse;
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
  ): Promise<string> {
    const detectionResult = await this.openAIToolDetection({
      // input: args.nombre_flujo,
      input: args,
      sessionId,
      userId
    });
    const res = detectionResult.content;
    const rawContent = res?.trim().toUpperCase();

    if (!rawContent || rawContent === 'NINGUNO') {
      this.logger.log(`No se encontró ningun flujo asociado al input.`);
      const followupText = 'Disculpa, no encontré información relacionada. ¿Te puedo ayudar con algo más?';
      const aiResponse = this.processAgentFollowup(followupText, userPrompt);
      return aiResponse;
    }

    let nombresDetectados: string[];

    try {
      const parsed = JSON.parse(rawContent);
      nombresDetectados = parsed?.NOMBRE_FLUJO || [];

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

    /* Se corta el ciclo  para evitar que el agente conteste despues de ejecutar una tool*/
    return '';
  };

  private async processAgentFollowup(
    followupText: string,
    userPrompt: string,
  ): Promise<string> {
    const finalPrompt = `El flujo automatizado respondió: "${followupText}". Ahora responde al usuario de manera natural y útil.`;

    const completion = await this.openAiClient.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "Eres un asistente útil que traduce resultados de flujos automatizados a lenguaje natural para el usuario final." },
        { role: "user", content: userPrompt },
        { role: "assistant", content: followupText },
        { role: "user", content: finalPrompt },
      ],
    });

    const finalMessage = completion.choices[0].message.content || followupText;

    return finalMessage;
  }

  /**
   * Descarga un archivo de audio desde una URL.
   *
   * @param {string} url
   * @param {string} outputPath
   * @returns {Promise<void>}
   */
  private async downloadAudioFile(url: string, outputPath: string): Promise<void> {
    // Verifica que la carpeta destino exista. Crea la carpeta si no existe
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const writer = fs.createWriteStream(outputPath);
    const response = await axios.get(url, { responseType: 'stream' });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  };

  /**
   * Transcribe un archivo de audio utilizando OpenAI Whisper.
   *
   * @param {string} audioUrl
   * @returns {Promise<string>}
   */
  async transcribeAudio(audioUrl: string, apikeyOpenAi: string): Promise<string> {
    try {
      this.initializeClient(apikeyOpenAi);

      const tempFilePath = path.resolve(__dirname, '../../tmp/temp_audio_file.oga');
      await this.downloadAudioFile(audioUrl, tempFilePath);

      const transcription = await this.openAiClient.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath),
        model: 'whisper-1',
        language: 'es',
      });

      fs.unlinkSync(tempFilePath);
      return transcription.text;
    } catch (error) {
      this.logger.error('Error transcribiendo audio con OpenAI.', error?.response?.data || error.message, 'AiAgentService');
      return '[ERROR_TRANSCRIBING_AUDIO]';
    }
  };

  /**
   * Describe una imagen utilizando OpenAI GPT-4 con input de imagen.
   *
   * @param {string} imageUrl
   * @returns {Promise<string>}
   */
  async describeImage(imageUrl: string, apikeyOpenAi: string): Promise<string> {
    try {
      this.initializeClient(apikeyOpenAi);

      const response = await this.openAiClient.responses.create({
        model: 'gpt-4.1',
        input: [
          { role: 'user', content: 'Describe de forma clara y detallada el contenido de esta imagen.' },
          {
            role: 'user',
            content: [
              {
                type: 'input_image',
                image_url: imageUrl,
                detail: 'auto',
              },
            ],
          },
        ],
      });

      return response.output_text ?? '[ERROR_DESCRIBING_IMAGE]';
    } catch (error) {
      this.logger.error('Error describiendo imagen con OpenAI.', error?.response?.data || error.message, 'AiAgentService');
      return '[ERROR_DESCRIBING_IMAGE]';
    }
  };
}