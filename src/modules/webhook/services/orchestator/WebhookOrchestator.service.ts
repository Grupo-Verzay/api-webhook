import { Injectable, Logger } from '@nestjs/common';
import { WebhookBodyDto, WebhookDataDto } from 'src/modules/webhook/dto/webhook-body';
import { InstancesService } from 'src/modules/instances/instances.service';
import { UserService } from 'src/modules/user/user.service';
import { Pausar, User } from '@prisma/client';
import { flags } from 'src/types/open-ai';
import { WebhookValidatorService } from './WebhookValidator.service';
import { WebhookExtractDataService } from './WebhookExtractData.service';


@Injectable()
export class WebhookOrchestatorService {

    constructor(
        private readonly instancesService: InstancesService,
        private readonly userService: UserService,
        private readonly webhookExtractDataService: WebhookExtractDataService,
        private readonly webhookValidatorService: WebhookValidatorService

    ) { }

    async extractRequestInfo(body: WebhookBodyDto) {
        // Se extraen los datos de la llamada del webhook
        const {
            instance: instanceName,
            server_url,
            apikey,
            data,
        } = body;

        // Se obtienen los datos del cliente 
        const { remoteJid, pushName,
            fromMe, messageType,
            msgChat, conversationMsg,
            sessionHistoryId, apiMsgUrl } = this.webhookExtractDataService.getClientinfo(data, instanceName, server_url)


        //Se busca la informacion del usuario en la aplicacion a partir de su instancia en evolution api
        const { userId, instanceId,
            userWithRelations, apikeyOpenAi } = await this.webhookExtractDataService.getUserInfo(instanceName, remoteJid, pushName)

        return {

            clientInfo: {
                remoteJid, pushName,
                fromMe, messageType,
                msgChat, conversationMsg,
                sessionHistoryId, apiMsgUrl
            },
            userInfo: {
                userId, instanceId,
                userWithRelations, apikeyOpenAi
            },
            requestInfo: {
                instance: instanceName,
                server_url,
                apikey,
                data,

            }
        }
    }

    private validateData({

        clientInfo: {
            remoteJid, pushName,
            fromMe, messageType,
            msgChat, conversationMsg,
            sessionHistoryId, apiMsgUrl
        },
        userInfo: {
            userId, instanceId,
            userWithRelations, apikeyOpenAi
        },
        requestInfo: {
            instance: instanceName,
            server_url,
            apikey,
            data,

        }
    }) {


        this.webhookValidatorService.creditValidation({
            userId, flags,
            webhookUrl: userWithRelations.webhookUrl ?? '',
            apiUrl: apiMsgUrl, apikey, userPhone: userWithRelations.notificationNumber
        })




    }

    private async getUserInfo(instanceName: string, remoteJid: string, pushName: string) {
        //Se busca la informacion del usuario en la aplicacion a partir de su instancia en evolution api
        const prismaInstancia = await this.instancesService.getUserId(instanceName);
        const userId = prismaInstancia?.userId ?? '';
        const instanceId = prismaInstancia?.instanceId ?? '';

        /* user information */
        const userWithRelations = await this.userService.getUserWithPausar(userId) as User & { pausar: Pausar[] };

        /* apikey */
        const apikeyOpenAi = userWithRelations?.apiUrl as string;
        return { userId, instanceId, userWithRelations, apikeyOpenAi }
    }
    private getClientinfo(data: WebhookDataDto, instanceName: string, server_url: string) {
        //Informacion del tipo de mensaje 
        //Se extraen los datos del usuario emisor dentro de "data" de la llamada del webhook
        const remoteJid = data?.key?.remoteJid ?? '';
        const pushName = data?.pushName || 'Desconocido';
        const fromMe = data?.key?.fromMe ?? false;
        const messageType = data?.messageType ?? '';
        const msgChat = data?.message?.conversation ?? '';
        const conversationMsg = msgChat.trim().toLowerCase();
        const sessionHistoryId = `${instanceName}-${remoteJid}`;
        const apiMsgUrl = `${server_url}/message/sendText/${instanceName}`;

        return { remoteJid, pushName, fromMe, messageType, msgChat, conversationMsg, sessionHistoryId, apiMsgUrl }

    }


}