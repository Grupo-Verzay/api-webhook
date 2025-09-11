import { Injectable, Logger } from '@nestjs/common';
import { WebhookBodyDto, WebhookDataDto } from 'src/modules/webhook/dto/webhook-body';
import { InstancesService } from 'src/modules/instances/instances.service';
import { UserService } from 'src/modules/user/user.service';
import { Pausar, User } from '@prisma/client';
import { flags } from 'src/types/open-ai';



export class WebhookExtractDataService {
    constructor(
        private readonly instancesService: InstancesService,
        private readonly userService: UserService,
    ) { }

     async getUserInfo(instanceName: string, remoteJid: string, pushName: string) {
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
     getClientinfo(data: WebhookDataDto, instanceName: string, server_url: string) {
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