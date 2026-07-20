/**
 * Corrige el JID de las sesiones que quedaron guardadas bajo un @lid cuando el
 * contacto NO tiene otra sesion en esa misma linea.
 *
 * ORIGEN: el webhook aprendia el par @lid->numero leyendo `key.senderLid`, un
 * campo que Evolution no envia, asi que `chat_lid_map` estaba vacia y cada
 * evento dirigido solo por @lid creaba una sesion bajo ese @lid. El contacto
 * aparecia con un "numero raro" por nombre y el panel no lo encontraba.
 *
 * Aqui NO se borra ni se fusiona nada: solo se pone el numero real al frente y
 * el @lid como alias, en sesiones que no chocan con ninguna otra. Es la parte
 * segura de la limpieza. Las que SI tienen una gemela bajo el numero requieren
 * fusionar datos y se tratan aparte.
 *
 * Requisito: `chat_lid_map` poblada (scripts/backfill-lid-map.js --apply).
 *
 *   node scripts/fix-lid-session-jids.js           -> ensayo (no escribe)
 *   node scripts/fix-lid-session-jids.js --apply   -> aplica
 */
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(APPLY ? '=== APLICANDO ===\n' : '=== ENSAYO (no escribe nada) ===\n');

  const candidatas = await db.$queryRawUnsafe(`
    SELECT s.id, s."userId", s."instanceId", s."remoteJid" lid,
           s."pushName" nombre, m."remoteJid" tel
      FROM "Session" s
      JOIN chat_lid_map m ON m.lid = s."remoteJid" AND m."userId" = s."userId"
     WHERE s."remoteJid" LIKE '%@lid'
       AND NOT EXISTS (
         SELECT 1 FROM "Session" r
          WHERE r."userId" = s."userId"
            AND r."instanceId" = s."instanceId"
            AND r."remoteJid" = m."remoteJid")
     ORDER BY s.id`);

  console.log(`Sesiones a corregir: ${candidatas.length}\n`);
  console.log('Muestra:');
  for (const c of candidatas.slice(0, 10)) {
    console.log(`  id=${c.id}  "${c.nombre}"  ${c.lid}  ->  ${c.tel}`);
  }

  if (!APPLY) {
    console.log('\n--- ENSAYO: nada modificado. ---');
    console.log('Para aplicar:  node scripts/fix-lid-session-jids.js --apply');
    await db.$disconnect();
    return;
  }

  let ok = 0;
  let saltadas = 0;
  for (const c of candidatas) {
    const choque = await db.$queryRawUnsafe(
      `SELECT id FROM "Session" WHERE "userId"=$1 AND "instanceId"=$2 AND "remoteJid"=$3 LIMIT 1`,
      c.userId, c.instanceId, c.tel);
    if (choque.length) {
      saltadas++;
      console.log(`  salto id=${c.id}: ${c.tel} ya lo ocupa la sesion ${choque[0].id}`);
      continue;
    }
    try {
      await db.$executeRawUnsafe(
        `UPDATE "Session" SET "remoteJid" = $1, "remoteJidAlt" = $2, "updatedAt" = NOW() WHERE id = $3`,
        c.tel, c.lid, c.id);
      ok++;
    } catch (e) {
      console.error(`  fallo id=${c.id}: ${e.message.split('\n')[0]}`);
    }
  }

  console.log(`\nCorregidas: ${ok}   saltadas por choque: ${saltadas}`);
  const quedan = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::int n FROM "Session" WHERE "remoteJid" LIKE '%@lid'`);
  console.log(`Sesiones que siguen bajo @lid: ${quedan[0].n}`);
  await db.$disconnect();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
