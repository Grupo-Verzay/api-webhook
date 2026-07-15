import { Injectable } from '@nestjs/common';
import { LoggerService } from 'src/core/logger/logger.service';
import { PrismaService } from 'src/database/prisma.service';
import { Plan } from '@prisma/client';
import { randomUUID } from 'crypto';

const TOKENS_PER_CREDIT = 3085;

/** Fallback credits per plan when no PlanConfig row exists in DB. */
const PLAN_CREDIT_DEFAULTS: Record<Plan, number> = {
  lite: 1_000,
  basico: 3_000,
  intermedio: 5_000,
  avanzado: 8_000,
  enterprise: 10_000,
  personalizado: 0,
};

type CreditResult =
  | { success: true; total: number; used: number; available: number; renewalDate: Date }
  | { success: false; msg: string };

export interface PlanConfigDto {
  plan: Plan;
  credits: number;
}

@Injectable()
export class AiCreditsService {
  constructor(
    private readonly logger: LoggerService,
    private readonly prisma: PrismaService,
  ) {}

  // ── Plan Config ──────────────────────────────────────────────────

  async getPlanDefaultCredits(plan: Plan): Promise<number> {
    try {
      const config = await this.prisma.planConfig.findUnique({ where: { plan } });
      return config?.credits ?? PLAN_CREDIT_DEFAULTS[plan] ?? 0;
    } catch {
      return PLAN_CREDIT_DEFAULTS[plan] ?? 0;
    }
  }

  async getAllPlanConfigs(): Promise<PlanConfigDto[]> {
    const configs = await this.prisma.planConfig.findMany();
    return (Object.keys(PLAN_CREDIT_DEFAULTS) as Plan[]).map((plan) => {
      const existing = configs.find((c) => c.plan === plan);
      return { plan, credits: existing?.credits ?? PLAN_CREDIT_DEFAULTS[plan] };
    });
  }

  async updatePlanConfig(plan: Plan, credits: number): Promise<PlanConfigDto> {
    const record = await this.prisma.planConfig.upsert({
      where: { plan },
      create: { id: randomUUID(), plan, credits },
      update: { credits },
    });
    return { plan: record.plan, credits: record.credits };
  }

  // ── Credit Sync ──────────────────────────────────────────────────

  /**
   * Syncs ia_credits.total to the plan's configured credits.
   * Called when a user's plan is set or changed.
   * Does nothing for 'personalizado' (manual assignment only).
   */
  async syncCreditsWithPlan(userId: string, plan: Plan): Promise<void> {
    if (plan === 'personalizado') return;

    const credits = await this.getPlanDefaultCredits(plan);
    const renewalDate = new Date();
    renewalDate.setMonth(renewalDate.getMonth() + 1);

    try {
      await this.prisma.iaCredit.upsert({
        where: { userId },
        create: { id: randomUUID(), userId, total: credits, used: 0, renewalDate },
        update: { total: credits },
      });
      await this.clearNotifiedThresholds(userId);
      this.logger.log(
        `[syncCreditsWithPlan] userId=${userId} plan=${plan} → total=${credits}`,
      );
    } catch (error: any) {
      this.logger.error(
        `[syncCreditsWithPlan] Error para userId=${userId}`,
        error?.message,
      );
    }
  }

