CREATE TABLE "ia_credit_alerts" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "threshold" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ia_credit_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ia_credit_alerts_userId_threshold_key"
  ON "ia_credit_alerts"("userId", "threshold");

CREATE INDEX "ia_credit_alerts_userId_createdAt_idx"
  ON "ia_credit_alerts"("userId", "createdAt");
