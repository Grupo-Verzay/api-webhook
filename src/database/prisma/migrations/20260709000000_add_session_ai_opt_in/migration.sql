-- Opt-in de IA por contacto.
-- Permite que la IA responda a un contacto específico aunque el interruptor global
-- "Estado del agente" (User.muteAgentResponses) esté apagado. Lo activa el nodo
-- "Activar IA" de un flujo por palabra clave o el toggle "Agente" del chat.
-- Idempotente (IF NOT EXISTS) porque el frontend puede crearla antes vía prisma db push.
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "ai_opt_in" BOOLEAN NOT NULL DEFAULT false;
