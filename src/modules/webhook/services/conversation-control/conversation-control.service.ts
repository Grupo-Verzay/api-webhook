import { Injectable } from '@nestjs/common';
import { AiAgentService } from 'src/modules/ai-agent/ai-agent.service';
import { LoggerService } from 'src/core/logger/logger.service';
import { SessionService } from 'src/modules/session/session.service';
import { SeguimientosService } from 'src/modules/seguimientos/seguimientos.service';
import { CrmFollowUpRunnerService } from 'src/modules/lead-funnel/services/crm-follow-up-runner.service';
import { UserService } from 'src/modules/user/user.service';
import { AutoRepliesService } from 'src/modules/auto-replies/auto-replies.service';
import { WorkflowService } from 'src/modules/workflow/services/workflow.service.ts/workflow.service';
import { NodeSenderService } from 'src/modules/workflow/services/node-sender.service.ts/node-sender.service';
import { ChatHistoryService } from 'src/modules/chat-history/chat-history.service';
import { WhatsAppSenderFactory } from 'src/modules/whatsapp/whatsapp-sender.factory';
import {
  onAutoRepliesInterface,
  stopOrResumeConversation,
  UserWithPausar,
} from 'src/types/open-ai';
import { buildChatHistorySessionId } from 'src/modules/chat-history/chat-history-session.helper';
import { executeWorkflow } from 'src/utils/execute-workflow';

@Injectable()
export class ConversationControlService {
  constructor(
    private readonly aiAgentService: AiAgentService,
    private readonly logger: LoggerService,
    private readonly sessionService: SessionService,
    private readonly seguimientosService: SeguimientosService,
    private readonly crmFollowUpRunnerService: CrmFollowUpRunnerService,
    private readonly userService: UserService,
    private readonly autoRepliesService: AutoRepliesService,
    private readonly workflowService: WorkflowService,
    private readonly nodeSenderService: NodeSenderService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly whatsAppSenderFactory: WhatsAppSenderFactory,
  ) {}

  private scopedLogger(ctx: {
    userId?: string;
    instanceName?: string;
    remoteJid?: string;
  }) {
    const tag = `[UID=${ctx.userId ?? '-'}][I=${ctx.instanceName ?? '-'}][R=${ctx.remoteJid ?? '-'}]`;
    return {
      log: (msg: string, context = 'ConversationControlService') =>
        this.logger.log(`${tag} ${msg}`, context),
      debug: (msg: string) =>
        this.logger.debug(`${tag} ${msg}`, 'ConversationControlService'),
      warn: (msg: string, context = 'ConversationControlService') =>
        this.logger.warn(`${tag} ${msg}`, context),
      error: (msg: string, err?: any, context = 'ConversationControlService') =>
        this.logger.error(`${tag} ${msg}`, err, context),
    };
  }

  private makeSendTextFn(
    instanceName: string,
    server_url: string,
    apikey: string,
  ): (remoteJid: string, text: string) => Promise<void> {
    if (!server_url) {
      const sender = this.whatsAppSenderFactory.getSenderSync('baileys');
      return (remoteJid, text) =>
        sender.sendText(instanceName, remoteJid, text).then(() => {});
    }
    const apiMsgUrl = `${server_url}/message/sendText/${instanceName}`;
    return (remoteJid, text) =>
      this.nodeSenderService.sendTextNode(apiMsgUrl, apikey, remoteJid, text);
  }

