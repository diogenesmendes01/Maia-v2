# WhatsApp Setup — Pairing (QR + Code + HTTP + Auto-Recovery) — Design

**Date:** 2026-04-30
**Status:** Approved (in brainstorm), pending spec review and user review.
**Scope:** New sub-project outside the original B-axis (sub-A, B0, B1, B2, B3a, B3b, B4 all merged or in flight). Replaces the current SSH-dependent QR-on-stdout flow.
**Depends on:** existing Fastify server in `src/server.ts`; existing `BAILEYS_AUTH_DIR` and Baileys 6.7 (`socket.requestPairingCode` confirmed at `node_modules/@whiskeysockets/baileys/lib/Socket/socket.d.ts:38`); existing `ALERT_CHANNELS` config for token-rotation alerts.

---

## 1. Purpose

Replace the current pairing flow (QR-only on stdout, SSH-required to read, manual `rm -rf .baileys-auth/` on `LoggedOut`) with an HTTP-accessible flow that:

- Supports **both** QR code AND 8-digit pairing code (Baileys' `requestPairingCode`).
- Exposes a `/setup` endpoint guarded by a bootstrap token kept in a file (operator copies the token once via SSH).
- Auto-recovers on `LoggedOut`: process detects, deletes the auth dir, rotates token, restarts Baileys, alerts the operator via existing `ALERT_CHANNELS`.
- Provides live status visibility ("aguardando leitura do QR", "código gerado, aguardando confirmação", "conectado").
- Polishes the operator UX: copy button on the code, auto-redirect to `/dashboard` when paired, friendly error pages, security headers.

This is operational/infrastructure work, not user-facing — but it eliminates the most painful operational gap in the system.

## 2. Goals

- Owner pareia a Maia pelo browser. SSH só é necessário **uma vez** para copiar o bootstrap token.
- Cold-pair (primeira vez) e re-pair (após `LoggedOut`) usam o mesmo fluxo.
- Suporte simétrico a QR e código de 8 dígitos.
- Recovery automático em LoggedOut: zero SSH no caminho normal de re-pair.
- Token rotaciona automaticamente após cada pair bem-sucedido (defesa em profundidade).
- Pareamento concorrente (duas requisições disparando recovery, dois `requestPairingCode` simultâneos) é seguro via lock interno.
- Auditoria forte (8 novas audit actions cobrem todo o ciclo).

## 3. Non-goals

- **Setup wizard via WhatsApp** — chicken-and-egg (sem pareamento, sem WhatsApp).
- **Browser-based QR scanner** — operador escaneia o QR com o celular do número da Maia, igual hoje.
- **Multi-tenant pairing** — uma Maia por processo.
- **Custom 8-digit pairing code** chosen by owner — `requestPairingCode` aceita custom, mas geração automática é suficiente.
- **IP whitelist / VPN-only access** — token é o auth model. Camadas extras vão na frente (nginx/cloudflare) se desejado.
- **Magic-link via SMS / outro canal alternativo** — `ALERT_CHANNELS` (email/telegram) já cobre alertas operacionais.
- **`tts-1-hd` / outras formas de notificação rica** — apenas texto.
- **Token rotation calendarizada** (rotacionar a cada N dias mesmo sem re-pair) — só rotaciona em pair / re-pair / explicit operator action.
- **Múltiplos tokens simultâneos** — sempre exatamente um token ativo.

## 4. Architecture

### 4.1 New module — `src/setup/`

```
src/setup/
  index.ts        # Fastify route registrar — mounted always (no flag gate)
  state.ts        # In-memory state machine (singleton)
  token.ts        # Bootstrap token: ensureToken / rotateToken / verifyToken (timing-safe)
  templates.ts    # HTML templates (Tailwind via CDN)
  qr-png.ts       # Convert Baileys QR string → PNG buffer (qrcode dep)
```

~250-300 lines total. New `qrcode@^1.5` dep (pure-JS, ~30KB minified, no native bindings).

### 4.2 State machine (`src/setup/state.ts`)

```typescript
type SetupPhase =
  | { phase: 'unpaired' }
  | { phase: 'pairing_qr'; qr: string | null }      // qr=null while waiting Baileys emit
  | { phase: 'pairing_code'; code: string; expiresAt: Date }
  | { phase: 'connected'; connectedAt: Date }
  | { phase: 'disconnected_transient'; since: Date }
  | { phase: 'recovering'; since: Date };

// Pairing code lifetime per Baileys: ~180s. We expose this via PAIRING_CODE_TTL_MS.
export const PAIRING_CODE_TTL_MS = 180 * 1000;
```

**Singleton** in `setupState.ts` exposes:

- `current(): SetupPhase` — cheap accessor; also performs lazy `pairing_code` TTL expiry check on each read (no separate timer needed).
- `setQr(qr: string)` — called by Baileys QR callback. **Auto-transitions** `unpaired → pairing_qr` and `disconnected_transient → pairing_qr` (Baileys emits QR on cold start before operator clicks anything; and again on the 5s reconnect path when re-pair is needed). On `pairing_qr` already, just updates `qr`. On `connected`/`recovering`/`pairing_code`, ignored with warn log.
- `setCode(code: string)` — called when `triggerPairingCode` succeeds; sets `expiresAt = Date.now() + PAIRING_CODE_TTL_MS`. Only valid from `unpaired`.
- `markPaired()` — called on Baileys `connection: 'open'`. Sets phase to `connected` with `connectedAt`.
- `markDisconnected()` — called on `connection: 'close'` with reason ≠ loggedOut. Transitions to `disconnected_transient`.
- `triggerRecovery(): Promise<void>` — called on close + loggedOut. **Idempotent via internal singleton promise** (see §4.3).

**Allowed transitions:**

```
unpaired                → pairing_qr (auto via setQr) | pairing_code (via setCode)
pairing_qr              → connected | disconnected_transient | recovering | unpaired (qr cleared on Baileys re-init)
pairing_code            → connected | disconnected_transient | recovering | unpaired (TTL expiry)
connected               → disconnected_transient | recovering
disconnected_transient  → connected | recovering | unpaired | pairing_qr (Baileys re-emits QR after 5s reconnect)
recovering              → unpaired
```

Illegal transitions throw at the boundary (defensive). Note: `setQr` from `unpaired` and `disconnected_transient` is the **auto-transition path** — the operator's "I want QR" choice is implicit (any QR emitted by Baileys means we'll display it). The chooser HTML still posts `/setup/start?method=qr` for clarity, but server-side it's a no-op when phase is already `pairing_qr`.

