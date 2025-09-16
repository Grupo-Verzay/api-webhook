import { Injectable, Logger } from '@nestjs/common';
import { WebhookBodyDto } from '../../dto/webhook-body';
import { ClientData } from '../../dto/client-data';
import { UserContext } from '../../dto/user-context';
import { InstancesService } from 'src/modules/instances/instances.service';
import { UserService } from 'src/modules/user/user.service';
import { Pausar, User } from '@prisma/client';


@Injectable()
class WebhookOrchestatorService {
    constructor(
        private readonly instancesService: InstancesService,
        private readonly userService: UserService
    ) {

    }

    async extractRequest(body: WebhookBodyDto): Promise<{ clientData: ClientData, userContext: UserContext }> {
        // Se extraen los datos de la llamada del webhook
        const {
            instance: instanceName,
            server_url,
            apikey,
            data,
        } = body;
        //Se extraen los datos del usuario emisor dentro de "data" de la llamada del webhook
        const remoteJid = data?.key?.remoteJid ?? '';
        const pushName = data?.pushName || 'Desconocido';
        const conversationMsg = (data?.message?.conversation ?? '').trim().toLowerCase();
        const fromMe = data?.key?.fromMe ?? false;
        const messageType = data?.messageType ?? '';
        //Objeto cliente 
        const clientData = new ClientData(remoteJid, pushName, conversationMsg, fromMe, messageType);

        // Lógica para obtener el usuario y la instancia
        const prismaInstancia = await this.instancesService.getUserId(instanceName);
        if (!prismaInstancia) throw new Error('Instancia no encontrada');
        //Se busca la informacion del usuario en la aplicacion a partir de su instancia en evolution api
        const userId = prismaInstancia?.userId ?? '';
        const instanceId = prismaInstancia?.instanceId ?? '';
        /* user information */
        const user = await this.userService.getUserById(userId) as User;

        const userContext = new UserContext(
            //Datos del usuario
            userId,
            instanceId,
            instanceName,
            apikey,
            `${server_url}/message/sendText/${instanceName}`,
            user?.webhookUrl ?? '' ,
            user.notificationNumber,
            user.muteAgentResponses,
            user.del_seguimiento ?? '',
            user.autoReactivate ?? '' ,

            //Inyeccion de servicio del usuario e instancia
            this.instancesService,
            this.userService,
        )
        return {
            clientData,
            userContext,
        }
    }

    validateRequest() {
        return {

        }

    }

    proccessData() {
        return {}
    }

}