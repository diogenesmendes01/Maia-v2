/**
 * PURE path guards for `BAILEYS_AUTH_DIR`.
 *
 * Split out of `auth-dir.ts` for issue #515: the config contract validates
 * `BAILEYS_AUTH_DIR` and MUST stay importable without side effects. The rest of
 * `auth-dir.ts` reads the loaded `config` singleton (which pulls
 * `dotenv/config` + `loadConfig()` at import time), so the contract cannot
 * import it. This module depends only on `node:path` and `process.cwd()`.
 *
 * `auth-dir.ts` re-exports everything here, so existing import sites are
 * unchanged.
 */
import nodePath from 'node:path';

/** Subconjunto de `node:path` usado na validação — injetável para testar
 * as semânticas win32 E posix na mesma plataforma (review #498 médio 5). */
export type PathImpl = Pick<typeof nodePath, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>;

/**
 * Whitelist + blacklist guard for `BAILEYS_AUTH_DIR`.
 *
 * O recovery remove diretórios sob esta raiz automaticamente (sem humano no
 * loop). Se `BAILEYS_AUTH_DIR` estiver mal configurado (`/`, `/etc`, raiz do
 * projeto, string vazia que resolve para o CWD), o fluxo vira um wipe
 * destrutivo. Este helper rejeita os foot-guns óbvios no boot e nos sites de
 * remoção:
 *  - raízes de filesystem (POSIX `/`, drives Windows tipo `C:\`)
 *  - diretórios de sistema comuns (`/home`, `/root`, `/etc`, `/var`, `/usr`)
 *  - o CWD do processo (raiz do projeto)
 *  - paths sem um segmento "baileys" — marcador positivo de "isto é mesmo um
 *    dir de sessão Baileys", não um erro de config
 */
export function assertSafeAuthDir(p: string): string {
  if (!p || p.trim() === '') {
    throw new Error('BAILEYS_AUTH_DIR is empty');
  }
  const abs = nodePath.resolve(p);

  if (abs === '/' || /^[A-Z]:\\?$/i.test(abs)) {
    throw new Error(`refusing to use filesystem root as BAILEYS_AUTH_DIR (${abs})`);
  }

  for (const f of ['/', '/home', '/root', '/etc', '/var', '/usr']) {
    if (abs === nodePath.resolve(f)) {
      throw new Error(`refusing to use system path as BAILEYS_AUTH_DIR (${abs})`);
    }
  }

  if (abs === nodePath.resolve(process.cwd())) {
    throw new Error(`refusing to use CWD as BAILEYS_AUTH_DIR (${abs})`);
  }

  // Positive marker: the path must contain a "baileys" segment somewhere.
  // Catches typos that resolve to /home/maia, /opt/data, etc.
  const segments = abs.split(nodePath.sep);
  if (!segments.some((s) => s.toLowerCase().includes('baileys'))) {
    throw new Error(
      `BAILEYS_AUTH_DIR must contain a "baileys" path segment (got ${abs})`,
    );
  }

  return abs;
}

/**
 * Entradas RESERVADAS da raiz — nunca são sessão legada da primária e nunca
 * podem ser alvo de sweep/migração automatizada:
 *  - `lines/`, `pairing/`, `control/`: buckets compartilhados do layout;
 *  - `media/`: defensivo (o MEDIA_ROOT canônico vive FORA da raiz, mas um
 *    deploy antigo/custom pode tê-lo dentro);
 *  - `setup-token.txt`: token legado na raiz (migrado por token.ts, nunca
 *    varrido junto com a sessão).
 */
export function isReservedRootEntry(name: string): boolean {
  return ['lines', 'pairing', 'control', 'media', 'setup-token.txt'].includes(name);
}