### 4.3 Recovery lock (concurrency)

`triggerRecovery()` uses a singleton in-flight promise:

```typescript
let recoveryPromise: Promise<void> | null = null;

export async function triggerRecovery(): Promise<void> {
  if (recoveryPromise) return recoveryPromise;   // join existing
  recoveryPromise = doRecovery().finally(() => { recoveryPromise = null; });
  return recoveryPromise;
}
```

`doRecovery()` performs (in order — note: phase flipped to `unpaired` BEFORE alert is sent so the alert body's "aguardando re-pareamento" matches what `/setup` actually shows when the operator clicks the URL):

1. Set phase = `recovering`.
2. Audit `pairing_recovery_started`.
3. `await shutdownBaileys()` (existing function in `gateway/baileys.ts`).
4. `await rm(BAILEYS_AUTH_DIR, { recursive: true, force: true })`.
5. `await rotateToken()` — generates new token, writes file, returns it. (The token is NOT included in the alert body — see §4.6.)
6. Set phase = `unpaired`.
7. Send alert via `ALERT_CHANNELS` (see §4.6 for body). Best-effort: missing SMTP/Telegram credentials no-op silently per `src/lib/alerts.ts`.
8. Audit `pairing_recovery_completed`.
9. `await startBaileys()` (existing) — kicks off new pairing flow.

Two concurrent `LoggedOut` events (rare but possible if Baileys emits twice) join the same promise → only one cleanup.

### 4.4 Bootstrap token (`src/setup/token.ts`)

```typescript
const TOKEN_FILE = join(config.BAILEYS_AUTH_DIR, 'setup-token.txt');

export async function ensureToken(): Promise<string> {
  if (config.SETUP_TOKEN_OVERRIDE) return config.SETUP_TOKEN_OVERRIDE;
  try {
    return (await readFile(TOKEN_FILE, 'utf-8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const token = randomBytes(16).toString('hex');                 // 32 hex chars
    await mkdir(dirname(TOKEN_FILE), { recursive: true });
    // Atomic create: { flag: 'wx' } fails with EEXIST if another writer
    // raced ahead. On EEXIST we re-read and return their token (last
    // successful writer wins, no truncation race).
    try {
      await writeFile(TOKEN_FILE, token + '\n', { mode: 0o600, flag: 'wx' });
      await audit({ acao: 'setup_token_rotated', metadata: { reason: 'cold_start' } });
      return token;
    } catch (writeErr) {
      if ((writeErr as NodeJS.ErrnoException).code === 'EEXIST') {
        return (await readFile(TOKEN_FILE, 'utf-8')).trim();
      }
      throw writeErr;
    }
  }
}

export async function rotateToken(): Promise<string> {
  // Single-process guarantee for rotation (the recoveryPromise lock at §4.3
  // serialises calls). Concurrent ensureToken racing the unlink is harmless
  // because ensureToken's `flag: 'wx'` makes the create atomic.
  await unlink(TOKEN_FILE).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  });
  const token = await ensureToken();
  await audit({ acao: 'setup_token_rotated', metadata: { reason: 'recovery_or_pair' } });
  return token;
}

export function verifyToken(presented: string, actual: string): boolean {
  if (presented.length !== actual.length) return false;            // short-circuit safe
  return timingSafeEqual(Buffer.from(presented), Buffer.from(actual));
}
```

File mode `0o600` keeps it readable only by the process owner.

`SETUP_TOKEN_OVERRIDE` env var (optional) bypasses file. For dev / scripted deploys; documented as discouraged in prod.

### 4.5 HTTP routes (`src/setup/index.ts`)

Mounted **always** in `src/server.ts` (no feature flag — pareamento é fundamental). All responses include security headers:

```
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

#### `GET /setup?token=X`

Token verify; mismatch → 403 plain text + audit `setup_unauthorized_access` (no token in audit metadata, just truncated `req.ip` + `user-agent` header).

Branch on `setupState.current()`:

| Phase | Response |
|---|---|
| `unpaired` | 200 + chooser HTML (2 buttons: QR / Código de 8 dígitos) |
| `pairing_qr` with `qr=null` | 200 + "Gerando QR..." page, polls `/setup/status` |
| `pairing_qr` with `qr=string` | 200 + `<img src="/setup/qr.png?token=X">` + status pane + polling JS |
| `pairing_code` | 200 + `<div class="text-6xl tracking-widest">{code formatted}</div>` + Copy button + countdown timer "Válido por mm:ss" + status pane |
| `connected` | **410** + friendly HTML: "✅ Maia já está pareada. Status: conectado desde {timestamp}. Para re-parear..." + link to `/setup/done` (always present) and to `/dashboard` (only if `FEATURE_DASHBOARD=true`) |
| `disconnected_transient` | 503 + "Reconectando... costuma levar 5-10s" + auto-refresh meta tag (5s) |
| `recovering` | 503 + "Limpando sessão antiga (~3s). Verifique seu canal de alertas para o novo token." + auto-refresh (5s) |

#### `GET /setup/qr.png?token=X`

Token verify. If `phase === 'pairing_qr'` and `qr` is set, return PNG buffer (Content-Type: `image/png`) generated via `qrcode.toBuffer(qr, { errorCorrectionLevel: 'M', width: 320 })`. Otherwise 404.

#### `POST /setup/start?token=X`

Body JSON: `{ method: 'qr' | 'code' }`. Token verify.

- `method === 'qr'`: server-side no-op when phase is already `pairing_qr` (Baileys auto-transitions on QR emit per §4.2). When phase is `unpaired`, also no-op — the next QR Baileys emits will auto-transition. Returns 200 JSON `{ ok: true, phase: <current> }`. If phase is `pairing_code`/`connected`/`recovering`/`disconnected_transient`, return 409 with current phase.
- `method === 'code'`: if phase is `unpaired`, call `triggerPairingCode(config.WHATSAPP_NUMBER_MAIA)`. On success, `setupState.setCode(code)` and audit `pairing_code_requested`. Return 200 JSON `{ ok: true, phase: 'pairing_code' }`. If `triggerPairingCode` throws because socket isn't ready yet (boot order: `startServer()` runs before `startBaileys()`, so the socket may be null for ~1-3s on cold boot), return 503 `{ ok: false, retry_after_s: 2 }`. **Client polling JS MUST honour `retry_after_s`** — schedule a setTimeout retry with that delay before re-POSTing.

#### `GET /setup/status?token=X`

Token verify. Returns JSON `{ phase: ..., qr: 'available'|'pending'|null, expiresAt?: ISO8601 }` (note: never the raw QR string in JSON — only metadata; the QR is delivered via PNG endpoint). Used by client-side polling. Cache headers ensure no stale state.

### 4.6 Alert body on token rotation

Sent via `ALERT_CHANNELS` (existing email/telegram config). The body **never includes the token**:

```
Subject: Maia desconectada — re-pareamento necessário

A sessão WhatsApp da Maia foi derrubada (LoggedOut). Limpamos a sessão
antiga e geramos um novo bootstrap token automaticamente.

Para re-parear:
  1. SSH na VPS e leia o token novo:
     cat ~/maia/.baileys-auth/setup-token.txt
  2. Abra no browser: https://maia.example.com/setup
  3. Cole o token na URL: ?token=<TOKEN>
  4. Escolha QR ou código de 8 dígitos.

Status atual: aguardando re-pareamento.
Token anterior está revogado.
```

Same body for cold-start (slight wording change on opener) so operator gets a notification on first deploy too.

### 4.7 Baileys integration (modify `src/gateway/baileys.ts`)

Three small surgery points:

**(a) QR emission.** Replace `if (qr) qrcodeTerminal.generate(qr, { small: true });` with:

```typescript
if (qr) {
  const phaseBefore = setupState.current().phase;
  setupState.setQr(qr);
  // Audit only on first QR after a phase change. Baileys refreshes the QR
  // every ~20s during pairing — we don't audit each refresh, only the
  // initial display.
  if (phaseBefore !== 'pairing_qr') {
    await audit({ acao: 'pairing_qr_displayed', metadata: {} });
  }
  qrcodeTerminal.generate(qr, { small: true });    // keep stdout for dev/log spelunking
}
```

**(b) Connection open.** Add `setupState.markPaired()` AND `await audit({ acao: 'pairing_completed' })` after the existing `connected = true; logger.info('baileys.connected'); audit({ acao: 'whatsapp_connected' });`. Both audits fire — `whatsapp_connected` is the existing connection-life event; `pairing_completed` is the new pair-event audit (one-shot per successful pair).

**(c) Connection close.** Replace the existing logout handling:

```typescript
} else if (conn === 'close') {
  connected = false;
  lastDisconnectAt = new Date();
  const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
  logger.warn({ reason }, 'baileys.connection_closed');
  await audit({ acao: 'whatsapp_disconnected', metadata: { reason } });
  if (reason === DisconnectReason.loggedOut) {
    await audit({ acao: 'pairing_logged_out', metadata: { reason } });
    setupState.triggerRecovery().catch((err) => {
      logger.error({ err }, 'setup.recovery_failed');
    });
  } else {
    setupState.markDisconnected();
    setTimeout(() => {
      startBaileys().catch((e) => logger.error({ err: e }, 'baileys.reconnect_failed'));
    }, 5000);
  }
}
```

**(d) New export `triggerPairingCode`:**

```typescript
export async function triggerPairingCode(phone: string): Promise<string> {
  // requestPairingCode is meant to work BEFORE pairing — connected=false is
  // the expected state when a code is requested. We only block if the socket
  // itself doesn't exist yet (boot race: startServer() runs before
  // startBaileys()). Caller (POST /setup/start?method=code) translates this
  // throw into a 503 with retry_after_s so the operator's browser retries.
  if (!socket) throw new Error('baileys_socket_not_ready');
  return socket.requestPairingCode(phone);
}
```

### 4.8 Boot integration (`src/index.ts`)

```typescript
async function main() {
  logger.info({ env: config.NODE_ENV, port: config.APP_PORT }, 'maia.starting');
  await audit({ acao: 'system_started' });

  await ensureRedisConnect();

  // B3b: clean up orphan PDFs
  const { sweepPdfTmp } = await import('@/lib/pdf/_sweeper.js');
  await sweepPdfTmp().catch((err) => logger.warn({ err }, 'pdf.sweeper.boot_failed'));

  // SETUP: ensure bootstrap token exists (cold-start / first deploy)
  const { ensureToken } = await import('@/setup/token.js');
  const { hasValidBaileysSession } = await import('@/setup/state.js');
  const token = await ensureToken();
  if (!await hasValidBaileysSession(config.BAILEYS_AUTH_DIR)) {
    logger.warn(
      { setup_token_path: '<BAILEYS_AUTH_DIR>/setup-token.txt' },
      'setup.bootstrap_token_ready — run `cat $BAILEYS_AUTH_DIR/setup-token.txt` and visit /setup',
    );
    // Token NOT logged in plaintext — operator must SSH and read the file.
  }

  await startServer();              // /setup endpoints registered here
  startAgentWorker(async (job) => { await runAgentForMensagem(job.data.mensagem_id); });
  startWorkers(1);
  await startBaileys();
  // ...rest
}
```

`hasValidBaileysSession` is a small helper in `setup/state.ts`: returns true if `<BAILEYS_AUTH_DIR>/creds.json` exists AND has a `me` field with a phone number.

### 4.9 Templates (`src/setup/templates.ts`)

All templates use Tailwind via CDN (`<script src="https://cdn.tailwindcss.com"></script>`). No build step; ~30KB JIT runtime. Pages share a base template:

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Maia — Pareamento</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 min-h-screen flex items-center justify-center p-4">
<div class="bg-white rounded-2xl shadow-lg max-w-md w-full p-8">
  <h1 class="text-2xl font-bold mb-6">Maia — Pareamento WhatsApp</h1>
  <!-- per-phase content -->
  <div class="status mt-6 p-3 rounded-lg bg-slate-100 text-sm text-slate-700">
    <span class="font-medium">Status atual:</span>
    <span id="status-text">{currentStatusMessage}</span>
  </div>
</div>
<script>
  // Polling: every 2s, hit /setup/status?token=<X>. On phase change, reload page.
  // On phase=connected, redirect to /dashboard after 1.5s.
</script>
</body>
</html>
```

