/**
 * Elimina la fila SOBRANTE de los mensajes que quedaron guardados dos veces:
 * una bajo el numero del contacto y otra bajo su @lid, con el MISMO messageId.
 *
 * POR QUE: al enviar desde el panel, el frontend guarda el mensaje con el
 * numero. Un par de segundos despues llega el eco de Evolution dirigido por
 * @lid; como el indice unico incluye el remoteJid, entraba como fila nueva.
 * Resultado: la burbuja aparecia DOS VECES en el chat aunque el cliente
 * recibio un solo mensaje. Es lo que los asesores reportan como
 * "se envia doble".
 *
 * El arreglo de chat-store.service.ts (resolveByMessageId) evita que se sigan
 * creando; este script borra las copias ya existentes.
 *
 * SEGURIDAD: se conserva SIEMPRE la fila del numero (la buena) y se borra solo
 * la del @lid, y unicamente cuando existen las dos con identico messageId. Si
 * un mensaje solo existe bajo @lid, NO se toca: se quedaria sin nada.
 * Antes de borrar, el par se aprende en chat_lid_map.
 *
 *   node scripts/dedupe-lid-messages.js           -> ensayo (no escribe)
 *   node scripts/dedupe-lid-messages.js --apply   -> aplica
 */
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const SQL_DUPES = `
  SELECT lid."userId", lid."instanceName", lid."messageId",
         lid."remoteJid" AS jid_lid,
         tel."remoteJid" AS jid_tel,
         left(lid."content", 38) AS texto,
         to_char(lid."messageTimestamp", 'MM-DD HH24:MI') AS ts
    FROM chat_messages lid
    JOIN chat_messages tel
      ON tel."userId" = lid."userId"
     AND tel."instanceName" = lid."instanceName"
     AND tel."messageId" = lid."messageId"
     AND tel."fromMe" = lid."fromMe"
     AND tel."remoteJid" NOT LIKE '%@lid'
   WHERE lid."remoteJid" LIKE '%@lid'
`;

(async () => {
  console.log(APPLY ? '=== APLICANDO ===\n' : '=== ENSAYO (no escribe nada) ===\n');

  const dupes = await db.$queryRawUnsafe(SQL_DUPES);
  console.log(`Mensajes guardados por duplicado (numero + @lid): ${dupes.length}\n`);

  console.log('Muestra:');
  for (const d of dupes.slice(0, 10)) {
    console.log(`  ${d.ts}  ${d.instanceName}`);
    console.log(`     se conserva: ${d.jid_tel}`);
    console.log(`     se borra   : ${d.jid_lid}   "${(d.texto || '').replace(/\n/g, ' ')}"`);
  }

  if (!APPLY) {
    console.log('\n--- ENSAYO: nada modificado. ---');
    console.log('Para aplicar:  node scripts/dedupe-lid-messages.js --apply');
    await db.$disconnect();
    return;
  }

  // 1) Aprender los pares antes de borrar (el @lid desaparece de los mensajes).
  let aprendidos = 0;
  for (const d of dupes) {
    try {
      await db.$executeRawUnsafe(
        `INSERT INTO "chat_lid_map" ("userId","lid","remoteJid","updatedAt")
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT ("userId","lid")
         DO UPDATE SET "remoteJid" = EXCLUDED."remoteJid", "updatedAt" = NOW()`,
        d.userId, d.jid_lid, d.jid_tel);
      aprendidos++;
    } catch { /* best-effort */ }
  }
  console.log(`\nPares aprendidos en chat_lid_map: ${aprendidos}`);

  // 2) Borrar SOLO la copia bajo @lid.
  let borrados = 0;
  for (const d of dupes) {
    try {
      const n = await db.$executeRawUnsafe(
        `DELETE FROM chat_messages
          WHERE "userId" = $1 AND "instanceName" = $2
            AND "messageId" = $3 AND "remoteJid" = $4`,
        d.userId, d.instanceName, d.messageId, d.jid_lid);
      borrados += n;
    } catch (e) {
      console.error(`  fallo ${d.messageId}: ${e.message.split('\n')[0]}`);
    }
  }

  console.log(`Copias @lid borradas: ${borrados}`);
  const quedan = await db.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM (${SQL_DUPES}) x`);
  console.log(`Duplicados restantes: ${quedan[0].n}  <- deberia ser 0`);
  await db.$disconnect();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
