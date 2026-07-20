/**
 * Rellena `chat_lid_map` con los pares (@lid -> número) que ya están guardados
 * en los payloads de `chat_messages`.
 *
 * POR QUÉ: el webhook aprendía el par leyendo `key.senderLid`, un campo que
 * Evolution no envía (0 apariciones en 12.032 payloads de 3 días), así que la
 * tabla llevaba 0 filas y la protección anti-duplicados nunca actuó: cada
 * evento dirigido solo por @lid creaba una sesión nueva (contacto duplicado,
 * nombre cambiado, reasignación de asesor y automatizaciones repetidas).
 *
 * El arreglo del webhook evita que siga pasando de aquí en adelante; este
 * script recupera lo ya vivido para que los contactos actuales queden bien sin
 * esperar a que cada uno vuelva a escribir.
 *
 * Es IDEMPOTENTE (ON CONFLICT DO UPDATE) y solo escribe en chat_lid_map:
 * no toca sesiones, mensajes ni asignaciones.
 *
 *   node scripts/backfill-lid-map.js            -> ensayo (no escribe)
 *   node scripts/backfill-lid-map.js --apply    -> escribe
 */
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const APPLY = process.argv.includes('--apply');

// Un @lid puede haberse visto junto a varios números (reenvíos, cambios de
// dispositivo). Nos quedamos con el más reciente por (userId, lid).
const SQL_PARES = `
  WITH observados AS (
    SELECT "userId",
           raw->'key'->>'remoteJid'    AS lid,
           raw->'key'->>'remoteJidAlt' AS tel,
           "messageTimestamp"          AS ts
      FROM chat_messages
     WHERE raw->'key'->>'remoteJid'    LIKE '%@lid'
       AND raw->'key'->>'remoteJidAlt' LIKE '%@s.whatsapp.net'
    UNION ALL
    SELECT "userId",
           raw->'key'->>'participant'    AS lid,
           raw->'key'->>'participantAlt' AS tel,
           "messageTimestamp"            AS ts
      FROM chat_messages
     WHERE raw->'key'->>'participant'    LIKE '%@lid'
       AND raw->'key'->>'participantAlt' LIKE '%@s.whatsapp.net'
  ),
  ranked AS (
    SELECT "userId", lid, tel, ts,
           ROW_NUMBER() OVER (PARTITION BY "userId", lid ORDER BY ts DESC) AS rn
      FROM observados
     WHERE "userId" IS NOT NULL AND "userId" <> ''
  )
  SELECT "userId", lid, tel FROM ranked WHERE rn = 1
`;

(async () => {
  console.log(APPLY ? '=== APLICANDO ===\n' : '=== ENSAYO (no escribe nada) ===\n');

  const existentes = await db.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM chat_lid_map`);
  console.log(`chat_lid_map antes: ${existentes[0].n} filas`);

  const pares = await db.$queryRawUnsafe(SQL_PARES);
  console.log(`Pares (lid -> número) encontrados en los payloads: ${pares.length}\n`);

  console.log('Muestra:');
  for (const p of pares.slice(0, 8)) {
    console.log(`  ${p.lid}  ->  ${p.tel}`);
  }

  // Cuántas sesiones fantasma quedarían reconciliables con este mapa
  const rescate = await db.$queryRawUnsafe(`
    SELECT COUNT(*)::int n FROM "Session" s
     WHERE s."remoteJid" LIKE '%@lid'
       AND EXISTS (SELECT 1 FROM (${SQL_PARES}) m
                    WHERE m.lid = s."remoteJid" AND m."userId" = s."userId")`);
  console.log(`\nSesiones @lid que este mapa permitiría reconciliar: ${rescate[0].n}`);

  if (!APPLY) {
    console.log('\nEnsayo terminado. Nada fue modificado.');
    console.log('Para aplicar:  node scripts/backfill-lid-map.js --apply');
    await db.$disconnect();
    return;
  }

  let ok = 0;
  for (const p of pares) {
    try {
      await db.$executeRawUnsafe(
        `INSERT INTO "chat_lid_map" ("userId","lid","remoteJid","updatedAt")
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT ("userId","lid")
         DO UPDATE SET "remoteJid" = EXCLUDED."remoteJid", "updatedAt" = NOW()`,
        p.userId, p.lid, p.tel,
      );
      ok++;
    } catch (e) {
      console.error(`  fallo con ${p.lid}: ${e.message.split('\n')[0]}`);
    }
  }

  const despues = await db.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM chat_lid_map`);
  console.log(`\nEscritos: ${ok}/${pares.length}`);
  console.log(`chat_lid_map después: ${despues[0].n} filas`);
  await db.$disconnect();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