  async stopOrResumeConversation({
    conversationMsg,
    remoteJid,
    remoteJidAlt,
    instanceId,
    sessionStatus,
    userWithRelations,
    instanceName,
    apikey,
    server_url,
  }: stopOrResumeConversation): Promise<void> {
    const logger = this.scopedLogger({
      userId: userWithRelations?.id,
      instanceName,
      remoteJid,
    });

    const msg = (conversationMsg ?? '').trim().toLowerCase();

    // 1) Pausar sesión principal (si estaba activa)
    if (sessionStatus) {
      await this.sessionService.updateSessionStatus(
        remoteJid,
        instanceName,
        false,
        userWithRelations.id,
      );
      logger.log(`Chat pausado para ${remoteJid}.`);
    } else {
      logger.log(`Chat ya estaba pausado para ${remoteJid}.`);
    }

    // 2) Pausar también el alternativo SOLO si existe sesión
    if (remoteJidAlt && remoteJidAlt !== remoteJid) {
      const altSession = await this.sessionService.getSession(
        remoteJidAlt,
        instanceName,
        userWithRelations.id,
      );
      if (altSession) {
        await this.sessionService.updateSessionStatus(
          remoteJidAlt,
          instanceName,
          false,
          userWithRelations.id,
        );
        logger.log(`Chat pausado también para JID alternativo: ${remoteJidAlt}.`);
      } else {
        logger.log(`JID alternativo no tiene sesión; se omite pausa: ${remoteJidAlt}.`);
      }
    }

    // 3) Reactivar SOLO si estaba pausado y se escribe la frase correcta
    if (!userWithRelations) {
      logger.warn('❌ No se encontró el usuario para obtener la frase de reactivación.');
      return;
    }

    const dataPausar = userWithRelations.pausar ?? [];
    const pausarItem = dataPausar.find((p) => p.tipo === 'abrir');

    if (!pausarItem) {
      logger.warn('❌ El usuario no tiene frase de reactivación configurada.');
      return;
    }

    const phraseToReactivateChat = (pausarItem.mensaje ?? '').trim().toLowerCase();
    logger.log(`Frase de reactivación del usuario: "${pausarItem.mensaje}"`);

    if (msg === phraseToReactivateChat) {
      if (!sessionStatus) {
        logger.log('Frase correcta detectada. Reactivando chat...');
        await this.sessionService.updateSessionStatus(
          remoteJid,
          instanceName,
          true,
          userWithRelations.id,
        );
        await this.sessionService.updateAgentDisabled(
          remoteJid,
          instanceName,
          false,
          userWithRelations.id,
        );

        if (remoteJidAlt && remoteJidAlt !== remoteJid) {
          const altSession = await this.sessionService.getSession(
            remoteJidAlt,
            instanceName,
            userWithRelations.id,
          );
          if (altSession) {
            await this.sessionService.updateSessionStatus(
              remoteJidAlt,
              instanceName,
              true,
              userWithRelations.id,
            );
            logger.log(`Chat reactivado también para JID alternativo: ${remoteJidAlt}.`);
          } else {
            logger.log(`JID alternativo no tiene sesión; se omite reactivación: ${remoteJidAlt}.`);
          }
        }
      } else {
        logger.log('Frase de reactivación recibida, pero el chat ya estaba activo.');
      }
      return;
    }

    // 4) Eliminar seguimiento
    const pharaseToDelSeguimiento = (userWithRelations.delSeguimiento ?? '')
      .trim()
      .toLowerCase();

    if (msg === pharaseToDelSeguimiento) {
      logger.log('Frase correcta detectada. Eliminando seguimiento...');
      try {
        const { count } = await this.seguimientosService.deleteSeguimientosByRemoteJid(
          remoteJid,
          instanceName,
        );
        if (count && count > 0) {
          logger.log('Seguimiento eliminado con exito.');
        } else {
          logger.log('No se encontró un seguimiento relacionado.');
        }
      } catch (error) {
        logger.error('ERROR_SEGUIMIENTOS', error);
      }

      try {
        const { count: crmCount } = await this.crmFollowUpRunnerService.deletePendingByRemoteJid({
          remoteJid,
          instanceId,
        });
        if (crmCount > 0) {
          logger.log(`CRM follow-ups eliminados: ${crmCount}`);
        } else {
          logger.log('No se encontraron CRM follow-ups pendientes.');
        }
      } catch (error) {
        logger.error('ERROR_CRM_FOLLOW_UPS', error);
      }

      await this.sessionService.updateAgentDisabled(
        remoteJid,
        instanceName,
        true,
        userWithRelations.id,
      );
      return;
    }

    // 5) AutoReplies
    await this.onAutoReplies({
      userId: userWithRelations.id.toString(),
      conversationMsg,
      server_url,
      apikey,
      instanceName,
      instanceId,
      remoteJid,
    });
  }

