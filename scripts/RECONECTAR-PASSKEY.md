# Reconectar WhatsApp bloqueado por passkey (rollout "Shortcake")

## Qué problema resuelve

WhatsApp empezó a exigir **passkey (WebAuthn)** para vincular dispositivos nuevos
en ciertas cuentas (sobre todo **Business** y cuentas ligadas a Meta Business).
Cuando escaneas el QR o metes el código de teléfono, el servidor pide una
ceremonia WebAuthn que **Baileys no sabe responder** → se queda "esperando el
teléfono" y regenera QR. **No hay flag ni versión de Baileys/Evolution que lo
arregle**: la librería no habla WebAuthn.

Referencias:
- Evolution: https://github.com/evolution-foundation/evolution-api/issues/2618
- Baileys (receta original de @familymachlin-git): https://github.com/WhiskeySockets/Baileys/issues/2672
- Extensión de extracción (@marcoscarraro): https://github.com/marcoscarraro/whatsapp-session-extractor

## La idea

En vez de **vincular un dispositivo nuevo** (que traba en el passkey):

1. Dejas que un **navegador real** (Chrome) complete el login en `web.whatsapp.com`
   **con el passkey** — el navegador SÍ sabe hacer WebAuthn.
2. **Extraes las claves** de esa sesión ya autenticada (extensión de marcoscarraro).
3. Un **conversor** (`import-wa-session.mjs`) las transforma en un directorio
   `useMultiFileAuthState` de Baileys — que es justo lo que carga
   `BaileysSessionManager.startSession()`.
4. Reinicias la instancia → Baileys entra como **el mismo companion** del navegador.

No se vincula nada nuevo (no gastas slot de dispositivo, no chocas con el
rate-limit "intenta más tarde"). Como Baileys pasa a ser el mismo companion,
**después de importar hay que CERRAR la pestaña de WhatsApp Web** (dos clientes en
la misma sesión chocan).

> ⚠️ **Requisito imprescindible:** el navegador tiene que completar el login y
> mostrar tus chats. Si `web.whatsapp.com` solo pide "llave de seguridad USB" y
> nunca entra (pasa en algunas cuentas Business), este método NO es posible; ahí
> la única salida es borrar la cuenta Business y re-registrar el número en
> WhatsApp Messenger (app personal) — pierdes grupos e historial.

---

## Paso a paso

### 1. Loguear WhatsApp Web en Chrome (máquina de escritorio)

Abre `https://web.whatsapp.com`, completa el passkey y **espera a ver tus chats**.
Deja la pestaña abierta (aún no la cierres).

### 2. Instalar la extensión y extraer la sesión

1. Descarga/clona https://github.com/marcoscarraro/whatsapp-session-extractor
2. `chrome://extensions` → activa **Modo desarrollador** → **Cargar sin empaquetar**
   → selecciona la carpeta del repo.
3. Con la pestaña de WhatsApp Web activa, clic en el ícono 🔐 → **Extraer sesión**.
4. Se descarga `wa-session-AAAAMMDD-HHMMSS.json`.

> 🔒 Ese archivo contiene las **claves privadas** de tu número. Trátalo como una
> contraseña: no lo subas al repo, bórralo al terminar.

### 3. Convertir e importar a la sesión Baileys

Corre el conversor **donde vive tu backend** (el servidor/contenedor donde está la
carpeta `baileys-sessions/`, que es `BAILEYS_SESSIONS_DIR`):

```bash
# desde api-webhook/
node scripts/import-wa-session.mjs \
  --session /ruta/wa-session-XXXX.json \
  --instance <instanceName>            # el mismo de la tabla Instancia (instanceType='baileys')

# o vía npm:
npm run wa:import-session -- --session /ruta/wa-session-XXXX.json --instance <instanceName>
```

Opciones:
- `--sessions-dir <dir>`: carpeta base de sesiones (default: `$BAILEYS_SESSIONS_DIR`
  o `./baileys-sessions`). Úsala si el script no corre desde el mismo cwd que la app.
- `--verify`: tras escribir, intenta conectar para confirmar (necesita red y que la
  app **no** tenga esa instancia activa; ver nota abajo).
- `--force`: sobrescribe sin preguntar (igual deja backup del `creds.json` previo).

El conversor:
- Elige el keypair Noise correcto de forma determinista (valida priv→pub, sin red).
- Reconstruye `signedPreKey` y lo **re-firma** con tu identidad real.
- Arma `me.id` como `<phone>:<device>@s.whatsapp.net` (el índice de dispositivo sale
  del `lid`).
- Escribe `creds.json` en el formato BufferJSON de Baileys, con **backup** del anterior.

### 4. Reconectar la instancia

1. **Cierra la pestaña de WhatsApp Web** en el navegador (evita conflicto).
2. Arranca/reinicia la instancia:
   ```
   POST /whatsapp/baileys/start/<instanceName>
   Header: x-internal-secret: <CRM_FOLLOW_UP_RUNNER_KEY>
   ```
   (o reinicia el contenedor del backend — al arrancar, `onModuleInit` levanta todas
   las instancias `baileys`).
3. Verifica:
   ```
   GET /whatsapp/baileys/status/<instanceName>   →  { "connected": true, ... }
   ```

---

## Verificación opcional desde el script (`--verify`)

`--verify` abre un socket temporal con las credenciales importadas y reporta:
- `✅ CONECTADO` o `código 515 (restart required)` → **éxito** (login válido).
- `statusCode 401/403` → credenciales rechazadas (revisa índice de dispositivo o
  repite la extracción).
- cierre por conflicto → probablemente WhatsApp Web sigue abierto u otra sesión
  activa de esa instancia.

**Importante:** córrelo con la pestaña de WhatsApp Web cerrada y con la instancia
**detenida en la app** (`DELETE /whatsapp/baileys/stop/<instanceName>`), si no, dos
sockets sobre la misma sesión chocan.

---

## Notas / límites

- El `creds.json` basta para **conectar** (identidad + noise + signed prekey). Las
  prekeys de este device ya están en el servidor de WhatsApp (las subió el navegador
  al vincular); Baileys reconstruye el key-store conforme llegan mensajes.
- Fija/actualiza la versión de WhatsApp Web si en el futuro cambia el cifrado de la
  extracción (el `_meta.waWebVersion` del JSON te dice con cuál se extrajo).
- Si el navegador **no** completa el login (solo llave USB), este método no aplica:
  usa el reset a WhatsApp Messenger personal (pierdes grupos/historial).
