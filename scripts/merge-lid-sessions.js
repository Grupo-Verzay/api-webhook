/**
 * Fusiona una sesion fantasma creada bajo @lid con la sesion real del mismo
 * contacto (la que va bajo su numero), cuando AMBAS existen en la misma linea.
 *
 * ORIGEN: el webhook aprendia el par @lid->numero leyendo `key.senderLid`, un
 * campo que Evolution no envia. `chat_lid_map` quedaba vacia y cada evento
 * dirigido solo por @lid creaba una sesion nueva: el lead se reasignaba a otro
 * asesor, se re-disparaban sus automatizaciones y el contacto aparecia
 * duplicado con el @lid como nombre.
 *
 * SEGURIDAD. 10 tablas cuelgan de Session con ON DELETE CASCADE (citas,
 * registros, tareas, notas, etiquetas, seguimientos...). Por eso el orden es
 * SIEMPRE: primero se repuntan los hijos a la sesion real, y solo cuando la
 * fantasma ya no tiene nada colgando se elimina. Cada contacto va en su propia
 * transaccion: si algo falla, esa fusion se deshace entera y las demas siguen.
 * Nunca se toca la sesion real salvo para rellenarle campos que tenia vacios.
 *
 * Requisito: `chat_lid_map` poblada (scripts/backfill-lid-map.js --apply).
 *
 *   node scripts/merge-lid-sessions.js           -> ensayo (no escribe)
 *   node scripts/merge-lid-sessions.js --apply   -> aplica
 */
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const APPLY = process.argv.includes('--apply');

// Tablas hijas sin unicos que incluyan sessionId: repuntar es un UPDATE directo.
const HIJOS = [
  ['Appointment', 'sessionId'],
  ['AssignmentLog', 'sessionId'],
  ['OperatorBridge', 'client_session_id'],
  ['Registro', 'sessionId'],
  ['finance_contacts', 'sessionId'],
  ['finance_transactions', 'sessionId'],
  ['internal_notes', 'sessionId'],
  ['tasks', 'sessionId'],
];

// Tablas con indice UNICO que incluye sessionId: si la sesion real ya tiene la
// fila equivalente, la de la fantasma NO puede moverse (chocaria) y se
// descarta. Comprobado contra pg_indexes, no solo pg_constraint: varios de
// estos unicos son indices y no restricciones, y por eso no aparecian antes.
//   [tabla, columna de sesion, columnas que completan el unico]
const HIJOS_UNICOS = [
  ['SessionTag', 'sessionId', ['tagId']],
  ['SessionTrigger', 'sessionId', []],
  ['SessionWorkflowState', 'sessionId', ['workflowId']],
  ['crm_follow_ups', 'sessionId', ['rule_key', 'source_hash']],
  ['lead_status_workflow_execution', 'sessionId', ['leadStatus']],
];

const esNombreBasura = (n) => {
  const s = (n || '').trim().toLowerCase();
  return !s || s === 'desconocido' || s === 'voce' || s === 'você' || /^\d+$/.test(s);
};

