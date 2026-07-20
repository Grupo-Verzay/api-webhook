/**
 * Reconcilia las conversaciones de la bandeja que quedaron creadas bajo un
 * @lid, llevandolas al numero real del contacto.
 *
 * POR QUE: `persistMessage` guardaba la conversacion con el JID tal cual
 * llegaba. Si el evento venia dirigido por @lid (y `chat_lid_map` estaba vacia
 * por el bug de `key.senderLid`), nacia una conversacion aparte. En la bandeja
 * el cliente aparecia DUPLICADO y con el propio @lid como nombre
 * ("152252530581757") en vez de su nombre real.
 *
 * El arreglo de chat-store.service.ts evita que siga pasando; este script
 * limpia lo ya creado.
 *
 * Dos casos, ambos conservando el historial:
 *   A) No existe conversacion bajo el numero -> se renombra el JID (numero al
 *      frente, @lid como alias). No se borra nada.
 *   B) Ya existe -> se mueven los mensajes que falten a la conversacion buena
 *      y se elimina la duplicada, que queda vacia.
 *
 * Los mensajes viven en `chat_messages`, con unico
 * (userId, instanceName, remoteJid, messageId, fromMe): al mover se saltan los
 * que ya estuvieran en destino para no chocar.
 *
 *   node scripts/merge-lid-conversations.js           -> ensayo (no escribe)
 *   node scripts/merge-lid-conversations.js --apply   -> aplica
 */
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(APPLY ? '=== APLICANDO ===\n' : '=== ENSAYO (no escribe nada) ===\n');

  const filas = await db.$queryRawUnsafe(`
    SELECT c."userId", c."instanceName", c."remoteJid" lid, c."pushName" nombre,
           m."remoteJid" tel,
           EXISTS (SELECT 1 FROM chat_conversations d
                    WHERE d."userId" = c."userId"
                      AND d."instanceName" = c."instanceName"
                      AND d."remoteJid" = m."remoteJid") AS ya_existe
      FROM chat_conversations c
      JOIN chat_lid_map m ON m.lid = c."remoteJid" AND m."userId" = c."userId"
     WHERE c."remoteJid" LIKE '%@lid'
     ORDER BY c."instanceName", c."remoteJid"`);

  const casoA = filas.filter((f) => !f.ya_existe);
  const casoB = filas.filter((f) => f.ya_existe);
  console.log(`Conversaciones @lid resolubles: ${filas.length}`);
  console.log(`  A) renombrar JID (no hay gemela) : ${casoA.length}`);
  console.log(`  B) fusionar con la existente     : ${casoB.length}\n`);

  console.log('Muestra:');
  for (const f of filas.slice(0, 8)) {
    console.log(`  ${f.instanceName} | ${f.lid} -> ${f.tel}  ${f.ya_existe ? '(fusionar)' : '(renombrar)'}  "${f.nombre || ''}"`);
  }

  if (!APPLY) {
    console.log('\n--- ENSAYO: nada modificado. ---');
    console.log('Para aplicar:  node scripts/merge-lid-conversations.js --apply');
    await db.$disconnect();
    return;
  }

  let renombradas = 0;
  let fusionadas = 0;
  let msgsMovidos = 0;
  let fallos = 0;

  for (const f of filas) {
    try {
      await db.$transaction(async (tx) => {
        // Mover los mensajes que la conversacion destino aun no tenga.
        const movidos = await tx.$executeRawUnsafe(
          `UPDATE chat_messages a
              SET "remoteJid" = $1,
                  "remoteJidAlt" = COALESCE(a."remoteJidAlt", $2)
            WHERE a."userId" = $3 AND a."instanceName" = $4 AND a."remoteJid" = $2
              AND NOT EXISTS (
                SELECT 1 FROM chat_messages b
                 WHERE b."userId" = a."userId" AND b."instanceName" = a."instanceName"
                   AND b."remoteJid" = $1 AND b."messageId" = a."messageId"
                   AND b."fromMe" = a."fromMe")`,
          f.tel, f.lid, f.userId, f.instanceName);
        msgsMovidos += movidos;

        // Los que quedaron son duplicados exactos ya presentes en destino.
        await tx.$executeRawUnsafe(
          `DELETE FROM chat_messages
            WHERE "userId" = $1 AND "instanceName" = $2 AND "remoteJid" = $3`,
          f.userId, f.instanceName, f.lid);

        if (f.ya_existe) {
          await tx.$executeRawUnsafe(
            `DELETE FROM chat_conversations
              WHERE "userId" = $1 AND "instanceName" = $2 AND "remoteJid" = $3`,
            f.userId, f.instanceName, f.lid);
        } else {
          await tx.$executeRawUnsafe(
            `UPDATE chat_conversations
                SET "remoteJid" = $1,
                    "remoteJidAlt" = COALESCE("remoteJidAlt", $2),
                    "updatedAt" = NOW()
              WHERE "userId" = $3 AND "instanceName" = $4 AND "remoteJid" = $2`,
            f.tel, f.lid, f.userId, f.instanceName);
        }
      }, { timeout: 30000, maxWait: 15000 });

      if (f.ya_existe) fusionadas++; else renombradas++;
    } catch (e) {
      fallos++;
      const det = String(e.message || e).split('\n').map((l) => l.trim())
        .filter(Boolean).slice(-2).join(' | ');
      console.error(`  FALLO ${f.lid}: ${det}`);
    }
  }

  console.log(`\nRenombradas : ${renombradas}`);
  console.log(`Fusionadas  : ${fusionadas}`);
  console.log(`Mensajes movidos: ${msgsMovidos}   fallos: ${fallos}`);
  const quedan = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::int n FROM chat_conversations WHERE "remoteJid" LIKE '%@lid'`);
  console.log(`Conversaciones que siguen bajo @lid: ${quedan[0].n}`);
  await db.$disconnect();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
