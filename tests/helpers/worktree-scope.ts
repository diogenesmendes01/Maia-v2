/**
 * Issue #571 — isolamento de Postgres, Redis e ledger de migrations POR WORKTREE.
 *
 * ## O problema
 *
 * Dezenas de agentes trabalham em `git worktree`s irmãos que compartilham UM
 * Postgres e UM Redis. Duas rodadas de teste simultâneas se enxergam:
 *
 *  - linhas de uma worktree aparecem no `SELECT` da outra (vazamento de dados;
 *    um `afterAll` quebrado já deixou 36 linhas órfãs no banco compartilhado);
 *  - o ledger `schema_migrations` é ÚNICO, então duas árvores com conjuntos de
 *    migrations diferentes brigam pelo mesmo registro — uma marca aplicada o
 *    que a outra nem empacota;
 *  - `bull:agent:*` de uma worktree é consumido pelo worker da outra (o
 *    comentário do `retry: 1` em `vitest.config.ts` documenta exatamente esse
 *    incidente).
 *
 * ## O mecanismo
 *
 * Um **banco Postgres por worktree** e um **índice de db lógico do Redis por
 * worktree**, ambos derivados do caminho da worktree. Nada precisa ser
 * exportado à mão: `tests/setup.ts` (todo worker) e `tests/globalSetup.ts` (uma
 * vez por rodada) chamam `resolveWorktreeScope()` e chegam à MESMA resposta,
 * porque a derivação é uma função pura do caminho — a única parte com I/O é a
 * alocação do índice do Redis, e ela é idempotente.
 *
 * ### Por que banco separado e não schema separado
 *
 * Um schema por worktree com `search_path` exigiria (a) enfiar o `search_path`
 * em TODA conexão — o pool do Drizzle, o pool cru de cada spec, o runner de
 * migrations, o `psql` de diagnóstico; (b) reescrever migrations que qualificam
 * `public.` explicitamente; (c) duplicar extensões (`vector` é por schema).
 * Banco separado dá de graça: ledger próprio, locks de advisory próprios (o
 * lock consultivo do Postgres é por banco), extensões próprias, e `DROP
 * DATABASE` como faxina. Custo medido: ~6.8s para aplicar as 125 migrations num
 * banco novo, uma vez por worktree.
 *
 * ### Por que db numérico do Redis e não prefixo de chave
 *
 * Prefixo sozinho NÃO resolve: o BullMQ não usa as chaves montadas por
 * `buildCacheKey()`, ele monta `<prefix>:<queue>:<id>` com prefixo PRÓPRIO
 * (`bull` por padrão, `src/gateway/queue.ts:34`). Isolar por prefixo exigiria
 * passar `prefix:` em cada `new Queue`/`new Worker` (código de produção) E
 * trocar todos os literais `'maia:...'` espalhados por `src/`. O índice de db
 * troca UMA string — `config.REDIS_URL`, por onde passam os seis clientes
 * ioredis do projeto — e isola tudo, BullMQ inclusive.
 *
 * O limite dessa escolha é real e está declarado: um Redis padrão tem 16 dbs.
 * A alocação abaixo é por *slot com validade*, não por hash, justamente porque
 * hash de ~50 worktrees em 16 slots colide quase sempre. Ver `MAX_REDIS_DB`.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Valor de referência do banco de teste — o mesmo que o README manda exportar e
 * que o CI injeta. Fica aqui para existir UM lugar com essa string.
 */
export const BASE_TEST_DB_URL = 'postgres://maia_test:test1234@localhost:5432/maia_test';
export const BASE_REDIS_URL = 'redis://localhost:6379';

/**
 * Quantos dbs lógicos o Redis alvo tem. O default de um `redis-server` de
 * fábrica é 16 (0–15); reservamos o 0 para quem NÃO é worktree (checkout
 * principal e CI), sobrando 15 slots. Um Redis subido com `--databases 64`
 * aceita mais — informe pelo env e o alocador usa.
 */