  /**
   * Admin override: sets a specific total for a user.
   * Use for 'personalizado' plan or special agreements.
   */
  async overrideUserCredits(userId: string, total: number): Promise<void> {
    try {
      await this.prisma.iaCredit.upsert({
        where: { userId },
        create: {
          id: randomUUID(),
          userId,
          total,
          used: 0,
          renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
        update: { total },
      });
      await this.clearNotifiedThresholds(userId);
    } catch (error: any) {
      this.logger.error(
        `[overrideUserCredits] Error para userId=${userId}`,
        error?.message,
      );
    }
  }

  // ── Renewal ──────────────────────────────────────────────────────

  /**
   * Renews all credits past their renewalDate.
   * - Resets used = 0
   * - Updates total to the plan's current credits (except 'personalizado')
   * - Advances renewalDate by 1 month
   */
  async renewDueCredits(): Promise<{ count: number }> {
    const now = new Date();

    const due = await this.prisma.iaCredit.findMany({
      where: { renewalDate: { lte: now } },
      include: { user: { select: { plan: true } } },
    });

    if (due.length === 0) return { count: 0 };

    let count = 0;
    for (const credit of due) {
      try {
        const plan = credit.user.plan;
        const newTotal =
          plan !== 'personalizado'
            ? await this.getPlanDefaultCredits(plan)
            : credit.total;

        const newRenewalDate = new Date(credit.renewalDate);
        newRenewalDate.setMonth(newRenewalDate.getMonth() + 1);

        await this.prisma.iaCredit.update({
          where: { id: credit.id },
          data: { used: 0, total: newTotal, renewalDate: newRenewalDate },
        });
        await this.clearNotifiedThresholds(credit.userId);
        count++;
      } catch (error: any) {
        this.logger.error(
          `[renewDueCredits] Error renovando userId=${credit.userId}`,
          error?.message,
        );
      }
    }

    this.logger.log(`[renewDueCredits] Renovados: ${count} usuarios`);
    return { count };
  }

  // ── Credit Threshold Notification Tracking ──────────────────────
  // Persisted dedup: evita enviar la misma alerta mas de una vez por ciclo,
  // incluso si el contenedor reinicia.
  async claimThresholdNotification(userId: string, pct: number): Promise<boolean> {
    try {
      await this.prisma.iaCreditAlert.create({
        data: { id: randomUUID(), userId, threshold: pct },
      });
      return true;
    } catch (error: any) {
      if (error?.code === 'P2002') return false;
      this.logger.error(
        `[claimThresholdNotification] Error userId=${userId} threshold=${pct}`,
        error?.message || error,
      );
      return false;
    }
  }

  async clearNotifiedThresholds(userId: string): Promise<void> {
    await this.prisma.iaCreditAlert.deleteMany({ where: { userId } });
  }

  // ── Token Tracking ───────────────────────────────────────────────

  public async trackTokens(userId: string, tokens: number): Promise<void> {
    if (!userId || typeof userId !== 'string') {
      this.logger.warn('trackTokens: userId inválido.');
      return;
    }

    if (typeof tokens !== 'number' || tokens <= 0) {
      this.logger.log(
        `trackTokens: tokens inválidos o cero (${tokens}). No se hará nada.`,
      );
      return;
    }

    const tokensInt = Math.trunc(tokens);
    if (tokensInt <= 0) return;

    try {
      this.logger.log(
        `trackTokens: registrando ${tokensInt} tokens para userId=${userId}`,
      );

      // Fallback total when creating a new record: use the user's plan credits
      let defaultTotal = 1_000;
      try {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { plan: true },
        });
        if (user) {
          defaultTotal = (await this.getPlanDefaultCredits(user.plan)) || 1_000;
        }
      } catch { /* keep default */ }

      await this.prisma.iaCredit.upsert({
        where: { userId },
        create: {
          id: randomUUID(),
          userId,
          used: tokensInt,
          total: defaultTotal,
          renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          updatedAt: new Date(),
        },
        update: {
          used: { increment: tokensInt },
          updatedAt: new Date(),
        },
      });

      this.logger.log(
        `trackTokens: tokens actualizados correctamente para userId=${userId}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Error en trackTokens para userId=${userId}`,
        error?.message || error,
        'AiCreditsService',
      );
    }
  }

  // ── Credit Query ─────────────────────────────────────────────────

  public async getCreditsByUser(userId: string): Promise<CreditResult> {
    if (!userId || typeof userId !== 'string') {
      this.logger.error('getCreditsByUser: userId inválido o no proporcionado');
      return { success: false, msg: 'userId inválido o no proporcionado' };
    }

    try {
      const credit = await this.prisma.iaCredit.findUnique({
        where: { userId },
      });

      if (!credit) {
        this.logger.error(`No se encontraron créditos para userId=${userId}`);
        return { success: false, msg: 'No se encontraron créditos' };
      }

      if (credit.total < 0) {
        this.logger.log(`Créditos userId=${userId} → ILIMITADO`);
        return {
          success: true,
          total: -1,
          used: 0,
          available: 999999999,
          renewalDate: credit.renewalDate,
        };
      }

      const usedCredits = Math.floor(credit.used / TOKENS_PER_CREDIT);
      const availableCredits = Math.max(credit.total - usedCredits, 0);

      this.logger.log(
        `Créditos userId=${userId} → Total:${credit.total} Usados:${usedCredits} Disponibles:${availableCredits}`,
      );

      return {
        success: true,
        total: credit.total,
        used: usedCredits,
        available: availableCredits,
        renewalDate: credit.renewalDate,
      };
    } catch (error: any) {
      this.logger.error(
        `Error al obtener créditos de userId=${userId}`,
        error?.message || error,
      );
      return { success: false, msg: 'Error al obtener créditos' };
    }
  }
}