**Per-phase content blocks:**

- **Chooser (`unpaired`):** two large buttons. "Parear com QR Code" (default focus) and "Parear com Código de 8 dígitos". Each posts `/setup/start` with the chosen method, then redirects to `/setup`.

- **QR (`pairing_qr` with qr ≠ null):** centered `<img src="/setup/qr.png?token={T}">` (320×320), instruction "Abra WhatsApp → Aparelhos conectados → Conectar aparelho".

- **QR pending (`pairing_qr` with qr === null):** spinner + "Gerando QR Code..." text.

- **Code (`pairing_code`):** big number "1 2 3 4 - 5 6 7 8" (with hyphen separator), Copy button (`navigator.clipboard.writeText(code)` + brief "Copiado!" toast), countdown "Válido por mm:ss" updated every 1s via JS, instruction "Abra WhatsApp → Aparelhos conectados → Conectar com número de telefone → digite este código". On TTL expiry, page polling detects phase change and re-renders.

- **Connected (`connected`):** "✅ Maia já está pareada. Status: conectado desde {ISO}. Para re-parear, desconecte pelo app do WhatsApp da Maia." Link `/dashboard`.

- **Disconnected (`disconnected_transient`):** "Reconectando... costuma levar 5-10s." Auto-refresh.

- **Recovering (`recovering`):** "Limpando sessão antiga (~3s). Novo token gerado. Verifique seu canal de alertas (email/telegram)."

