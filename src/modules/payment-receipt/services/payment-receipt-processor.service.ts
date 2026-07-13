import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { SystemNotificationDispatcherService } from 'src/modules/whatsapp/services/system-notification-dispatcher.service';

import { PaymentReceiptAnalyzerService } from './payment-receipt-analyzer.service';
import { PaymentReceiptValidatorService } from './payment-receipt-validator.service';
import { PaymentClientMatcherService } from './payment-client-matcher.service';
import { ProcessResult } from '../types/receipt-analysis.types';

const ADMIN_USER_ID = process.env.ADMIN_USER_ID ?? 'cm842kthc0000qd2l66nbnytv';

export type IncomingReceiptPayload = {
  content: string;
  remoteJid: string;
};

@Injectable()
export class PaymentReceiptProcessorService {
  private readonly verzayAppUrl: string;
  private readonly cronSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
    private readonly configService: ConfigService,
    private readonly analyzer: PaymentReceiptAnalyzerService,
    private readonly validator: PaymentReceiptValidatorService,
    private readonly matcher: PaymentClientMatcherService,
    private readonly notificationDispatcher: SystemNotificationDispatcherService,
  ) {
    this.verzayAppUrl = (
      this.configService.get<string>('BILLING_CRON_ENDPOINT_URL') ??
      this.configService.get<string>('NEXTAUTH_URL') ??
      ''
    ).replace(/\/+$/, '');

    this.cronSecret = this.configService.get<string>('CRON_SECRET') ?? '';
  }

  async handle(payload: IncomingReceiptPayload): Promise<ProcessResult> {
    const { content, remoteJid } = payload;

    this.logger.log(
      `[PaymentReceiptProcessor] Analizando comprobante de ${remoteJid}`,
      'PaymentReceiptProcessor',
    );

    const analysis = await this.analyzer.analyze(content, ADMIN_USER_ID);

    if (!analysis.isPaymentReceipt || analysis.confidenceScore < 50) {
      return { success: false, message: 'No identificado como comprobante de pago.' };
    }

    const validation = await this.validator.validate(analysis);

    if (!validation.isValid) {
      this.logger.warn(
        `[PaymentReceiptProcessor] Comprobante invalido de ${remoteJid}: ${validation.reason}`,
        'PaymentReceiptProcessor',
      );
      await this.notifyAdmin(
        `⚠️ Comprobante rechazado de ${remoteJid}\nRazon: ${validation.reason}\nMonto: ${analysis.amount} ${analysis.currency}\nMetodo: ${analysis.method}`,
        remoteJid,
      );
      return { success: false, message: validation.reason };
    }

    const clientUserId = await this.matcher.findClientByRemoteJid(remoteJid);

    if (!clientUserId) {
      this.logger.warn(
        `[PaymentReceiptProcessor] Cliente no encontrado para remoteJid=${remoteJid}`,
        'PaymentReceiptProcessor',
      );
      await this.notifyAdmin(
        `⚠️ Comprobante sin cliente de ${remoteJid}\nMonto: ${analysis.amount} ${analysis.currency}\nMetodo: ${analysis.method}\nReferencia: ${analysis.reference ?? 'N/A'}\n\nConfirmar manualmente.`,
        remoteJid,
      );
      return { success: false, message: 'Cliente no encontrado para ese numero de WhatsApp.' };
    }

    const externalReference = this.validator.buildExternalReference(analysis);

    const confirmResult = await this.callConfirmPayment({
      clientUserId,
      amount: analysis.amount!,
      currencyCode: analysis.currency ?? 'COP',
      externalReference,
      notes: `Comprobante ${analysis.method} | ${analysis.reference ?? ''} | ${analysis.date ?? ''}`.trim(),
    });

    if (!confirmResult.success) {
      this.logger.error(
        `[PaymentReceiptProcessor] Error confirmando pago para userId=${clientUserId}: ${confirmResult.message}`,
        'PaymentReceiptProcessor',
      );
      await this.notifyAdmin(
        `❌ Error al confirmar pago de ${remoteJid}\nCliente ID: ${clientUserId}\nError: ${confirmResult.message}`,
        remoteJid,
      );
      return { success: false, message: confirmResult.message };
    }

    if (confirmResult.alreadyProcessed) {
      return { success: true, message: 'Pago ya procesado anteriormente.', alreadyProcessed: true };
    }

    await this.notifyClient(
      remoteJid,
      `✅ *Pago confirmado!*\n*Monto:* ${analysis.amount} ${analysis.currency}\n*Metodo:* ${analysis.method}\n*Referencia:* ${analysis.reference ?? 'N/A'}\n\nTu acceso ha sido activado. Gracias!`,
    );

    await this.notifyAdmin(
      `✅ Pago confirmado automaticamente\nCliente: ${remoteJid}\nMonto: ${analysis.amount} ${analysis.currency}\nMetodo: ${analysis.method}\nReferencia: ${analysis.reference ?? 'N/A'}\nProximo vencimiento: ${confirmResult.newDueDate ? new Date(confirmResult.newDueDate).toLocaleDateString('es-CO') : 'N/A'}`,
      remoteJid,
    );

    this.logger.log(
      `[PaymentReceiptProcessor] Pago confirmado para userId=${clientUserId}, newDueDate=${confirmResult.newDueDate}`,
      'PaymentReceiptProcessor',
    );

    return {
      success: true,
      message: 'Pago confirmado exitosamente.',
      clientUserId,
      newDueDate: confirmResult.newDueDate,
    };
  }

  private async callConfirmPayment(input: {
    clientUserId: string;
    amount: number;
    currencyCode: string;
    externalReference: string;
    notes?: string;
  }): Promise<{ success: boolean; message: string; newDueDate?: string; alreadyProcessed?: boolean }> {
    if (!this.verzayAppUrl || !this.cronSecret) {
      return {
        success: false,
        message: 'BILLING_CRON_ENDPOINT_URL o CRON_SECRET no configurados.',
      };
    }

    try {
      const response = await axios.post(
        `${this.verzayAppUrl}/api/payment/confirm`,
        {
          clientUserId: input.clientUserId,
          amount: input.amount,
          currencyCode: input.currencyCode,
          source: 'WHATSAPP_RECEIPT',
          externalReference: input.externalReference,
          notes: input.notes ?? null,
        },
        {
          headers: {
            Authorization: `Bearer ${this.cronSecret}`,
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
      );

      return {
        success: response.data?.success === true,
        message: response.data?.message ?? 'Sin mensaje.',
        newDueDate: response.data?.newDueDate,
        alreadyProcessed: response.data?.alreadyProcessed === true,
      };
    } catch (error: unknown) {
      const msg = (error as any)?.response?.data?.message ?? (error as any)?.message ?? 'Error HTTP';
      return { success: false, message: msg };
    }
  }

  private async notifyAdmin(text: string, contact?: string): Promise<void> {
    try {
      const line = await this.notificationDispatcher.resolveLine(ADMIN_USER_ID);
      if (!line) return;

      if (line.provider === 'meta') {
        await this.notificationDispatcher.sendInternalNotification({
          ownerUserId: ADMIN_USER_ID,
          targetUserId: ADMIN_USER_ID,
          type: 'Pago',
          name: 'Sistema',
          description: text,
          contact: contact ?? '',
        });
        return;
      }

      const phones = await this.notificationDispatcher.getNotificationPhones(ADMIN_USER_ID);
      for (const phone of phones) {
        await this.notificationDispatcher.sendText({ line, remoteJid: phone, text });
      }
    } catch {
      // Una notificacion no debe romper el flujo de pago.
    }
  }

  private async notifyClient(remoteJid: string, text: string): Promise<void> {
    try {
      const line = await this.notificationDispatcher.resolveLine(ADMIN_USER_ID);
      if (!line) return;

      await this.notificationDispatcher.sendText({ line, remoteJid, text });
    } catch {
      // Silencioso.
    }
  }
}
