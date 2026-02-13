import { Injectable, Logger } from '@nestjs/common';
import { ClassifyMessageDto } from '../../dto/classify-message.dto';
import { LeadClassifierIaService } from '../lead-classifier-ia/lead-classifier-ia.service';
import { RegistroService } from '../registro/registro.service';
import { ReporteSintesisService } from '../reporte-sintesis/reporte-sintesis.service';
import { TipoRegistro } from '@prisma/client';

@Injectable()
export class LeadFunnelService {
    private readonly logger = new Logger(LeadFunnelService.name);

    constructor(
        private readonly classifier: LeadClassifierIaService,
        private readonly registroService: RegistroService,
        private readonly reporteService: ReporteSintesisService,
    ) { }

    async processIncomingText(input: ClassifyMessageDto): Promise<void> {
        const result = await this.classifier.classify(input);

        if (result.kind === 'REGISTRO') {
            if (!result.tipo) return;

            await this.registroService.createRegistro({
                sessionId: input.sessionDbId,
                tipo: result.tipo as TipoRegistro,
                estado: result.estado,
                resumen: result.resumen,
                detalles: result.detalles,
                lead: result.lead,
                nombre: result.nombre,
                meta: result.meta,
                fecha: new Date(),
            });

            this.logger.log(
                `Registro creado: tipo=${result.tipo} estado=${result.estado ?? '-'} sessionId=${input.sessionDbId}`,
            );
            return;
        }

        // REPORTE
        const sintesis = result.sintesis ?? result.resumen ?? '';
        if (sintesis) {
            await this.reporteService.updateSintesis(input.sessionDbId, sintesis);
            this.logger.log(`Síntesis actualizada sessionId=${input.sessionDbId}`);
        }
    }
}