const MAX_REDIS_DB = (() => {
  const raw = process.env.MAIA_TEST_REDIS_DATABASES;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(n) && n >= 2 ? n : 16;
})();

/**
 * Um slot de Redis cujo arquivo de posse não é tocado há mais que isto é
 * considerado abandonado e pode ser reciclado. Cobre o caso da worktree que
 * ainda existe no disco mas ninguém usa há dias.
 */
const SLOT_STALE_MS = 6 * 60 * 60 * 1000;

export interface WorktreeScope {
  /** Raiz do checkout (a pasta que contém o `.git`). */
  readonly root: string;
  /** Fatia estável e segura para identificador SQL. */
  readonly slug: string;
  /** Índice do db lógico do Redis exclusivo desta worktree. */
  readonly redisDb: number;
  /** Diretório `.git` COMUM — compartilhado por todas as worktrees. */
  readonly commonGitDir: string;
}

/** Sobe a partir de `from` até achar o diretório que contém um `.git`. */
function findCheckoutRoot(from: string): string | null {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve o `.git` comum. Numa worktree ligada, `.git` é um ARQUIVO com
 * `gitdir: <common>/worktrees/<nome>`; no checkout principal é um diretório.
 * Devolve `null` quando não é worktree ligada — é assim que o checkout
 * principal e o CI ficam com o comportamento de sempre.
 */
function resolveLinkedWorktree(root: string): { commonGitDir: string } | null {
  const dotGit = join(root, '.git');
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return null;

  const raw = readFileSync(dotGit, 'utf8').trim();
  const match = /^gitdir:\s*(.+)$/m.exec(raw);
  if (!match) return null;
  const gitDir = resolve(root, match[1].trim());
  // `<common>/worktrees/<nome>` → `<common>`
  const worktreesDir = dirname(gitDir);
  if (basename(worktreesDir) !== 'worktrees') return null;
  return { commonGitDir: dirname(worktreesDir) };
}

/** `[a-z0-9_]` apenas, para caber num identificador de banco sem aspas. */
function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Reserva (ou reencontra) o slot de db do Redis desta worktree.
 *
 * A posse é um arquivo `<commonGitDir>/maia-redis-slots/<n>` cujo conteúdo é o
 * caminho da worktree. Criar com `wx` é atômico no POSIX, então duas rodadas
 * simultâneas nunca ganham o mesmo slot — quem perde a corrida lê o conteúdo e
 * segue para o próximo índice. Um slot é reciclado quando a worktree dona
 * sumiu do disco ou quando o arquivo está parado há mais de `SLOT_STALE_MS`.
 *
 * Idempotente de propósito: cada worker do vitest chama isto e todos têm de
 * chegar ao mesmo número.
 */
function acquireRedisDb(commonGitDir: string, root: string): number {
  const dir = join(commonGitDir, 'maia-redis-slots');
  mkdirSync(dir, { recursive: true });

  // 1. Já temos slot? Reafirma a posse tocando o mtime.
  for (const entry of readdirSync(dir)) {
    const idx = Number.parseInt(entry, 10);
    if (!Number.isInteger(idx)) continue;
    const file = join(dir, entry);
    try {
      if (readFileSync(file, 'utf8').trim() === root) {
        const now = new Date();
        utimesSync(file, now, now);
        return idx;
      }
    } catch {
      /* slot sumiu no meio do caminho — ignora */
    }
  }

  // 2. Sem slot: pega o menor índice livre (0 fica para quem não é worktree).
  for (let idx = 1; idx < MAX_REDIS_DB; idx++) {
    const file = join(dir, String(idx));
    if (claimSlot(file, root)) return idx;

    // Ocupado: reciclável se o dono sumiu ou parou.
    try {
      const owner = readFileSync(file, 'utf8').trim();
      const parada = Date.now() - statSync(file).mtimeMs;
      if (!existsSync(owner) || parada > SLOT_STALE_MS) {
        unlinkSync(file);
        if (claimSlot(file, root)) return idx;
      }
    } catch {
      /* corrida com outro processo — segue para o próximo índice */
    }
  }

  throw new Error(
    [
      `#571: nenhum db lógico do Redis livre (limite ${MAX_REDIS_DB}).`,
      `Slots em ${dir}.`,
      'Remedeio: apague worktrees mortas (`git worktree prune` + `rm -rf`), ou',
      'suba o Redis com mais dbs (`redis-server --databases 64`) e exporte',
      'MAIA_TEST_REDIS_DATABASES=64.',
    ].join(' '),
  );
}

/** `open(…, 'wx')` é atômico: ou criamos o arquivo, ou alguém já tinha. */
function claimSlot(file: string, root: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch {
    return false;
  }
  try {
    writeSync(fd, root);
  } finally {
    closeSync(fd);
  }
  // Confirma a posse: se outro processo reciclou por cima, o conteúdo não é o
  // nosso e o slot não é nosso.
  try {
    return readFileSync(file, 'utf8').trim() === root;
  } catch {
    return false;
  }
}

let cache: WorktreeScope | null | undefined;

/**
 * Devolve o escopo desta worktree, ou `null` quando não há isolamento a fazer
 * (checkout principal, CI, ou `MAIA_TEST_SCOPE=off`).
 *
 * O resultado é memoizado por processo: o custo de I/O acontece uma vez por
 * worker do vitest.
 */
export function resolveWorktreeScope(): WorktreeScope | null {
  if (cache !== undefined) return cache;
  cache = computeWorktreeScope();
  return cache;
}

function computeWorktreeScope(): WorktreeScope | null {
  if (process.env.MAIA_TEST_SCOPE === 'off') return null;

  const root = findCheckoutRoot(dirname(fileURLToPath(import.meta.url)));
  if (!root) return null;

  const linked = resolveLinkedWorktree(root);
  if (!linked) return null;

  // Nome da pasta + hash do caminho inteiro: legível na hora de olhar
  // `\l` no psql, e ainda assim único entre duas worktrees homônimas.
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8);
  const slug = `${sanitize(root.split('/').pop() ?? 'wt').slice(0, 24)}_${hash}`;
  const redisDb = acquireRedisDb(linked.commonGitDir, root);

  return {
    root,
    slug,
    redisDb,
    commonGitDir: linked.commonGitDir,
  };
}

