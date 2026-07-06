import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from 'src/database/prisma.service';
import { ReceiptAnalysis, ValidationResult } from '../types/receipt-analysis.types';

/** Días máximos de antigüedad permitidos para un comprobante */
const MAX_RECEIPT_AGE_DAYS = 30;

/** Umbral mínimo de confianza para considerar válido */
const MIN_CONFIDENCE_SCORE = 70;

@Injectable()
export class PaymentReceiptValidatorService {
  private readonly accountsWhitelist: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    // Cuentas destino válidas de Verzay (configurables por env)
    const raw =
      this.configService.get<string>('VERZAY_ACCOUNTS_WHITELIST') ?? '';
    this.accountsWhitelist = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  async validate(analysis: ReceiptAnalysis): Promise<ValidationResult> {
    // 1. ¿El LLM identificó esto como comprobante con suficiente confianza?
    if (!analysis.isPaymentReceipt) {
      return { isValid: false, reason: 'El contenido no parece ser un comprobante de pago.' };
    }
    if (analysis.confidenceScore < MIN_CONFIDENCE_SCORE) {
      return {
        isValid: false,
        reason: `Confianza insuficiente (${analysis.confidenceScore}/100). Requiere revisión manual.`,
      };
    }

    // 2. El monto debe ser extraíble, con moneda reconocible y positivo.
    //    La validación de que el monto COINCIDE con el precio configurado del
    //    cliente se hace en verzay-app (confirmPaymentInternal), que sí conoce
    //    al cliente y su precio en /panel/client-billing.
    if (analysis.amount === null) {
      return { isValid: false, reason: 'No se pudo extraer el monto del comprobante.' };
    }
    if (analysis.currency !== 'COP' && analysis.currency !== 'USD') {
      return { isValid: false, reason: 'No se pudo determinar la moneda del comprobante.' };
    }
    if (analysis.amount <= 0) {
      return { isValid: false, reason: 'Monto del comprobante inválido.' };
    }

    // 3. ¿La fecha es reciente?
    if (analysis.date) {
      const receiptDate = new Date(analysis.date);
      if (Number.isNaN(receiptDate.getTime())) {
        return { isValid: false, reason: 'Fecha del comprobante inválida.' };
      }
      const now = new Date();
      const diffDays = (now.getTime() - receiptDate.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays < 0) {
        return { isValid: false, reason: 'La fecha del comprobante es futura.' };
      }
      if (diffDays > MAX_RECEIPT_AGE_DAYS) {
        return {
          isValid: false,
          reason: `Comprobante con más de ${MAX_RECEIPT_AGE_DAYS} días de antigüedad.`,
        };
      }
    }

    // 4. ¿La cuenta destino pertenece a Verzay?
    if (analysis.recipientAccount && this.accountsWhitelist.length > 0) {
      const normalizedRecipient = analysis.recipientAccount.toLowerCase().trim();
      const isWhitelisted = this.accountsWhitelist.some(
        (allowed) =>
          normalizedRecipient.includes(allowed) || allowed.includes(normalizedRecipient),
      );
      if (!isWhitelisted) {
        return {
          isValid: false,
          reason: `Cuenta destino "${analysis.recipientAccount}" no corresponde a Verzay.`,
        };
      }
    }

    // 5. Deduplicación: ¿ya fue procesado este comprobante?
    if (analysis.reference) {
      const externalRef = this.buildExternalReference(analysis);
      const existing = await this.prisma.financeTransaction.findUnique({
        where: { externalReference: externalRef },
        select: { id: true },
      });
      if (existing) {
        return { isValid: false, reason: 'Este comprobante ya fue procesado anteriormente.' };
      }
    }

    return { isValid: true };
  }

  /**
   * Construye la externalReference que se usará para deduplicación y registro.
   * Formato: RECEIPT-{method}-{reference} o RECEIPT-{method}-{amount}-{normalizedDate}
   */
  buildExternalReference(analysis: ReceiptAnalysis): string {
    if (analysis.reference) {
      return `RECEIPT-${analysis.method}-${analysis.reference}`;
    }
    // Fallback sin referencia: usa monto + fecha normalizada
    const datePart = analysis.date
      ? new Date(analysis.date).toISOString().slice(0, 10).replace(/-/g, '')
      : Date.now().toString();
    return `RECEIPT-${analysis.method}-${analysis.amount ?? 0}-${datePart}`;
  }
}
