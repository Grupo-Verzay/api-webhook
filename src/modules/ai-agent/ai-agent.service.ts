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
import { IntentionItem, proccessInput } from 'src/types/open-ai';

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
  }

  /**
   * Valida si una API Key parece válida.
   *
   * @param {string} apikeyOpenAi
   * @returns {boolean}
   */
  private isValidApiKey(apikeyOpenAi: string): boolean {
    return typeof apikeyOpenAi === 'string' && apikeyOpenAi.startsWith('sk-') && apikeyOpenAi.length >= 40;
  }

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
  }

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
   * @returns {Promise<void>}
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

      const extraRules = `TU ROL Y FUNCIONES:
      # Eres un asistente de IA avanzado, experto en ventas y atención al cliente, aplicando técnicas de neuroventas, persuasión y cierre estratégico. Ofrece respuestas precisas, contextualizadas y útiles. Tu misión es asistir al usuario de manera eficiente, adaptando el tono y el contenido de tus respuestas a sus intereses según el perfil del usuario.
      
      PRIORIDAD DE EJECUCIÓN:
      1. La herramienta "execute_workflow" debe ejecutarse SIEMPRE que esté disponible y es la PRIMERA que debes validar antes de cualquier interacción del usuario, sin excepción.
      2. Si la herramienta "execute_workflow" no es suficiente o no está disponible, deberás evaluar las siguientes herramientas disponibles:
      
      - notificacion (cuando el usuario requiere asistencia humana)
      - execute_workflow (SIEMPRE debe validarse primero)
      
      ### Política:
      - Siempre prioriza "execute_workflow" antes que cualquier otra herramienta.
      
      Nota: Todas tus respuestas deben basarse únicamente en la información disponible en tu base de conocimiento.
      Si no cuentas con datos suficientes o las herramientas están desactivadas, indícalo de manera educada y ofrece una alternativa, como solicitar más detalles o derivar la consulta a un agente humano.
      
      ---`;

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

      const tools: any[] = [
        {
          type: 'function',
          function: {
            name: 'notificacion',
            description: 'Utiliza esta herramienta cuando un usuario necesite la asesoría de un asesor, haga una solicitud, reclamo o agendamiento.',
            parameters: {
              type: 'object',
              properties: {
                nombre: { type: 'string', description: 'Nombre del usuario' },
                detalles: { type: 'string', description: 'Detalle de la notificación o solicitud' },
              },
              required: ['nombre', 'detalles'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'execute_workflow',
            description: `Utiliza siempres esta herramienta debe ejecutarse para verificar si existe un flujo automatizado en la base de datos relacionado 
            con la intención del usuario. Si se encuentra un flujo coincidente, se ejecuta automáticamente. Si no se encuentra ningún flujo, la IA debe continuar 
            la conversación de forma natural sin interrumpir al usuario.`,
            parameters: {
              type: 'object',
              properties: {
                nombre_flujo: {
                  type: 'string',
                  description: 'Nombre del flujo a ejecutar',
                },
              },
              required: ['nombre_flujo'],
            },
          },
        }
      ];

      const response = await this.openAiClient.chat.completions.create({
        model: 'gpt-4',
        messages,
        tools,
        tool_choice: 'auto', // o especifica 'notificacion' si deseas forzarla
      });

      const choice: any = response.choices?.[0];
      const toolCall = choice?.message?.tool_calls?.[0];
      this.logger.debug(`Choice ========>: ${JSON.stringify(choice)}`);
      this.logger.debug(`ToolCall ========>: ${JSON.stringify(toolCall)}`);


      if (toolCall) {
        const args = JSON.parse(toolCall.function.arguments);

        switch (toolCall.function.name) {
          case 'notificacion':
            return await this.handleNotificacionTool(args);

          case 'execute_workflow':
            return await this.handleExecuteWorkflowTool(
              args,
              userId,
              apikeyOpenAi,
              sessionId,
              server_url,
              apikey,
              instanceName,
              remoteJid);

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

  private async handleNotificacionTool(args: any): Promise<string> {
    await this.nodeSenderService.sendTextNode(
      'http://conexion-3.verzay.co/message/sendText/More-Pruebas',
      '893C5438-0C98-4B60-AA11-D866208D77BC',
      '573196892277@s.whatsapp.net',
      'Tienes una notificación del cliente.'
    );
    return `✅ Notificación enviada para ${args.nombre} con detalles: ${args.detalles}`;
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
    const workflows = await this.workflowService.getWorkflow(userId);
    const dataWorkflow: IntentionItem[] = workflows.map((flow) => ({
      name: flow.name,
      tipo: 'flujo',
      frase: flow.description ?? flow.name,
      umbral: flow.umbral,
    }));

    const decisions = await this.intentionService.detectIntent(args.nombre_flujo, dataWorkflow, apikeyOpenAi);
    this.logger.debug(`decisions ========>: ${JSON.stringify(decisions)}`);

    if (!decisions.length) {
      return 'Disculpa, no encontré información relacionada. ¿Te puedo ayudar con algo más?';
    }

    let mensajesEnviados: string[] = [];

    for (const decision of decisions) {
      const alreadyExecuted = await this.chatHistoryService.hasIntentionBeenExecuted(sessionId, decision.name);
      this.logger.debug(`alreadyExecuted ========>: ${alreadyExecuted} para ${decision.name}`);

      // if (alreadyExecuted) {
      //   //TODO: VALIDAR MSG  
      //   // mensajesEnviados.push(`Ya te compartí "${decision.name}". ¿Te puedo ayudar en algo más?`);
      //   mensajesEnviados.push(``);
      //   this.logger.log(`El flujo ${decision.name} ya fue ejecutado, revise el historial para ejecutar nuevamente.`);
      //   continue;
      // }

      await this.chatHistoryService.registerExecutedIntention(sessionId, decision.name, decision.tipo);
      await this.workflowService.executeWorkflow(
        decision.name,
        server_url,
        apikey,
        instanceName,
        remoteJid,
        userId
      );
      //TODO: VALIDAR MSG 
      // mensajesEnviados.push(`Te he enviado la información sobre "${decision.name}". ¿Deseas algo más?`);
      mensajesEnviados.push(``);
    }

    return mensajesEnviados.join('\n');
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
  }

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
  }

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
  }
}