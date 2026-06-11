-- CreateTable
CREATE TABLE IF NOT EXISTS "plan_configs" (
    "id" TEXT NOT NULL,
    "plan" "Plan" NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "plan_configs_plan_key" ON "plan_configs"("plan");

-- Seed default plan credits
INSERT INTO "plan_configs" ("id", "plan", "credits", "updatedAt") VALUES
  (gen_random_uuid()::text, 'lite',         1000,  NOW()),
  (gen_random_uuid()::text, 'basico',       3000,  NOW()),
  (gen_random_uuid()::text, 'intermedio',   5000,  NOW()),
  (gen_random_uuid()::text, 'avanzado',     8000,  NOW()),
  (gen_random_uuid()::text, 'enterprise',   10000, NOW()),
  (gen_random_uuid()::text, 'personalizado', 0,    NOW())
ON CONFLICT ("plan") DO NOTHING;
