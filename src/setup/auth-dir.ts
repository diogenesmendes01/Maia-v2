import nodePath from 'node:path';
import { config } from '@/config/env.js';
import { TypedError } from '@/lib/utils.js';
import {
  assertSafeAuthDir,
  isReservedRootEntry,
  type PathImpl,
} from '@/setup/auth-dir-path.js';

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

/**
 * `assertSafeAuthDir`, `isReservedRootEntry` e `PathImpl` vivem agora em
 * `auth-dir-path.ts` (puro, sem import de `config`) — issue #515: o contrato de
 * configuração precisa validar `BAILEYS_AUTH_DIR` sem carregar o mundo. Este
 * módulo os re-exporta para que todos os import sites existentes sigam válidos.
 */
export { assertSafeAuthDir, isReservedRootEntry };
export type { PathImpl };

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
