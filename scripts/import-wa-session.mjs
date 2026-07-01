#!/usr/bin/env node
// ---------------------------------------------------------------------------
// import-wa-session.mjs
//
// Puente "navegador -> Baileys" para reconectar una cuenta de WhatsApp que
// quedó atrapada en el passkey/WebAuthn obligatorio (rollout "Shortcake").
//
// Toma el JSON que produce la extensión de marcoscarraro
// (https://github.com/marcoscarraro/whatsapp-session-extractor) desde una
// sesión de WhatsApp Web YA autenticada en un navegador real, y lo convierte
// en un directorio `useMultiFileAuthState` de Baileys (creds.json) — que es
// exactamente lo que carga BaileysSessionManager.startSession().
//
// No se vincula ningún dispositivo nuevo: Baileys entra como EL MISMO
// companion que el navegador. Por eso, tras importar, CIERRA la pestaña de
// WhatsApp Web (dos clientes sobre la misma sesión chocan).
//
// Uso:
//   node scripts/import-wa-session.mjs \
//        --session ./wa-session-XXXX.json \
//        --instance <instanceName> \
//        [--sessions-dir <dir>]   (default: $BAILEYS_SESSIONS_DIR o ./baileys-sessions)
//        [--verify]               (intenta conectar para validar; requiere red y
//                                  que la app NO tenga esa instancia activa)
//        [--force]                (sobrescribe sin preguntar; igual hace backup)
//
// El material extraído son las CLAVES PRIVADAS de identidad del número.
// Trátalo como secreto: no lo subas al repo, bórralo tras usarlo.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