/**
 * Reescreve a URL do Postgres para o banco desta worktree, preservando host,
 * porta e credenciais. Devolve a URL original quando não há escopo.
 *
 * O nome do banco vira `<original>_wt_<slug>` (63 chars é o teto de um
 * identificador do Postgres, e o truncamento preserva o hash — a parte que
 * garante unicidade).
 */
export function scopedDatabaseUrl(baseUrl: string, scope: WorktreeScope | null): string {
  if (!scope) return baseUrl;
  const url = new URL(baseUrl);
  const original = url.pathname.replace(/^\//, '') || 'maia_test';
  url.pathname = `/${scopedDatabaseName(original, scope)}`;
  return url.toString();
}

/** O nome do banco desta worktree, derivado do banco base. */
export function scopedDatabaseName(baseName: string, scope: WorktreeScope | null): string {
  if (!scope) return baseName;
  const suffix = `_wt_${scope.slug}`;
  const head = baseName.slice(0, 63 - suffix.length);
  return `${head}${suffix}`;
}

/** Reescreve a URL do Redis para o db lógico desta worktree. */
export function scopedRedisUrl(baseUrl: string, scope: WorktreeScope | null): string {
  if (!scope) return baseUrl;
  const url = new URL(baseUrl);
  url.pathname = `/${scope.redisDb}`;
  return url.toString();
}
