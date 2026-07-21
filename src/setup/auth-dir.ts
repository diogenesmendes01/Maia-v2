import nodePath from 'node:path';
import { config } from '@/config/env.js';
import { TypedError } from '@/lib/utils.js';

/**
 * Guardas de path do `BAILEYS_AUTH_DIR` — raiz e layout multi-linha.
 *
 * Layout canônico (auditoria P0 cap. 7 — o recovery NUNCA opera na raiz):
 *
 *   <BAILEYS_AUTH_DIR>/
 *     control/setup-token.txt   — bootstrap token (fora de QUALQUER alvo de recovery)
 *     primary/                  — auth da sessão PRIMÁRIA
 *     lines/<channel_id>/       — auth das linhas ADICIONAIS
 *     pairing/<channel_id>/     — PairingSessions (§2.5, efêmeras)
 *
 * `assertSafeAuthDir` valida a RAIZ (foot-guns de configuração); os
 * `resolve*` derivam os alvos por-linha SEMPRE validando a raiz de novo; e
 * `assertIsDirectChildOfAuthRoot` é o guard obrigatório de TODO site de
 * remoção — torna `rm` da raiz (ou dos buckets compartilhados inteiros)
 * impossível por construção.
 *
 * NOTA de forma: este módulo participa de um ciclo de import com
 * `config/env.ts` (env valida `BAILEYS_AUTH_DIR` via `assertSafeAuthDir` no
 * parse). Por isso o top level contém APENAS imports, tipos e function
 * declarations (hoisted) — nenhuma `const` de módulo: quando o env avalia no
 * meio do ciclo, uma `const` ainda em TDZ quebraria o parse.
 */

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

  // Inline (não const de módulo) — ver NOTA de forma no cabeçalho: esta
  // função roda no meio do ciclo de import com env.ts.
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

/**
 * Raiz validada do auth dir. Revalida a config em TODA chamada (item de
 * defesa: um valor podre não passa despercebido só porque o boot validou).
 */
function authRootDir(p: PathImpl = nodePath): string {
  return p.resolve(assertSafeAuthDir(config.BAILEYS_AUTH_DIR));
}

/**
 * Resolve `<base>/<bucket>/<channelId>` garantindo que o resultado é um
 * FILHO DIRETO da raiz do bucket (UUID do canal, nunca o número — review v3,
 * path traversal). Review #498 (médio 5): a comparação por prefixo
 * `startsWith(root + '/')` rejeitava TODO path válido no Windows (o
 * separador de `path.resolve` lá é `\`) — `path.relative` + `path.sep` são
 * portáveis: escape ⇒ `..`/absoluto; descida além de um nível ⇒ contém sep.
 *
 * (Movida de `gateway/line-session-manager.ts` no cap. 7 da auditoria P0 —
 * fonte única da validação de channelId; o gateway re-exporta.)
 */
export function resolveScopedAuthDir(
  baseDir: string,
  bucket: 'lines' | 'pairing',
  channelId: string,
  p: PathImpl = nodePath,
): string {
  const root = p.resolve(baseDir, bucket);
  const dir = p.resolve(root, channelId);
  const rel = p.relative(root, dir);
  if (rel === '' || rel.startsWith('..') || p.isAbsolute(rel) || rel.includes(p.sep)) {
    throw new TypedError('auth_dir_escape', `resolved auth dir escapes ${bucket} root`, {
      channelId,
    });
  }
  return dir;
}

/** Auth dir da sessão PRIMÁRIA — `<raiz>/primary` (filho direto da raiz). */
export function resolvePrimaryAuthDir(): string {
  return nodePath.resolve(authRootDir(), 'primary');
}

/** Dir de controle — `<raiz>/control` (abriga o setup-token; NUNCA é alvo
 * de recovery de nenhuma linha). */
export function resolveControlDir(): string {
  return nodePath.resolve(authRootDir(), 'control');
}

/** Auth dir da linha ADICIONAL `<raiz>/lines/<channel_id>` — channelId
 * validado (traversal/separador rejeitado) pela mesma validação da
 * PairingSession. */
export function resolveLineAuthDir(channelId: string): string {
  return resolveScopedAuthDir(authRootDir(), 'lines', channelId);
}

/** Auth dir de pareamento `<raiz>/pairing/<channel_id>` — mesma validação. */
export function resolvePairingAuthDir(channelId: string): string {
  return resolveScopedAuthDir(authRootDir(), 'pairing', channelId);
}

/**
 * Guard obrigatório de TODO site de remoção sob a raiz do auth dir. Aceita
 * SOMENTE:
 *  - profundidade 1: um filho direto da raiz que NÃO seja entrada reservada
 *    (`primary/`, staging de migração, entradas de sessão legada);
 *  - profundidade 2: `lines/<id>` ou `pairing/<id>` (o alvo por-linha).
 *
 * Tudo o mais lança — em particular a PRÓPRIA raiz, qualquer path fora dela
 * e os buckets compartilhados inteiros (`lines/`, `pairing/`, `control/`,
 * `media/`). Com isso, um `rm` recursivo da raiz é impossível por construção
 * em qualquer fluxo automatizado.
 */
export function assertIsDirectChildOfAuthRoot(p: string, pathImpl: PathImpl = nodePath): string {
  const root = authRootDir(pathImpl);
  const abs = pathImpl.resolve(p);
  const rel = pathImpl.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || pathImpl.isAbsolute(rel)) {
    throw new TypedError(
      'auth_root_removal_forbidden',
      'refusing to remove the auth root (or a path outside it)',
      { path: abs },
    );
  }
  const segments = rel.split(pathImpl.sep);
  if (segments.length === 1) {
    if (isReservedRootEntry(segments[0]!)) {
      throw new TypedError(
        'auth_root_removal_forbidden',
        `refusing to remove reserved auth-root entry '${segments[0]}'`,
        { path: abs },
      );
    }
    return abs;
  }
  if (segments.length === 2 && (segments[0] === 'lines' || segments[0] === 'pairing')) {
    return abs;
  }
  throw new TypedError(
    'auth_root_removal_forbidden',
    'removal target is not a sanctioned child of the auth root',
    { path: abs },
  );
}
