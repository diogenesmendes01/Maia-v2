/**
 * Recorte SANITIZADO e BOUNDED de um erro, para log e para fronteira de
 * processo.
 *
 * #533: já houve vazamento de `DATABASE_URL` por stderr cru. Uma falha de
 * conexão é exatamente o erro cuja mensagem carrega a DSN inteira
 * (`postgres://user:senha@host/db`), e é exatamente o erro que alguém vai
 * querer ler no meio de um incidente — ou seja, o pior par possível: a
 * mensagem mais perigosa é a mais consultada.
 *
 * Este módulo existe porque o recorte precisa ser o MESMO em toda superfície
 * que escreve erro de banco. Ele nasceu dentro de `onboarding-expirer.ts`; o
 * review da PR #560 apontou que o collector de backlog (`onboarding-expiry-
 * collector.ts`) logava `(err as Error).message` cru, na mesma área e sobre a
 * mesma conexão. Duas cópias divergem; uma cópia só, não.
 *
 * O que atravessa: `name`, `code` (o do driver quando existe — `40P01`
 * deadlock, `57P01` admin shutdown — que é o que um plantonista quer) e a
 * mensagem com URIs censuradas e truncada. O que NÃO atravessa: `cause`, a
 * stack, e qualquer campo não enumerado aqui.
 */

/** Qualquer URI com credencial embutida some do que for escrito. */
const URI_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*/gi;

export interface SafeFailure {
  readonly name: string;
  readonly code: string;
  readonly reason: string;
}

export function safeFailure(err: unknown): SafeFailure {
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof e?.name === 'string' ? e.name.slice(0, 64) : 'Error';
  const code =
    typeof e?.code === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(e.code) ? e.code : 'unknown';
  const reason =
    typeof e?.message === 'string'
      ? e.message.replace(URI_RE, '[REDACTED_URL]').slice(0, 200)
      : '';
  return { name, code, reason };
}