  async onAutoReplies({
    userId,
    conversationMsg,
    server_url,
    apikey,
    instanceName,
    instanceId,
    remoteJid,
  }: onAutoRepliesInterface): Promise<void> {
    const logger = this.scopedLogger({ userId, instanceName, remoteJid });

    const userWithRelations = (await this.userService.getUserWithPausar(
      userId,
    )) as UserWithPausar;

    const aiConfig = await this.userService.getUserDefaultAiConfig(userId);
    const { defaultModel, defaultProvider, defaultApiKey } = aiConfig || {};

    const model = defaultModel?.name || 'gpt-4o-mini';
    const provider = defaultProvider?.name || 'openai';

    try {
      const autoReplies = await this.autoRepliesService.getAutoRepliesByUserId(userId);
      if (!autoReplies || autoReplies.length === 0) return;

      const matchedReply = autoReplies.find((reply) => {
        const msgLower = (reply.mensaje ?? '').trim().toLowerCase();
        if (msgLower && msgLower !== 'undefined' && msgLower === conversationMsg) return true;
        const nameLower = (reply.name ?? '').replace(/^#+\s*/, '').trim().toLowerCase();
        return nameLower === conversationMsg;
      });

      if (matchedReply) {
        logger.log(`Respuesta rápida encontrada: ${matchedReply.mensaje}`);
        if (!matchedReply.workflowId) return;
        const workflow = await this.workflowService.getWorkflowByWorkflowId(
          matchedReply.workflowId,
        );
        if (!workflow) return;

        await this.sessionService.clearInactividadAfterAgentReply(
          userId,
          remoteJid,
          instanceName,
        );

        const sessionHistoryId = buildChatHistorySessionId(instanceName, remoteJid);

        if (!server_url) {
          // Baileys: enviar nodos directamente sin Evolution API
          const sender = this.whatsAppSenderFactory.getSenderSync('baileys');
          const nodes = await this.workflowService.getWorkflowNodes(matchedReply.workflowId);
          for (const node of nodes) {
            const tipo = (node.tipo ?? '').trim().toLowerCase();
            if (tipo === 'text') {
              const text = (node.message ?? '').trim();
              if (text) await sender.sendText(instanceName, remoteJid, text).catch(() => {});
            } else if (tipo === 'audio') {
              const url = (node.url ?? '').trim();
              if (url) await sender.sendAudio(instanceName, remoteJid, url).catch(() => {});
            } else if (['image', 'video', 'document'].includes(tipo)) {
              const url = (node.url ?? '').trim();
              if (url) await sender.sendMedia(instanceName, remoteJid, tipo, (node.message ?? '').trim(), url).catch(() => {});
            }
          }
          logger.log(`Flujo Baileys ejecutado: ${workflow.name} (${nodes.length} nodos)`);
        } else {
          const apiMsgUrl = `${server_url}/message/sendText/${instanceName}`;

          await executeWorkflow({
            workflowService: this.workflowService,
            nodeSenderService: this.nodeSenderService,
            chatHistoryService: this.chatHistoryService,
            aiAgentService: this.aiAgentService,
            logger,

            workflowName: workflow?.name ?? '',
            server_url,
            apikey,
            instanceName,
            remoteJid,
            userId,

            sessionHistoryId,
            apiMsgUrl,

            apikeyOpenAi: defaultApiKey ?? '',
            model,
            provider,

            muteAgentResponses: !!userWithRelations.muteAgentResponses,
            sendTextFn: this.makeSendTextFn(instanceName, server_url, apikey),
          });
        }

        // Registrar intención para que el agente IA no re-ejecute el flujo
        await this.chatHistoryService.registerExecutedIntention(
          sessionHistoryId,
          workflow.name,
          workflow.name,
        );

        // Registrar flujo en la sesión (columna Flujos del CRM)
        await this.sessionService.registerWorkflow(
          { id: workflow.id, name: workflow.name },
          remoteJid,
          instanceId,
          userId,
        );

        await this.sessionService.updateSessionStatus(
          remoteJid,
          instanceName,
          true,
          userWithRelations.id,
        );
      }
    } catch (error) {
      logger.error('Error al procesar autoReplies', error);
    }
  }
}
