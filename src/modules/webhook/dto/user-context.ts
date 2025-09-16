// En un archivo como: src/webhook/dto/user-context.dto.ts
import { User, Pausar } from '@prisma/client';
import { InstancesService } from 'src/modules/instances/instances.service';
import { UserService } from 'src/modules/user/user.service';

export class UserContext {
    constructor(
        public readonly id: string,
        public readonly instanceId: string,
        public readonly instanceName: string,
        public readonly evoApikey: string,
        public readonly apiUrl: string,
        public readonly webhookUrl: string,
        public readonly notificationNumber: string,
        public readonly muteAgentResponses: boolean,
        public readonly del_seguimiento: string,
        public readonly autoReactivate: string,

        // Servicio para obtener datos del cliente
        private readonly instancesService: InstancesService,
        private readonly userService: UserService
    ) { }

    public async getReactivationPhrase():Promise< string | undefined> {
        const pausar = await this.getPausar()
        return pausar?.find(p => p.tipo === 'abrir')?.mensaje?.trim().toLowerCase();
    }

    public async getPausar():Promise<Pausar[]|null>{
        const pausar = await this.userService.getPausarForUser(this.id)    
        return pausar
    }


}