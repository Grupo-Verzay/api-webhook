import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { PromptService } from '../prompt/prompt.service';
import { ChatHistoryService } from '../chat-history/chat-history.service';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { NodeSenderService } from '../workflow/services/node-sender.service.ts/node-sender.service';
import { WorkflowService } from '../workflow/services/workflow.service.ts/workflow.service';
import { IntentionService } from './services/intention/intention.service';
import { IntentionItem, OpenAIDetectionResult, openAIToolDetection, proccessInput } from 'src/types/open-ai';
import { NotificacionToolService } from './tools/notificacion/notificacion.service';
import { tools } from './utils/tools';
import { extraRules, systemPromptWorkflow } from './utils/rulesPrompt';

@Injectable()
export class AiAgentService {
  private openAiClient: OpenAI;

  constructor(
    private readonly logger: LoggerService,
    private readonly promptService: PromptService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly nodeSenderService: NodeSenderService,
    private readonly workflowService: WorkflowService,
    private readonly intentionService: IntentionService,
    private readonly notificacionTool: NotificacionToolService,
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
      const formattedList = workflows.map(
        (flow) => `- ${flow.name}: ${flow.description ?? 'sin descripción'}`
      ).join('\n');

      const systemPrompt = `
      Eres un agente inteligente que debe ejecutar flujos según lo que el usuario pida. Esta es la lista de flujos disponibles:
      
      ${formattedList}
      
      Responde indicando cuál flujo ejecutar, usando el nombre exacto si lo reconoces.
      `;

      const historyMessages: ChatCompletionMessageParam[] = chatHistory.map((text) => ({
        role: 'user',
        content: text,
      }));

      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: input },
      ];

      const response = await this.openAiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        tools,
        tool_choice: 'auto',
      });

      const choice: any = response.choices?.[0];
      const toolCall = choice?.message?.tool_calls?.[0];
      this.logger.debug(`Choice ========>: ${JSON.stringify(choice)}`);
      this.logger.debug(`ToolCall ========>: ${JSON.stringify(toolCall)}`);

      if (!toolCall || !toolCall.function?.name) {
        return { choice, toolCall: null };
      }
      // return choice?.message?.content?.trim() ?? '[ERROR_OPENAI_EMPTY_RESPONSE]';
      return {
        choice,
        toolCall
      }

    } catch (error) {
      this.logger.error('Error procesando entrada con OpenAI.', error?.response?.data || error.message, 'AiAgentService');
      return {
        choice: null,
        toolCall: null
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

      const historyMessages: ChatCompletionMessageParam[] = chatHistory.map((text) => ({
        role: 'user',
        content: text,
      }));

      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: `${extraRules} ${systemPrompt}` },
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
      this.logger.debug(`Choice ========>: ${JSON.stringify(choice)}`);
      this.logger.debug(`ToolCall ========>: ${JSON.stringify(toolCall)}`);


      if (toolCall) {
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
      }

      return choice?.message?.content?.trim() ?? '[ERROR_OPENAI_EMPTY_RESPONSE]';
    } catch (error) {
      this.logger.error('Error procesando entrada con OpenAI.', error?.response?.data || error.message, 'AiAgentService');
      return '[ERROR_PROCESSING_OPENAI_INPUT]';
    }
  };

  private async handleExecuteWorkflowTool(
    args,
    userId: string,
    apikeyOpenAi: string,
    sessionId: string,
    server_url: string,
    apikey: string,
    instanceName: string,
    remoteJid: string
  ): Promise<string> {

    /* OLD 
    // const decisions = await this.intentionService.detectIntent(args.nombre_flujo, dataWorkflow, apikeyOpenAi);
    this.logger.debug(`decisions ========>: ${JSON.stringify(decisions)}`);

    if (!decisions.length) {
      return 'Disculpa, no encontré información relacionada. ¿Te puedo ayudar con algo más?';
    }

    let mensajesEnviados: string[] = [];
    */
    /* NEW */

    const detectionResult = await this.openAIToolDetection({
      input: args.nombre_flujo,
      sessionId,
      userId
    });

    const flujoDetectado = detectionResult.toolCall?.function?.arguments;

    if (!flujoDetectado) {
      return 'Disculpa, no encontré información relacionada. ¿Te puedo ayudar con algo más?';
    }

    let nombreFlujo: string;
    try {
      const parsed = JSON.parse(flujoDetectado);
      nombreFlujo = parsed.nombre_flujo;
    } catch (e) {
      this.logger.error('Error al interpretar nombre_flujo desde toolCall', e.message);
      return '[ERROR_PARSE_NOMBRE_FLUJO]';
    }

    const workflows = await this.workflowService.getWorkflow(userId);
    const decision = workflows.find(w => w.name.toLowerCase() === nombreFlujo.toLowerCase());

    if (!decision) {
      return `El flujo "${nombreFlujo}" no está disponible actualmente.`;
    }

    const alreadyExecuted = await this.chatHistoryService.hasIntentionBeenExecuted(sessionId, decision.name);
    this.logger.debug(`alreadyExecuted ========>: ${alreadyExecuted} para ${decision.name}`);

    // if (alreadyExecuted) {
    //   return `Ya ejecutamos el flujo *${decision.name}*. ¿Deseas otra ayuda?`;
    // }

    await this.chatHistoryService.registerExecutedIntention(sessionId, decision.name, 'intention');
    await this.workflowService.executeWorkflow(
      decision.name,
      server_url,
      apikey,
      instanceName,
      remoteJid,
      userId
    );

    return `✅ He ejecutado el flujo *${decision.name}*. ¿Puedo ayudarte con algo más?`;

    // for (const decision of decisions) {
    // const alreadyExecuted = await this.chatHistoryService.hasIntentionBeenExecuted(sessionId, decision.name);
    // this.logger.debug(`alreadyExecuted ========>: ${alreadyExecuted} para ${decision.name}`);

    // if (alreadyExecuted) {
    //   //TODO: VALIDAR MSG  
    //   // mensajesEnviados.push(`Ya te compartí "${decision.name}". ¿Te puedo ayudar en algo más?`);
    //   mensajesEnviados.push(``);
    //   this.logger.log(`El flujo ${decision.name} ya fue ejecutado, revise el historial para ejecutar nuevamente.`);
    //   continue;
    // }

    // await this.chatHistoryService.registerExecutedIntention(sessionId, decision.name, decision.tipo);
    // await this.workflowService.executeWorkflow(
    //   decision.name,
    //   server_url,
    //   apikey,
    //   instanceName,
    //   remoteJid,
    //   userId
    // );
    //TODO: VALIDAR MSG 
    // mensajesEnviados.push(`Te he enviado la información sobre "${decision.name}". ¿Deseas algo más?`);
    // mensajesEnviados.push(``);
    // }

    // return mensajesEnviados.join('\n');
    
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