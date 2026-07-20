-- User.sheets_auto_sync_enabled
--
-- El esquema del frontend ya declaraba este campo
-- (sheetsAutoSyncEnabled @map("sheets_auto_sync_enabled")) y lo usa
-- google-sheets-actions.ts, pero la columna nunca se creó en la base: el
-- frontend dejó de correr `db push` y no llegó a existir migración aquí.
--
-- Resultado: TODA consulta que leyera el usuario completo fallaba con
-- P2022 y devolvía 500. Entre ellas la agenda pública (/schedule/[userId]),
-- así que los clientes no podían reservar reunión.
--
-- La columna ya se creó a mano en producción para restablecer el servicio;
-- esta migración la deja registrada para que cualquier base nueva (o una
-- restauración) la tenga desde el principio. Con IF NOT EXISTS es
-- idempotente: en producción no hace nada.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "sheets_auto_sync_enabled" BOOLEAN NOT NULL DEFAULT false;
