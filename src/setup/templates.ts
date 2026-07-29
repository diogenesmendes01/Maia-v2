/**
 * Páginas do `/setup` (pareamento da linha PRIMÁRIA).
 *
 * Issue #518 — o bootstrap token FOI REMOVIDO destes templates. Antes ele
 * viajava em `action="/setup/start?token=…"`, em `<img src="/setup/qr.png
 * ?token=…">` e embutido no JavaScript de polling: bastava uma screenshot, um
 * "copiar link", um access log de proxy ou o header `Referer` de qualquer
 * recurso externo para vazá-lo.
 *
 * Agora a autenticação é uma SESSÃO DE OPERADOR em cookie httpOnly +
 * sameSite=strict (`maia_setup_session`), estabelecida uma única vez pelo
 * formulário de `renderTokenGate` — que envia o token no CORPO de um POST.
 * Nenhuma URL desta superfície carrega segredo; o navegador anexa o cookie
 * sozinho em `/setup/status` e `/setup/qr.png`.
 */
const BASE_HEAD = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Maia — Pareamento</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  /* Minimal fallback if Tailwind CDN is unreachable */
  body { font: 14px/1.5 system-ui; max-width: 480px; margin: 60px auto; padding: 0 20px; }
  button { padding: 12px 20px; margin: 8px; border-radius: 8px; cursor: pointer; border: 1px solid #ccc; }
  button[value="qr"] { background: #2563eb; color: white; border-color: #2563eb; }
</style>
</head>
<body class="bg-slate-50 min-h-screen flex items-center justify-center p-4">
<div class="bg-white rounded-2xl shadow-lg max-w-md w-full p-8">
<h1 class="text-2xl font-bold mb-6">Maia — Pareamento WhatsApp</h1>`;

/**
 * O polling não carrega credencial alguma: `credentials: 'same-origin'` faz o
 * navegador anexar o cookie de sessão, e a URL fica limpa (nada em histórico,
 * em referer ou em access log).
 */
const STATUS_AND_FOOT = (statusText: string, autoRefreshSec?: number): string => `
<div class="status mt-6 p-3 rounded-lg bg-slate-100 text-sm text-slate-700">
  <span class="font-medium">Status atual:</span>
  <span id="status-text">${escapeHtml(statusText)}</span>
</div>
</div>
<script>
(function() {
  const POLL_INTERVAL_MS = 2000;
  let prevPhase = null;
  async function poll() {
    try {
      const res = await fetch('/setup/status', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      // Skip change detection on first poll — current phase is already reflected in the HTML.
      if (prevPhase && prevPhase !== data.phase) {
        if (data.phase === 'connected') {
          clearInterval(intervalId);
          document.getElementById('status-text').textContent = 'Conectado com sucesso. Redirecionando…';
          setTimeout(() => { window.location.href = '/setup/done'; }, 1500);
          return;
        }
        // Phase changed; stop polling and reload to render the new state's HTML.
        clearInterval(intervalId);
        window.location.reload();
        return;
      }
      prevPhase = data.phase;
    } catch (e) { /* network blip; keep polling */ }
  }
  const intervalId = setInterval(poll, POLL_INTERVAL_MS);
  poll();
})();
</script>${autoRefreshSec ? `<meta http-equiv="refresh" content="${autoRefreshSec}">` : ''}
</body></html>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/**
 * Portão de entrada: o operador cola o bootstrap token UMA vez e o servidor
 * troca por uma sessão em cookie. O campo é `type="password"` com
 * `autocomplete="off"` para não ir parar no gerenciador de senhas nem em
 * screenshots casuais, e o `<form>` é POST — o token nunca vira query string.
 *
 * `error` já vem sanitizado pelo chamador (sem eco do valor digitado).
 */
export function renderTokenGate(csrf: string, error?: string): string {
  const alert = error
    ? `<div class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">${escapeHtml(error)}</div>`
    : '';
  return `${BASE_HEAD}
${alert}
<p class="text-slate-700 mb-6">
  Cole o token de operador (arquivo <code>control/setup-token.txt</code> no
  volume de auth) para abrir uma sessão de pareamento.
</p>
<form method="POST" action="/setup/session" class="space-y-3" autocomplete="off">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <label class="block text-sm font-medium text-slate-700" for="token">Token de operador</label>
  <input id="token" name="token" type="password" required autocomplete="off"
    spellcheck="false" autocapitalize="off"
    class="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
    placeholder="••••••••••••••••••••••••••••••••">
  <button type="submit"
    class="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium">
    Abrir sessão de pareamento
  </button>
</form>
<p class="mt-6 text-xs text-slate-500">
  A sessão vale 30 minutos e fica num cookie <code>httpOnly</code>. O token
  não aparece na URL, no histórico do navegador nem em logs de acesso.
</p>
</div></body></html>`;
}

export function renderChooser(csrf: string): string {
  return `${BASE_HEAD}
<p class="text-slate-700 mb-6">Escolha como quer parear o WhatsApp da Maia:</p>
<form method="POST" action="/setup/start" class="space-y-3">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <button type="submit" name="method" value="qr"
    class="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium">
    📱 Parear com QR Code
  </button>
  <button type="submit" name="method" value="code"
    class="w-full py-3 px-4 bg-slate-200 hover:bg-slate-300 text-slate-900 rounded-lg font-medium">
    🔢 Parear com Código de 8 dígitos
  </button>
</form>
${STATUS_AND_FOOT('Aguardando você escolher o método de pareamento.')}`;
}

export function renderQr(qr: string | null): string {
  const body = qr
    ? `<div class="text-center">
        <img src="/setup/qr.png" alt="QR Code"
          class="mx-auto rounded-lg border border-slate-200" width="320" height="320">
        <p class="mt-4 text-sm text-slate-600">
          Abra <strong>WhatsApp</strong> → <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong> e aponte a câmera.
        </p>
      </div>`
    : `<div class="text-center py-8">
        <div class="inline-block animate-spin rounded-full h-12 w-12 border-4 border-blue-600 border-t-transparent"></div>
        <p class="mt-4 text-slate-700">Gerando QR Code…</p>
      </div>`;
  const status = qr ? 'Aguardando leitura do QR Code no WhatsApp.' : 'Gerando QR Code…';
  return `${BASE_HEAD}${body}${STATUS_AND_FOOT(status)}`;
}

export function renderCode(code: string, expiresAt: Date): string {
  const formatted = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4, 8)}` : code;
  const expiresIso = expiresAt.toISOString();
  return `${BASE_HEAD}
<div class="text-center">
  <div id="code-display" class="text-5xl font-mono font-bold tracking-widest text-slate-900 my-6 select-all">
    ${escapeHtml(formatted)}
  </div>
  <button id="copy-btn" type="button"
    class="px-4 py-2 bg-slate-200 hover:bg-slate-300 rounded-lg text-sm font-medium">
    📋 Copiar
  </button>
  <p class="mt-4 text-sm text-slate-600">
    Abra <strong>WhatsApp</strong> → <strong>Aparelhos conectados</strong> → <strong>Conectar com número de telefone</strong> → digite este código.
  </p>
  <p class="mt-3 text-xs text-slate-500">
    Válido por <span id="countdown">--:--</span>
  </p>
</div>
<script>
(function() {
  const code = ${JSON.stringify(code)};
  const expiresAt = new Date(${JSON.stringify(expiresIso)}).getTime();
  document.getElementById('copy-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      const btn = document.getElementById('copy-btn');
      btn.textContent = '✅ Copiado!';
      setTimeout(() => { btn.textContent = '📋 Copiar'; }, 1500);
    } catch (e) {
      // Clipboard API unavailable — select-all fallback works via .select-all class
      const el = document.getElementById('code-display');
      const range = document.createRange();
      range.selectNode(el);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  });
  function tick() {
    const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const m = String(Math.floor(remaining / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    document.getElementById('countdown').textContent = m + ':' + s;
  }
  tick();
  setInterval(tick, 1000);
})();
</script>
${STATUS_AND_FOOT('Código gerado. Aguardando confirmação no WhatsApp.')}`;
}

export function renderConnected(connectedAt: Date, dashboardEnabled: boolean): string {
  const tsBR = connectedAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const dashLink = dashboardEnabled
    ? `<a href="/dashboard" class="text-blue-600 hover:underline">→ Dashboard</a>`
    : '';
  return `${BASE_HEAD}
<div class="text-center">
  <div class="text-5xl mb-3">✅</div>
  <h2 class="text-xl font-semibold mb-2">Maia já está pareada</h2>
  <p class="text-slate-700 mb-1">Status: <strong>conectado</strong></p>
  <p class="text-sm text-slate-500 mb-6">desde ${escapeHtml(tsBR)}</p>
  <p class="text-sm text-slate-600">
    Para re-parear, desconecte pelo app do WhatsApp da Maia ou consulte o runbook.
  </p>
  <div class="mt-6 space-x-3">
    <a href="/setup/done" class="text-blue-600 hover:underline">→ Confirmação</a>
    ${dashLink}
  </div>
</div>
</div></body></html>`;
}

export function renderTransientDisconnect(): string {
  return `${BASE_HEAD}
<div class="text-center py-4">
  <div class="inline-block animate-pulse text-3xl mb-3">⏳</div>
  <p class="text-slate-700">Conexão perdida temporariamente.</p>
  <p class="text-sm text-slate-500 mt-2">Reconectando… costuma levar 5-10s.</p>
</div>
${STATUS_AND_FOOT('Conexão perdida temporariamente. Reconectando…', 5)}`;
}

export function renderRecovering(): string {
  return `${BASE_HEAD}
<div class="text-center py-4">
  <div class="inline-block animate-spin text-3xl mb-3">🔄</div>
  <p class="text-slate-700">Limpando sessão antiga e gerando novo token…</p>
  <p class="text-sm text-slate-500 mt-2">~3s. Verifique seu canal de alertas (email/telegram) para instruções de re-pareamento.</p>
</div>
${STATUS_AND_FOOT('Limpando sessão antiga e gerando novo token…', 5)}`;
}

export function renderDone(): string {
  return `${BASE_HEAD}
<div class="text-center py-4">
  <div class="text-5xl mb-3">🎉</div>
  <h2 class="text-xl font-semibold mb-2">Pareamento completo</h2>
  <p class="text-slate-700">A Maia está pronta para receber mensagens.</p>
  <p class="text-sm text-slate-500 mt-4">Você pode fechar essa página.</p>
</div>
</div></body></html>`;
}
