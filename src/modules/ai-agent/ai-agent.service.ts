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

      const historyMessages: ChatCompletionMessageParam[] = chatHistory.map((text) => ({
        role: 'user',
        content: text,
      }));

      const customWorkflowPrompt = systemPromptWorkflow(input, JSON.stringify(formattedList));

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
    try {
      this.initializeClient(apikeyOpenAi);

      const systemPrompt = await this.promptService.getPromptUserId(userId);
      const chatHistory = await this.chatHistoryService.getChatHistory(sessionId);
      const workflows = await this.workflowService.getWorkflow(userId);

      const historyMessages: ChatCompletionMessageParam[] = chatHistory.map((text) => ({
        role: 'user',
        content: text,
      }));

      const formattedList = workflows.map((flow, index) => {
        return `{
        "id": ${index + 1},
        "nombre": "${flow.name}",
        "descripcion": "${flow.description || 'Sin descripción'}"
      }`;
      }).join(',\n');

      const workflowTrigger = `lista de flujos disponibles ${formattedList}`

      const promptAI = `${extraRules} ${workflowTrigger} ${systemPrompt} `

      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: promptAI },
        ...historyMessages,
        { role: 'user', content: input },
      ];

      const response = await this.openAiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        tools,
        tool_choice: 'auto', // o especifica 'notificacion' si deseas forzarla
      });

      const choice: any = response.choices?.[0];
      const toolCall = choice?.message?.tool_calls?.[0];

      //Registro de créditos por usuario
      const tokensUsed = response.usage?.total_tokens ?? 0;
      await this.aiCredits.trackTokens(userId, tokensUsed);


      if (toolCall) {
        this.logger.log(`Tool encontrada, preparando ejecución...`);

        let args;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch (e) {
          this.logger.error('Error al parsear los argumentos del toolCall', e.message);
          return '[ERROR_TOOL_ARGS_PARSING]';
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
                ...messages,
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

            return followUp.choices?.[0]?.message?.content?.trim() ?? '✅ Solicitud enviada. En breve te contactará un asesor.';


          case 'execute_workflow':
            return await this.handleExecuteWorkflowTool(
              args,
              userId,
              apikeyOpenAi,
              sessionId,
              server_url,
              apikey,
              instanceName,
              remoteJid
            );

          default:
            this.logger.warn(`Tool no soportada: ${toolCall.function.name}`, 'AiAgentService');
        }

        /* Se corta el ciclo  para evitar que el agente conteste despues de ejecutar una tool*/
        return;
      }

      return choice?.message?.content?.trim() ?? ERROR_OPENAI_EMPTY_RESPONSE;
    } catch (error) {
      this.logger.error('Error procesando entrada con OpenAI.', error?.response?.data || error.message, 'AiAgentService');
      return '[ERROR_PROCESSING_OPENAI_INPUT]';
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
    remoteJid: string
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
      return "Disculpa, no encontré información relacionada. ¿Te puedo ayudar con algo más?";
    }

    let nombresDetectados: string[];

    try {
      const parsed = JSON.parse(rawContent);
      nombresDetectados = parsed?.NOMBRE_FLUJO || [];

      if (!Array.isArray(nombresDetectados) || nombresDetectados.length === 0) {
        this.logger.warn('No se encontraron flujos válidos en la respuesta.');
        return 'No se detectó ningún flujo compatible con tu solicitud.';
      }
    } catch (e) {
      this.logger.error('Error al parsear el contenido JSON de OpenAI', e.message);
      return '[ERROR_PARSE_RAW_CONTENT]';
    }

    this.logger.log(`Flujos detectados: ${JSON.stringify(nombresDetectados)}`);

    const workflows = await this.workflowService.getWorkflow(userId);
    let mensajes: string[] = [];

    for (const nombre of nombresDetectados) {
      const currentWorkflow = workflows.find(
        (w) => w.name.toLowerCase() === nombre.toLowerCase()
      );

      if (!currentWorkflow) {
        this.logger.warn(`El flujo "${nombre}" no fue encontrado.`);
        continue;
      }

      const yaEjecutado = await this.chatHistoryService.hasIntentionBeenExecuted(
        sessionId,
        currentWorkflow.name
      );

      if (!yaEjecutado) {
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
        mensajes.push(`✅ Se ejecutó: *${currentWorkflow.name}*`);
      } else {
        mensajes.push(`ℹ️ Ya ejecutado: *${currentWorkflow.name}*`);
      }
    }

    this.logger.log(`Workflow result: ${JSON.stringify(mensajes.join('\n'))}`);

    return "¿Te puedo ayudar con algo más? Estoy aquí para ayudarte con lo que necesites.";
  };

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