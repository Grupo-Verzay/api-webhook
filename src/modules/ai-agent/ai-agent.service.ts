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
import { PromptCompressorService } from './services/prompt-compressor/prompt-compressor.service';

@Injectable()
export class AiAgentService {
  private openAiClient: OpenAI;
  private readonly initWorkflowName: string = 'INICIO_BIENVENIDA';

  constructor(
    private readonly logger: LoggerService,
    private readonly promptService: PromptService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly workflowService: WorkflowService,
    private readonly notificacionTool: NotificacionToolService,
    private readonly aiCredits: AiCreditsService,
    private readonly promptCompressor: PromptCompressorService,
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
        return '';
      }

      const workflowTrigger = `lista de flujos disponibles ${formattedList}`
      promptAI = `${extraRules} ${workflowTrigger} ${systemPrompt}`;


      // 1) Comprimir historial a un único bloque
      let condensedHistory = '';
      if (chatHistory?.length) {
        try {
          condensedHistory = await this.promptCompressor.compressHistory({
            client: this.openAiClient,
            messages: chatHistory,
            maxTokens: 350,
          });
        } catch (e) {
          this.logger.warn('No se pudo condensar historial, usando original', 'AiAgentService');
        }
      }

      // 2) Comprimir input del usuario
      let compressedInput = '';
      try {
        compressedInput = await this.promptCompressor.compress({
          client: this.openAiClient,
          input: input,
          format: 'yaml',         // o 'json' si prefieres
          maxTokens: 300,
          temperature: 0.1,
        });

        // Verificar cobertura mínima (números, fechas, términos críticos)
        const { ok, missing } = this.promptCompressor.verifyCoverage({
          original: input,
          compressed: compressedInput,
          requiredTerms: [], // puedes inyectar endpoints/palabras clave si aplica
        });

        if (!ok) {
          this.logger.warn(`Compresión perdió términos críticos: ${missing.join(', ')}`, 'AiAgentService');
          compressedInput = input; // fallback
        }
      } catch (e) {
        this.logger.warn('Fallo en compresión de input, usando original', 'AiAgentService');
        compressedInput = input;
      }

      // 3) Construcción de mensajes (historial condensado + input comprimido)
      const historyMessages: ChatCompletionMessageParam[] = [];
      if (condensedHistory) {
        historyMessages.push({
          role: 'user',
          content: `[HISTORIAL-RESUMIDO]\n${condensedHistory}`,
        });
      }

      this.logger.debug(`PROMPT AI =======> ${JSON.stringify(promptAI)}`);
      this.logger.debug(`HISTORY MESSAGES =======> ${JSON.stringify(historyMessages)}`);

      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: promptAI },
        ...historyMessages,
        { role: 'user', content: compressedInput },
      ];

      //Reemplaza el retry fijo de 60s por exponencial con jitter:0
      const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

      // Función auxiliar con retry automático
      const createChatCompletion = async (): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
        let attempt = 0;
        const maxAttempts = 3;
        while (true) {
          try {
            return await this.openAiClient.chat.completions.create({
              model: 'gpt-4o-mini',
              messages,
              tools,
              tool_choice: 'auto',
              max_tokens: 300,
            });
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

    /* Se corta el ciclo  para evitar que el agente conteste despues de ejecutar una tool*/
    return '';
  };

  private async processAgentFollowup(
    followupText: string,
    userPrompt: string,
  ): Promise<string> {
    const finalPrompt = `El flujo automatizado respondió: "${followupText}". Ahora responde al usuario de manera natural y útil.`;

    const completion = await this.openAiClient.chat.completions.create({
      model: "gpt-4o-mini",
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
        model: 'gpt-4o-mini',
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