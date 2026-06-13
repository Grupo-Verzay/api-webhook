-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "StageActionType" AS ENUM ('TAG_ADD', 'TAG_REMOVE', 'TASK', 'ASSIGN', 'EXECUTE_FLOW', 'MESSAGE', 'REMINDER', 'NOTIFY_ADVISOR', 'TOGGLE_AI', 'SEND_FILE', 'WEBHOOK', 'CHANGE_STATUS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "stage_automations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stage" "LeadStatus" NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stage_automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "stage_automation_actions" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "type" "StageActionType" NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL,
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stage_automation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stage_automations_userId_stage_idx" ON "stage_automations"("userId", "stage");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stage_automation_actions_automationId_idx" ON "stage_automation_actions"("automationId");

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "stage_automations" ADD CONSTRAINT "stage_automations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "stage_automation_actions" ADD CONSTRAINT "stage_automation_actions_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "stage_automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
