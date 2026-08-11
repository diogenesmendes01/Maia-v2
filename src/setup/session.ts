/**
 * Issue #518 — SESSÃO DE OPERADOR do `/setup`, para tirar o bootstrap token
 * da URL.
 *
 * Antes: todo request de `/setup` levava `?token=<32 hex>`. Isso significa o
 * segredo em: histórico do navegador, `Referer` de qualquer recurso externo
 * (o Tailwind CDN da própria página), access log de nginx/proxy, screenshot
 * do operador, e no HTML/JS servido (form action, `<img src>`, polling).
 *
 * Agora: o token é apresentado UMA vez no CORPO de um POST e trocado por um
 * id de sessão opaco guardado em cookie `httpOnly` + `sameSite=strict`. O id
 * não é derivável do token e não serve para nada fora deste processo.
 *
 * O store é EM MEMÓRIA de propósito:
 *   - o `/setup` é uma superfície de operador de instância única (o socket
 *     Baileys primário vive neste processo — uma sessão de pareamento não
 *     faz sentido em outra réplica);
 *   - um restart INVALIDAR as sessões é a semântica correta, não um bug: o
 *     estado de pareamento em memória morreu junto;
 *   - evita persistir mais um segredo em disco/DB.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 30 minutos: tempo de sobra para um pareamento, curto para uma aba esquecida. */
export const SETUP_SESSION_TTL_MS = 30 * 60_000;

export const SETUP_SESSION_COOKIE = 'maia_setup_session';

/**
 * Header do caminho BREAK-GLASS (curl/automação/runbook). Continua exigindo o
 * bootstrap token, mas num header — que não entra em histórico, referer nem
 * na linha de request do access log padrão (`$request` só tem método + URI).
 */
export const SETUP_TOKEN_HEADER = 'x-maia-setup-token';

const sessions = new Map<string, number>();

function prune(now: number): void {
  for (const [id, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(id);
  }
}

/** Cria uma sessão e devolve o id opaco (128 bits de entropia). */
export function createSetupSession(now = Date.now()): string {
  prune(now);
  const id = randomBytes(32).toString('hex');
  sessions.set(id, now + SETUP_SESSION_TTL_MS);
  return id;
}

/**
 * Sessão válida? Comparação em tempo constante contra os ids conhecidos —
 * o `Map.get` direto vazaria a existência do id por timing de hash, o que é
 * irrelevante para 256 bits, mas o custo de fazer certo é uma varredura de
 * um mapa com no máximo um punhado de entradas.
 */
export function verifySetupSession(id: string | undefined, now = Date.now()): boolean {
  if (!id || id.length !== 64) return false;
  prune(now);
  const presented = Buffer.from(id, 'utf8');
  let ok = false;
  for (const known of sessions.keys()) {
    const candidate = Buffer.from(known, 'utf8');
    if (candidate.length === presented.length && timingSafeEqual(candidate, presented)) {
      ok = true;
    }
  }
  return ok;
}

/** Encerra TODAS as sessões (rotação de token, recovery). */
export function revokeAllSetupSessions(): void {
  sessions.clear();
}

/** Test-only. */
export const _internal = {
  size: (): number => sessions.size,
  expire: (id: string): void => {
    sessions.set(id, Date.now() - 1);
  },
};