// ---- CLI args -------------------------------------------------------------
function parseArgs(argv) {
  const out = { verify: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verify') out.verify = true;
    else if (a === '--force') out.force = true;
    else if (a === '--session') out.session = argv[++i];
    else if (a === '--instance') out.instance = argv[++i];
    else if (a === '--sessions-dir') out.sessionsDir = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv);

if (args.help || !args.session || !args.instance) {
  console.log(`
Uso:
  node scripts/import-wa-session.mjs --session <archivo.json> --instance <nombre> [opciones]

Requeridos:
  --session <path>     JSON exportado por la extensión whatsapp-session-extractor
  --instance <name>    instanceName de la fila en la tabla Instancia (instanceType='baileys')

Opciones:
  --sessions-dir <dir> Carpeta base de sesiones Baileys
                       (default: $BAILEYS_SESSIONS_DIR o ./baileys-sessions)
  --verify             Tras escribir, intenta conectar para confirmar (necesita red;
                       la app NO debe tener esa instancia conectada al mismo tiempo)
  --force              Sobrescribe creds.json existente sin confirmar (siempre hace backup)
`);
  process.exit(args.help ? 0 : 1);
}

const buf = (b64) => Buffer.from(String(b64), 'base64');
const die = (msg) => { console.error('❌ ' + msg); process.exit(1); };

// ---- Load & validate input JSON ------------------------------------------
if (!fs.existsSync(args.session)) die(`No existe el archivo de sesión: ${args.session}`);

let data;
try {
  data = JSON.parse(fs.readFileSync(args.session, 'utf8'));
} catch (e) {
  die(`El JSON de sesión no es válido: ${e.message}`);
}

for (const f of ['noiseCandidates', 'identityKey', 'registrationId', 'account', 'id']) {
  if (data[f] == null) die(`El JSON no tiene el campo requerido "${f}". ¿Extracción incompleta? Vuelve a ejecutar la extensión con WhatsApp Web logueado.`);
}
if (!Array.isArray(data.noiseCandidates) || data.noiseCandidates.length === 0) {
  die('No hay noiseCandidates en el JSON. La extracción falló (¿WhatsApp Web no estaba logueado?).');
}
if (!data.advSecretKey) {
  die('advSecretKey (recoveryToken) ausente en el JSON. Sin él no se puede autenticar; repite la extracción.');
}

// ---- Dynamic imports (Baileys es ESM) ------------------------------------
const baileys = await import('@whiskeysockets/baileys');
const { initAuthCreds, BufferJSON, signedKeyPair, Curve } = baileys;
const makeWASocket = baileys.default;
const c25519mod = await import('curve25519-js');
const c25519 = c25519mod.default ?? c25519mod;

// ---- 1) Elegir el keypair Noise correcto (determinista, offline) ----------
// La extensión entrega varios candidatos (combinaciones de IV que descifran a
// 32 bytes). El válido es aquel cuya privada deriva exactamente su pública.
let noiseKey = null;
for (const cand of data.noiseCandidates) {
  try {
    const priv = buf(cand.private);
    const pub = buf(cand.public);
    if (priv.length !== 32 || pub.length !== 32) continue;
    const derivedPub = Buffer.from(c25519.generateKeyPair(new Uint8Array(priv)).public);
    if (derivedPub.equals(pub)) { noiseKey = { private: priv, public: pub }; break; }
  } catch { /* candidato inválido */ }
}
if (!noiseKey) {
  die(`Ninguno de los ${data.noiseCandidates.length} candidatos Noise valida priv→pub. ` +
      `El JSON está corrupto o la versión de WhatsApp Web cambió el cifrado; repite la extracción.`);
}
console.log(`✔ Noise keypair elegido (de ${data.noiseCandidates.length} candidato(s)).`);

// ---- 2) Identidad Signal estática ----------------------------------------
if (!data.identityKey.private || !data.identityKey.public) die('identityKey incompleta en el JSON.');
const signedIdentityKey = {
  private: buf(data.identityKey.private),
  public: buf(data.identityKey.public),
};
if (signedIdentityKey.private.length !== 32 || signedIdentityKey.public.length !== 32) {
  die('identityKey no mide 32 bytes tras decodificar. JSON corrupto.');
}

// ---- 3) JID del companion (device index importa) --------------------------
// me.id debe ser <phone>:<device>@s.whatsapp.net (no el JID pelado).
// El índice de dispositivo viene en WALid (<lidUser>:<device>@lid).
const userPart = String(data.id).split('@')[0].split(':')[0].replace(/\D/g, '');
if (!userPart) die(`No se pudo extraer el número desde id="${data.id}".`);

const lidStr = data.lid ? String(data.lid) : '';
let device = null;
let mm = lidStr.match(/:(\d+)@/);
if (mm) device = mm[1];
if (device == null) { mm = String(data.id).match(/:(\d+)@/); if (mm) device = mm[1]; }
if (device == null) {
  console.warn('⚠ No se encontró índice de dispositivo en lid/id; usando device=0. ' +
               'Si la conexión falla con "conflict", edita creds.me.id con el índice correcto.');
  device = '0';
}
const meId = `${userPart}:${device}@s.whatsapp.net`;
const meLid = lidStr
  ? (lidStr.includes('@') ? lidStr : `${lidStr}@lid`)
  : undefined;
console.log(`✔ Companion JID: ${meId}${meLid ? '  (lid: ' + meLid + ')' : ''}`);

// ---- 4) Construir creds sobre initAuthCreds() -----------------------------
const creds = initAuthCreds();
creds.noiseKey = noiseKey;
creds.signedIdentityKey = signedIdentityKey;
// signedPreKey: regeneramos y RE-FIRMAMOS con la identidad real extraída,
// para que verifique contra la pública de identidad de este número.
creds.signedPreKey = signedKeyPair(signedIdentityKey, creds.signedPreKey.keyId);
creds.registrationId = Number(data.registrationId);
creds.advSecretKey = data.advSecretKey; // base64 string (recoveryToken)
creds.account = {
  details: buf(data.account.details),
  accountSignatureKey: buf(data.account.accountSignatureKey),
  accountSignature: buf(data.account.accountSignature),
  deviceSignature: buf(data.account.deviceSignature),
};
creds.me = { id: meId, lid: meLid, name: '~' };
creds.platform = data.platform || 'android';
creds.registered = true;

// ---- 5) Sanity checks locales antes de escribir ---------------------------
if (!Curve.verify(signedIdentityKey.public, creds.signedPreKey.keyPair.public, creds.signedPreKey.signature)) {
  die('La firma del signedPreKey no verifica contra la identidad extraída. Aborto.');
}
if (!Number.isFinite(creds.registrationId)) die(`registrationId inválido: ${data.registrationId}`);
console.log('✔ Sanity checks OK (firma signedPreKey verifica).');

// ---- 6) Escribir el directorio useMultiFileAuthState ----------------------
const sessionsDir = args.sessionsDir
  || process.env.BAILEYS_SESSIONS_DIR
  || path.join(process.cwd(), 'baileys-sessions');
const dir = path.join(sessionsDir, args.instance);
fs.mkdirSync(dir, { recursive: true });

const credsPath = path.join(dir, 'creds.json');
if (fs.existsSync(credsPath)) {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const backup = path.join(dir, `creds.backup-${stamp}.json`);
  fs.copyFileSync(credsPath, backup);
  console.log(`✔ Backup del creds.json previo → ${backup}`);
  if (!args.force) {
    console.log('  (se sobrescribe el creds.json existente; el backup queda por si acaso)');
  }
}

fs.writeFileSync(credsPath, JSON.stringify(creds, BufferJSON.replacer, 2));
console.log(`✔ Escrito: ${credsPath}`);
console.log(`\n📁 Sesión importada para la instancia "${args.instance}".`);

// ---- 7) Verificación opcional (conexión real) -----------------------------
if (args.verify) {
  console.log('\n🔌 --verify: intentando conectar para validar (Ctrl+C para abortar)...');
  console.log('   Asegúrate de que la app NO tenga esta instancia activa y de haber CERRADO WhatsApp Web.');
  const { state, saveCreds } = await baileys.useMultiFileAuthState(dir);
  const { version } = await baileys.fetchLatestBaileysVersion();
  const silent = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return silent; } };
  const sock = makeWASocket({ version, auth: state, logger: silent, browser: ['Verzay-IA', 'Chrome', '1.0.0'] });
  sock.ev.on('creds.update', saveCreds);

  const done = (code, msg) => { console.log(msg); try { sock.end(); } catch {} process.exit(code); };
  const timeout = setTimeout(() => done(1, '⏱️  Sin resultado en 40s. Revisa red / conflicto de sesión.'), 40000);

  sock.ev.on('connection.update', (u) => {
    if (u.connection === 'open') {
      clearTimeout(timeout);
      done(0, `✅ CONECTADO como ${sock.user?.id || meId}. La importación funcionó.\n   Ahora cierra la pestaña de WhatsApp Web y arranca/reinicia la instancia en tu app.`);
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      // 515 (restartRequired) tras un login válido es NORMAL en Baileys.
      if (code === 515) {
        clearTimeout(timeout);
        done(0, '✅ Login válido (código 515 = restart required, es normal).\n   Cierra WhatsApp Web y arranca/reinicia la instancia en tu app.');
        return;
      }
      clearTimeout(timeout);
      done(1, `❌ Conexión cerrada (statusCode=${code ?? '?'}). ` +
              (code === 401 || code === 403
                ? 'Credenciales rechazadas: revisa device index o repite la extracción.'
                : 'Puede ser conflicto con WhatsApp Web abierto u otra sesión activa.'));
    }
  });
} else {
  console.log(`\n👉 Siguiente paso:
   1) CIERRA la pestaña de WhatsApp Web en el navegador (evita conflicto de sesión).
   2) Arranca/reinicia la instancia:
        POST /whatsapp/baileys/start/${args.instance}   (o reinicia el contenedor)
   3) Verifica estado:
        GET  /whatsapp/baileys/status/${args.instance}
   (Opcional) Vuelve a correr con --verify para probar la conexión desde aquí.`);
}