(async () => {
  console.log(APPLY ? '=== APLICANDO ===\n' : '=== ENSAYO (no escribe nada) ===\n');

  const pares = await db.$queryRawUnsafe(`
    SELECT s.id, s."remoteJid" lid, s."pushName" name_lid,
           s.assigned_advisor_id adv_lid, s.custom_name cn_lid,
           r.id id_real, r."remoteJid" tel, r."pushName" name_real,
           r.assigned_advisor_id adv_real, r.custom_name cn_real
      FROM "Session" s
      JOIN chat_lid_map m ON m.lid = s."remoteJid" AND m."userId" = s."userId"
      JOIN "Session" r
        ON r."userId" = s."userId" AND r."instanceId" = s."instanceId"
       AND r."remoteJid" = m."remoteJid"
     WHERE s."remoteJid" LIKE '%@lid'
     ORDER BY s.id`);

  console.log(`Fusiones a realizar: ${pares.length}\n`);

  if (!APPLY) {
    for (const p of pares) {
      const hijos = [];
      for (const [tabla, col] of HIJOS.concat(
        HIJOS_UNICOS.map(([t, c]) => [t, c]),
      )) {
        try {
          const r = await db.$queryRawUnsafe(
            `SELECT COUNT(*)::int n FROM "${tabla}" WHERE "${col}" = $1`, p.id);
          if (r[0].n > 0) hijos.push(`${tabla}:${r[0].n}`);
        } catch { /* tabla ausente: se ignora */ }
      }
      console.log(`  ${p.lid} -> ${p.id_real} (${p.tel})`);
      console.log(`     movera: ${hijos.join(' ') || 'nada'}`);
    }
    console.log('\n--- ENSAYO: nada modificado. ---');
    console.log('Para aplicar:  node scripts/merge-lid-sessions.js --apply');
    await db.$disconnect();
    return;
  }

  let hechas = 0;
  let movidas = 0;
  for (const p of pares) {
    const detalle = [];
    try {
      await db.$transaction(async (tx) => {
        for (const [tabla, col] of HIJOS) {
          const n = await tx.$executeRawUnsafe(
            `UPDATE "${tabla}" SET "${col}" = $1 WHERE "${col}" = $2`, p.id_real, p.id);
          if (n > 0) { detalle.push(`${tabla}:${n}`); movidas += n; }
        }

        // Tablas con unico sobre sessionId: se mueve solo lo que no choque y se
        // descarta el resto (la sesion real ya tiene su equivalente).
        for (const [tabla, col, extra] of HIJOS_UNICOS) {
          const cond = extra.length
            ? extra.map((c) => `x."${c}" = t."${c}"`).join(' AND ')
            : 'TRUE';
          const n = await tx.$executeRawUnsafe(
            `UPDATE "${tabla}" t SET "${col}" = $1
              WHERE t."${col}" = $2
                AND NOT EXISTS (SELECT 1 FROM "${tabla}" x
                                 WHERE x."${col}" = $1 AND ${cond})`,
            p.id_real, p.id);
          if (n > 0) { detalle.push(`${tabla}:${n}`); movidas += n; }
          const sobra = await tx.$executeRawUnsafe(
            `DELETE FROM "${tabla}" WHERE "${col}" = $1`, p.id);
          if (sobra > 0) detalle.push(`${tabla}~${sobra}dup`);
        }

        // La sesion real solo hereda lo que ella tenga vacio.
        const sets = [];
        const vals = [];
        if (!p.adv_real && p.adv_lid) { vals.push(p.adv_lid); sets.push(`assigned_advisor_id = $${vals.length}`); }
        if (esNombreBasura(p.name_real) && !esNombreBasura(p.name_lid)) {
          vals.push(p.name_lid); sets.push(`"pushName" = $${vals.length}`);
        }
        if (!p.cn_real && p.cn_lid) { vals.push(p.cn_lid); sets.push(`custom_name = $${vals.length}`); }
        if (sets.length) {
          vals.push(p.id_real);
          await tx.$executeRawUnsafe(
            `UPDATE "Session" SET ${sets.join(', ')}, "updatedAt" = NOW() WHERE id = $${vals.length}`,
            ...vals);
          detalle.push(`real<-${sets.length}campo(s)`);
        }

        // Comprobacion final: la fantasma no debe conservar nada colgando.
        for (const [tabla, col] of HIJOS.concat(
          HIJOS_UNICOS.map(([t, c]) => [t, c]),
        )) {
          const r = await tx.$queryRawUnsafe(
            `SELECT COUNT(*)::int n FROM "${tabla}" WHERE "${col}" = $1`, p.id);
          if (r[0].n > 0) throw new Error(`${tabla} aun tiene ${r[0].n} filas: se aborta`);
        }

        await tx.$executeRawUnsafe(`DELETE FROM "Session" WHERE id = $1`, p.id);
      }, { timeout: 30000, maxWait: 15000 });
      hechas++;
      console.log(`  OK ${p.lid} -> ${p.id_real}  ${detalle.join(' ') || '(sin datos)'}`);
    } catch (e) {
      // Los errores de Prisma empiezan con lineas en blanco: mostramos las
      // ultimas lineas con contenido, que son las que dicen que paso.
      const detalleErr = String(e.message || e)
        .split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
      console.error(`  FALLO ${p.lid}: ${detalleErr || '(sin mensaje)'}`);
    }
  }

  console.log(`\nFusionadas: ${hechas}/${pares.length}   filas movidas: ${movidas}`);
  const quedan = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::int n FROM "Session" WHERE "remoteJid" LIKE '%@lid'`);
  console.log(`Sesiones que siguen bajo @lid: ${quedan[0].n}`);
  await db.$disconnect();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
