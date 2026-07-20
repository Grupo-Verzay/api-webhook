-- Aviso de "WhatsApp desvinculado": marca persistente por instancia para que un
-- reinicio/deploy NO reenvíe el aviso del mismo slot horario (antes el contador
-- diario vivía sólo en memoria y se reseteaba en cada deploy → avisos duplicados).
ALTER TABLE "Instancias" ADD COLUMN IF NOT EXISTS "last_connection_alert_at" TIMESTAMP(3);
