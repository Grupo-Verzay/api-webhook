type LoggerLike = {
  log?: (msg: string, context?: string) => any;
  warn?: (msg: string, context?: string) => any;
  error?: (msg: string, err?: any, context?: string) => any;
};

type WorkflowServiceLike = {
  executeWorkflow: (
    name_flujo: string,
    urlevo: string,
    apikey: string,
    instanceName: string,
    remoteJid: string,
    userId: string,
    incomingText?: string,
  ) => Promise<any>;
};

type NodeSenderServiceLike = {
  sendTextNode: (
    apiUrl: string,
    apikey: string,
    remoteJid: string,
    message: string,
  ) => Promise<any>;
};

type ChatHistoryServiceLike = {
  saveMessage: (
    sessionId: string,
    message: string,
    role: 'human' | 'ia',
  ) => Promise<any>;
};

type AiAgentServiceLike = {
  processInput: (data: {
    input: string;
    userId: string;
    apikeyOpenAi: string;
    defaultModel: string;
    defaultProvider: string;
    sessionId: string;
    server_url: string;
    apikey: string;
    instanceName: string;
    remoteJid: string;
  }) => Promise<string>;
};

export async function executeWorkflow(params: {
  workflowService: WorkflowServiceLike;
  nodeSenderService: NodeSenderServiceLike;
  chatHistoryService: ChatHistoryServiceLike;
  aiAgentService: AiAgentServiceLike;
  logger?: LoggerLike;

  workflowName: string;
  server_url: string;
  apikey: string;
  instanceName: string;
  remoteJid: string;
  userId: string;

  // necesarios para IA + guardado + envío
  sessionHistoryId: string;
  apiMsgUrl?: string;

  // config IA
  apikeyOpenAi: string;
  model?: string;
  provider?: string;

  // control
  muteAgentResponses?: boolean;

  // defaults
  splitBlocks?: boolean;
  delayBetweenBlocksMs?: number;

  // opcional: personalizar el prompt
  postPromptBuilder?: (workflowName: string) => string;
}) {
  const {
    workflowService,
    nodeSenderService,
    chatHistoryService,
    aiAgentService,
    logger,

    workflowName,
    server_url,
    apikey,
    instanceName,
    remoteJid,
    userId,

    sessionHistoryId,
    apiMsgUrl,

    apikeyOpenAi,
    model = 'gpt-4o-mini',
    provider = 'openai',

    muteAgentResponses = false,

    splitBlocks = true,
    delayBetweenBlocksMs = 300,

    postPromptBuilder,
  } = params;

  const context = 'WorkflowHelper';

  if (!workflowName || workflowName.trim() === '') {
    logger?.warn?.(
      'executeWorkflow: workflowName vacío. No se ejecuta.',
      context,
    );
    return;
  }

  // 1) Ejecutar workflow
  await workflowService.executeWorkflow(
    workflowName,
    server_url,
    apikey,
    instanceName,
    remoteJid,
    userId,
  );

  // 2) Si está muteado, no generamos ni enviamos mensaje IA
  if (muteAgentResponses) {
    logger?.log?.(
      `Agente muteado: workflow ejecutado (${workflowName}) sin mensaje post.`,
      context,
    );
    return;
  }

  // 3) Prompt post-workflow (por defecto)
  const defaultPrompt = `Acabas de ejecutar el flujo "${workflowName}". No respondas nada. No menciones "workflow", no repitas el contenido del flujo, no ejecutes acciones ni herramientas.`;
  //   const defaultPrompt = `Acabas de ejecutar el flujo "${workflowName}".
  // Genera SOLO un mensaje corto (1–2 líneas) confirmando que ya se envió la información y preguntando qué más necesita.
  // No menciones "workflow", no repitas el contenido del flujo, no ejecutes acciones ni herramientas.`;

  const postFlowPrompt = postPromptBuilder
    ? postPromptBuilder(workflowName)
    : defaultPrompt;

  // 4) Generar mensaje con IA
  let aiText = '';
  try {
    aiText = await aiAgentService.processInput({
      input: postFlowPrompt,
      userId,
      apikeyOpenAi: apikeyOpenAi ?? '',
      defaultModel: model,
      defaultProvider: provider,
      sessionId: sessionHistoryId,
      server_url,
      apikey,
      instanceName,
      remoteJid,
    });
  } catch (err: any) {
    logger?.error?.(
      'Error generando post-message con IA',
      err?.message || err,
      context,
    );
    // fallback fijo si IA falla
    aiText = 'Listo ¿En qué más te puedo ayudar?';
  }

  aiText = (aiText || '').trim();
  if (!aiText) return;

  // 5) Guardar historial
  await chatHistoryService.saveMessage(sessionHistoryId, aiText, 'ia');

  // 6) Enviar por bloques
  const finalApiMsgUrl =
    apiMsgUrl ?? `${server_url}/message/sendText/${instanceName}`;

  const blocks = splitBlocks
    ? aiText
      .split('\n\n')
      .map((b) => b.trim())
      .filter(Boolean)
    : [aiText];

  for (const [index, block] of blocks.entries()) {
    logger?.log?.(
      `📤 Enviando bloque post-workflow ${index + 1}/${blocks.length}`,
      context,
    );
    await nodeSenderService.sendTextNode(
      finalApiMsgUrl,
      apikey,
      remoteJid,
      block,
    );
    await new Promise((res) => setTimeout(res, delayBetweenBlocksMs));
  }
}