### 4.10 Status messages (per phase)

| Phase | Status text |
|---|---|
| `unpaired` | "Aguardando você escolher o método de pareamento." |
| `pairing_qr` qr=null | "Gerando QR Code..." |
| `pairing_qr` qr=string | "Aguardando leitura do QR Code no WhatsApp." |
| `pairing_code` | "Código gerado. Aguardando confirmação no WhatsApp." |
| `connected` | "Conectado com sucesso." |
| `disconnected_transient` | "Conexão perdida temporariamente. Reconectando..." |
| `recovering` | "Limpando sessão antiga e gerando novo token..." |

## 5. Schema / migrations

**No DB migration needed.** `AUDIT_ACTIONS` (in `src/governance/audit-actions.ts`) is a TypeScript-only `as const` union — `audit_log.acao` in the DB is plain `text`, so adding 8 new strings to the TS union does not require an ALTER TABLE.

## 6. Configuration

New env vars:

- `SETUP_TOKEN_OVERRIDE` (optional). If set, used as the token instead of generating one. **Discouraged in prod** — env vars leak more easily than file mode 0o600. For dev / scripted deploys.

(The earlier draft mentioned a `SETUP_DISABLE_HTTP` flag — REMOVED to resolve the contradiction with §4.5's "mounted always" stance. If an operator wants the routes off, they should run with a separate admin proxy that routes only `/setup*` away. YAGNI for the kill-switch.)

No new feature flag for the feature itself — pareamento é fundamental, sempre disponível.

## 7. Audit-action additions

In `src/governance/audit-actions.ts`:

```typescript
'pairing_qr_displayed',
'pairing_code_requested',
'pairing_completed',
'pairing_logged_out',
'pairing_recovery_started',
'pairing_recovery_completed',
'setup_token_rotated',
'setup_unauthorized_access',
```

8 new actions. Pareamento é evento crítico de segurança — auditoria forte facilita post-mortem.

## 8. Concurrency

Three concurrency hot spots, all addressed:

- **Recovery lock**: §4.3 — singleton `recoveryPromise` joins concurrent triggers.
- **Token rotation**: `ensureToken` is idempotent (read-then-write with EEXIST handling); `rotateToken` deletes-then-recreates. Two concurrent rotates produce one final value (last writer wins); audit captures both attempts.
- **`/setup/start` race**: state machine transitions are atomic (single-threaded JS event loop); second concurrent start request sees the new phase and returns 409 idempotently.

## 9. Error handling

| Failure | Tratamento |
|---|---|
| Token mismatch on any `/setup*` route | 403 + audit `setup_unauthorized_access` (truncated req.ip + UA, no token leakage) |
| `requestPairingCode` throws (Baileys not connected to WS yet) | 503 + JSON `{ retry_after_s: 2 }`. Client retries. |
| QR PNG generation fails (`qrcode` lib bug) | Log error, fallback to stdout-style ASCII rendered as `<pre class="font-mono">` block in HTML |
| Recovery delete fails (`rm` errno) | Log critical, alert sent, state stays `recovering` (manual SSH needed). At least no fake "ready". |
| Multiple concurrent `/setup/start` requests | Atomic state transition; 2nd request returns 409 with current phase JSON |
| Token file vanished mid-operation | Next `ensureToken` regenerates; emits `setup_token_rotated` audit with reason `'unexpected_missing'` |
| Owner accidentally hits `/setup` after pairing | 410 Gone with friendly HTML — no security impact, just not the right page |
| Pairing code TTL expires | State machine transitions back to `unpaired`; client polling detects, page re-renders chooser |
| `/setup/start` race with active pairing | 409 + `{ phase, message }` — client should reload, not retry |
| Browser clipboard API unavailable | Fallback: select-all on the code element (operator can manual copy) |
| Tailwind CDN unreachable | Page still functional with browser default styles (degraded UX, not broken) |

## 10. Testing

### Unit (`tests/unit/setup-state.spec.ts` — new)

- All legal phase transitions succeed; illegal ones throw.
- `triggerRecovery` executes the 9 steps in order; doRecovery is called once even on concurrent triggers (singleton promise verified via spying).
- `setCode` sets `expiresAt = now + PAIRING_CODE_TTL_MS`.
- TTL expiry transitions `pairing_code` → `unpaired`.

### Unit (`tests/unit/setup-token.spec.ts` — new)

- `ensureToken` creates file when missing (mode 0o600 verified via fs.stat).
- `ensureToken` returns existing token when file exists (idempotent).
- `rotateToken` deletes existing + regenerates (new value).
- `verifyToken` is timing-safe: same length comparison uses `timingSafeEqual`; different lengths short-circuit to false.
- `SETUP_TOKEN_OVERRIDE` env bypasses file when set.

### Unit (`tests/unit/setup-routes.spec.ts` — new)

- 403 + audit on missing/wrong token (every route).
- Security headers on every response (`Cache-Control`, `Referrer-Policy`, `X-Content-Type-Options`).
- 200 + chooser HTML on `unpaired`.
- 200 + PNG (Content-Type: image/png, leading `\x89PNG\r\n\x1a\n` magic bytes) on `pairing_qr` with qr set.
- 404 on `/setup/qr.png` when phase is not `pairing_qr` or qr is null.
- 410 + friendly HTML on `connected`.
- 503 on `recovering` and `disconnected_transient`.
- `POST /setup/start?method=code` calls `triggerPairingCode` with `WHATSAPP_NUMBER_MAIA`; phase transitions to `pairing_code`.
- `POST /setup/start?method=qr` only transitions phase (does not call any Baileys API directly — QR comes from Baileys' callback).
- `GET /setup/status` returns expected JSON shape per phase.

### Integration (manual, on PR)

1. Cold boot, no auth dir → `setup-token.txt` created, log warning visible. `/setup` (no token) returns 403. SSH `cat` token, browser to `/setup?token=...`, click QR, scan with WhatsApp on phone of `WHATSAPP_NUMBER_MAIA` → phase becomes `connected` → page redirects to `/dashboard`.
2. Same flow with code: SSH cat, browser, click "Código", page shows 8-digit code with copy button + countdown. WhatsApp app → "conectar com número" → enter code → phase becomes connected.
3. Logout from WhatsApp app → process detects → auth dir deleted → token rotated → alert email/telegram received (without token). SSH cat new token → browser with new token → re-pair successfully.
4. Token rotation visible in audit log (`setup_token_rotated` with reason).

## 11. Out of scope (future polish)

| Item | Defer to |
|---|---|
| Setup wizard via WhatsApp (chicken-and-egg) | Not pursued |
| Multi-tenant pairing | Not pursued (single-process Maia) |
| Custom 8-digit code chosen by owner | Defer; auto-generated is fine |
| IP whitelist / VPN-only access to `/setup` | Layer in front (nginx) if desired; not in spec |
| Automatic alerts via PagerDuty / SMS | Existing `ALERT_CHANNELS` (email/telegram) is sufficient |
| Cookie-based auth for `/setup` after first GET (CSRF defense in depth) | MVP uses URL token + security headers; cookie can come later |
| Browser-based QR scanner | Operator scans with the Maia phone, same as today |
| Calendarized token rotation | Only on pair / re-pair / manual |
| `/setup` rate limiting | Not pursued (operator surface, not public) |
| Webhook notification on phase change | `ALERT_CHANNELS` handles it; webhook is an extra channel for ops integration |

## 12. Acceptance criteria

- [ ] Cold boot, no session → `setup-token.txt` created with mode 0o600. Audit `setup_token_rotated` with `reason: 'cold_start'`.
- [ ] `GET /setup?token=<correct>` on `unpaired` returns chooser HTML with QR + Code buttons.
- [ ] `GET /setup?token=<wrong>` returns 403, audit `setup_unauthorized_access` written (no token in metadata).
- [ ] All `/setup*` responses include `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` headers.
- [ ] `POST /setup/start` with `{method: 'qr'}` transitions to `pairing_qr`; `GET /setup/qr.png?token=...` returns valid PNG (verified via magic bytes).
- [ ] `POST /setup/start` with `{method: 'code'}` calls `triggerPairingCode(WHATSAPP_NUMBER_MAIA)`; transitions to `pairing_code`; the page shows the 8-digit code with copy button + countdown.
- [ ] `GET /setup/status?token=...` returns JSON `{ phase, qr?, expiresAt? }` matching current state.
- [ ] After WhatsApp scan/code → state transitions to `connected`; client polling detects; redirects to `/dashboard`.
- [ ] WhatsApp app "Disconnect" → state goes `recovering` → auth dir deleted → token rotated → alert sent via `ALERT_CHANNELS` **without token in body** → state `unpaired`.
- [ ] After recovery, `/setup?token=<old>` → 403; `/setup?token=<new>` → chooser HTML.
- [ ] `triggerRecovery()` is idempotent: two concurrent calls share the same promise; cleanup runs once.
- [ ] Pairing code TTL expiry (180s) transitions back to `unpaired` automatically.
- [ ] `npm run build` zero new errors. `npx vitest run` adds passing tests for `setup-state`, `setup-token`, `setup-routes`.
- [ ] Existing WhatsApp flows (B0/B1/B2/B3a/B3b/B4) untouched. No regressions in their tests.

## 13. Rollout / migration

**Already-paired operators.** When this code lands and the process restarts, `BAILEYS_AUTH_DIR/creds.json` already exists with a valid `me` field. `hasValidBaileysSession` returns true. `ensureToken` still runs (creates `setup-token.txt` if missing) but the warn log "bootstrap_token_ready" is **not** emitted (the gate at §4.8 only logs when `!hasValidBaileysSession`). `setupState` initialises in `connected` phase once Baileys reconnects. `/setup?token=...` returns 410 immediately. **Net behaviour:** zero operator action required for existing deploys; the new HTTP routes are silent until a `LoggedOut` event eventually triggers them.

**Fresh deploy.** No `BAILEYS_AUTH_DIR/` yet. `ensureToken` creates the dir + token file (mode 0o600). The "bootstrap_token_ready" warn log fires. Operator does the SSH-cat-once flow.

**Recovery from this branch's first LoggedOut.** Same as the steady-state recovery flow (§4.3). The very first time, the operator may notice the new alert format (without token) — clarify in the deploy notes that the token is now in `BAILEYS_AUTH_DIR/setup-token.txt`, not in the alert body.

## 14. References

- Baileys docs: `socket.requestPairingCode(phoneNumber)` — verified at `node_modules/@whiskeysockets/baileys/lib/Socket/socket.d.ts:38`.
- `qrcode@^1.5` npm — pure-JS QR generator for the PNG endpoint.
- Tailwind via CDN: `<script src="https://cdn.tailwindcss.com"></script>` — JIT runtime, no build.
- Existing Fastify server: `src/server.ts`. New routes mount alongside `/health`, `/metrics`, `/dashboard*`.
- Existing `BAILEYS_AUTH_DIR`: `src/config/env.ts:37`, default `./.baileys-auth`.
- Existing `ALERT_CHANNELS`: `src/config/env.ts:58-65` (email/telegram via `src/lib/alerts.ts`).
- Spec 04 — gateway WhatsApp (`docs/specs/04-gateway-whatsapp.md`) — current pairing flow described under "Onboarding".
