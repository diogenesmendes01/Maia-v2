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
import { comLockDeDiretorio } from './lock-de-diretorio.js';

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
  const raw = process.env.TEST_REDIS_DATABASES;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(n) && n >= 2 ? n : 16;
})();

/**
 * Um slot de Redis cujo arquivo de posse não é tocado há mais que isto é
 * considerado abandonado e pode ser reciclado. Cobre o caso da worktree que
 * ainda existe no disco mas ninguém usa há dias.
 *
 * O que torna esse prazo HONESTO é o heartbeat abaixo: sem ele, o mtime só
 * era escrito na resolução inicial do escopo, e uma rodada viva por mais de 6h
 * (suíte inteira num runner lento, `vitest --watch` aberto o dia todo) tinha o
 * slot tomado debaixo dela — a revisão da PR #597 apontou exatamente isso.
 */
const SLOT_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * De quanto em quanto tempo um processo vivo reafirma a posse do slot tocando
 * o mtime. Precisa ser MUITO menor que `SLOT_STALE_MS` para que a validade
 * signifique "ninguém está rodando", e não "ninguém começou a rodar agora".
 */
const HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Nome do mutex que serializa a RECICLAGEM dentro do diretório de slots. Não
 * é um índice, então a varredura de slots (que faz `parseInt`) o ignora
 * sozinha — e o ponto inicial o mantém fora de um `cat` distraído.
 */
const LOCK_DE_RECICLAGEM = '.reciclagem.lock';

/**
 * O caminho do mutex de reciclagem. Exportado porque ele É o contrato: o teste
 * que prova a serialização segura este lock de fora e afirma que ninguém
 * recicla enquanto ele estiver na mão. Ver
 * `tests/unit/helpers/worktree-scope-concorrencia.spec.ts`.
 */
export function caminhoDoLockDeReciclagem(commonGitDir: string): string {
  return join(diretorioDeSlots(commonGitDir), LOCK_DE_RECICLAGEM);
}

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

/** O diretório de posse dos slots, dentro do `.git` COMUM às worktrees. */
export function diretorioDeSlots(commonGitDir: string): string {
  return join(commonGitDir, 'maia-redis-slots');
}

/**
 * Reserva (ou reencontra) o slot de db do Redis desta worktree.
 *
 * A posse é um arquivo `<commonGitDir>/maia-redis-slots/<n>` cujo conteúdo é o
 * caminho da worktree. Criar com `wx` é atômico no POSIX, então duas rodadas
 * simultâneas nunca ganham o mesmo slot LIVRE — quem perde a corrida lê o
 * conteúdo e segue para o próximo índice.
 *
 * A RECICLAGEM de um slot ocupado é outra história, e é onde a versão anterior
 * errava: apagar posse alheia com base numa leitura feita ANTES do apagamento
 * permite que dois processos concluam "está abandonado" a partir da mesma
 * observação, e o segundo apague a posse que o primeiro acabou de criar. Ver o
 * cabeçalho de `lock-de-diretorio.ts` para o interleaving completo. Aqui a
 * reciclagem inteira roda sob mutex e confirma, antes do `unlink`, que ainda
 * está removendo a GERAÇÃO observada (inode + mtime).
 *
 * Idempotente de propósito: cada worker do vitest chama isto e todos têm de
 * chegar ao mesmo número.
 */
function acquireRedisDb(commonGitDir: string, root: string): number {
  const dir = diretorioDeSlots(commonGitDir);
  mkdirSync(dir, { recursive: true });

  // 1. Já temos slot? Reafirma a posse tocando o mtime.
  const jaNosso = slotJaNosso(dir, root);
  if (jaNosso !== null) return jaNosso;

  // 2. Sem slot: pega o menor índice livre (0 fica para quem não é worktree).
  const lock = join(dir, LOCK_DE_RECICLAGEM);
  for (let idx = 1; idx < MAX_REDIS_DB; idx++) {
    const file = join(dir, String(idx));
    if (claimSlot(file, root)) return idx;

    // Ocupado. O pré-teste abaixo é uma leitura BARATA e sem lock: ele só
    // decide se vale a pena pagar o mutex. Quem decide de verdade é
    // `reciclarSlot`, que reobserva tudo lá dentro.
    if (!pareceReciclavel(file)) continue;
    const r = comLockDeDiretorio(lock, () => reciclarSlot(file, root));
    if (r.ok && r.valor) return idx;
  }

  throw new Error(
    [
      `#571: nenhum db lógico do Redis livre (limite ${MAX_REDIS_DB}).`,
      `Slots em ${dir}.`,
      'Remedeio: apague worktrees mortas (`git worktree prune` + `rm -rf`), ou',
      'suba o Redis com mais dbs (`redis-server --databases 64`) e exporte',
      'TEST_REDIS_DATABASES=64.',
    ].join(' '),
  );
}

/** O índice cujo arquivo de posse já nomeia `root`, com o mtime reafirmado. */
function slotJaNosso(dir: string, root: string): number | null {
  for (const entry of readdirSync(dir)) {
    const idx = Number.parseInt(entry, 10);
    if (!Number.isInteger(idx)) continue;
    const file = join(dir, entry);
    try {
      if (readFileSync(file, 'utf8').trim() === root) {
        tocar(file);
        return idx;
      }
    } catch {
      /* slot sumiu no meio do caminho — ignora */
    }
  }
  return null;
}

/** Pré-teste sem lock: vale a pena disputar a reciclagem deste slot? */
function pareceReciclavel(file: string): boolean {
  try {
    const owner = readFileSync(file, 'utf8').trim();
    const parada = Date.now() - statSync(file).mtimeMs;
    return owner === '' || !existsSync(owner) || parada > SLOT_STALE_MS;
  } catch {
    // Sumiu entre o `claimSlot` e agora: livre, e vale tentar sob lock.
    return true;
  }
}

/**
 * Recicla `file` para `root`, se ele ainda estiver abandonado. **Só é correto
 * chamado sob `comLockDeDiretorio`.**
 *
 * Duas defesas, e as duas são necessárias:
 *
 *  - o mutex serializa os reclaimers, então o segundo a entrar reobserva o
 *    estado que o primeiro deixou (posse nova, mtime fresco) e desiste;
 *  - o fencing por geração (inode + mtime) garante que o `unlink` remove o
 *    MESMO arquivo que foi observado. Sem ele, um lock quebrado por validade
 *    reabriria a janela de apagar posse recém-criada.
 *
 * Exportada para o teste da REVALIDAÇÃO: a reobservação sob mutex é o que faz
 * um slot que deixou de estar abandonado ser declinado, e isso é afirmável sem
 * depender de tempo. O fencing propriamente dito (a igualdade de inode+mtime
 * entre o `stat` e o `unlink`) é uma janela de microssegundos e NÃO é provável
 * de fora sem um gancho no meio do algoritmo — ver o cabeçalho do spec.
 */
export function reciclarSlot(file: string, root: string): boolean {
  let owner: string;
  let geracao: { readonly ino: bigint; readonly mtimeMs: bigint };
  try {
    const st = statSync(file, { bigint: true });
    owner = readFileSync(file, 'utf8').trim();
    geracao = { ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    // Sumiu entre o pré-teste e o lock: está livre agora.
    return claimSlot(file, root);
  }

  if (owner === root) {
    tocar(file);
    return true;
  }

  const parada = Date.now() - Number(geracao.mtimeMs);
  if (owner !== '' && existsSync(owner) && parada <= SLOT_STALE_MS) return false;

  try {
    const agora = statSync(file, { bigint: true });
    // A geração mudou entre a observação e agora: quem quer que tenha mexido
    // é o dono atual, e apagar aqui seria apagar posse viva.
    if (agora.ino !== geracao.ino || agora.mtimeMs !== geracao.mtimeMs) return false;
    unlinkSync(file);
  } catch {
    return false;
  }
  return claimSlot(file, root);
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

function tocar(file: string): void {
  const agora = new Date();
  utimesSync(file, agora, agora);
}

/**
 * Reafirma a posse do slot enquanto este processo estiver vivo.
 *
 * O timer é `unref()`: ele nunca segura o event loop aberto, então um worker
 * do vitest termina exatamente quando terminaria sem ele. Desliga com
 * `TEST_WORKTREE_SCOPE_HEARTBEAT=off` (fora do namespace `MAIA_`, como os
 * outros knobs desta issue — ver README).
 */
function iniciarHeartbeat(file: string, root: string): void {
  if (process.env.TEST_WORKTREE_SCOPE_HEARTBEAT === 'off') return;
  const timer = setInterval(() => {
    try {
      // Perdemos o slot (alguém reciclou apesar de tudo)? Então parar de tocar
      // é o certo: continuar seria manter vivo o mtime de posse ALHEIA.
      if (readFileSync(file, 'utf8').trim() !== root) {
        clearInterval(timer);
        return;
      }
      tocar(file);
    } catch {
      clearInterval(timer);
    }
  }, HEARTBEAT_MS);
  timer.unref();
}

let cache: WorktreeScope | null | undefined;

/**
 * Devolve o escopo desta worktree, ou `null` quando não há isolamento a fazer
 * (checkout principal, CI, ou `TEST_WORKTREE_SCOPE=off`).
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
  if (process.env.TEST_WORKTREE_SCOPE === 'off') return null;

  const root = findCheckoutRoot(dirname(fileURLToPath(import.meta.url)));
  if (!root) return null;

  const linked = resolveLinkedWorktree(root);
  if (!linked) return null;

  // Nome da pasta + hash do caminho inteiro: legível na hora de olhar
  // `\l` no psql, e ainda assim único entre duas worktrees homônimas.
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8);
  const slug = `${sanitize(root.split('/').pop() ?? 'wt').slice(0, 24)}_${hash}`;
  const redisDb = acquireRedisDb(linked.commonGitDir, root);
  // Enquanto este processo viver, o slot é reafirmado. É isto que faz
  // `SLOT_STALE_MS` significar "abandonado" e não "começou faz tempo".
  iniciarHeartbeat(join(diretorioDeSlots(linked.commonGitDir), String(redisDb)), root);

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

/**
 * O nome do banco desta worktree, derivado do banco base.
 *
 * IDEMPOTENTE de propósito. `tests/setup.ts` passou a derivar a base do
 * ambiente (`TEST_DB_URL`), e um ambiente já escopado — herdado por um processo
 * filho, ou reaplicado no mesmo processo — geraria `…_wt_x_wt_x`, um banco que
 * ninguém criou. Aplicar duas vezes tem de dar o mesmo resultado que aplicar
 * uma.
 */
export function scopedDatabaseName(baseName: string, scope: WorktreeScope | null): string {
  if (!scope) return baseName;
  const suffix = `_wt_${scope.slug}`;
  if (baseName.endsWith(suffix)) return baseName;
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

/* ───────────────────────────────────────────────────────────────────────────
 * UMA base, um destino — issue #571, revisão da PR #597
 *
 * O defeito: `tests/globalSetup.ts` limpava o Redis de
 * `process.env.REDIS_URL ?? BASE_REDIS_URL`, enquanto `tests/setup.ts`
 * mandava TODO worker para `BASE_REDIS_URL`, sempre. Com um Redis fora do
 * default (outra porta, outro host, TLS, senha) o `FLUSHDB` caía no endpoint
 * customizado e os testes rodavam contra `localhost:6379` — limpeza,
 * isolamento e clientes em três lugares diferentes.
 *
 * A correção não é repetir a mesma expressão nos dois arquivos (foi assim que
 * elas divergiram): é existir UMA função que resolve a base e UMA que compõe o
 * ambiente escopado, e os dois processos chamarem essa função. Um valor
 * derivado em dois lugares volta a divergir; derivado em um, não tem como.
 * ─────────────────────────────────────────────────────────────────────────── */

/** Ambiente lido pelas funções abaixo (um `process.env` ou um objeto de teste). */
export type AmbienteBruto = Readonly<Record<string, string | undefined>>;

/**
 * A URL base do Redis, ANTES do escopo da worktree.
 *
 * `REDIS_URL` do ambiente vence: é assim que se aponta para outra porta, outro
 * host, ou um endpoint com credencial. Sem ela, o valor de referência.
 */
export function baseRedisUrl(env: AmbienteBruto = process.env): string {
  return env.REDIS_URL ?? BASE_REDIS_URL;
}

/**
 * A URL base do Postgres, ANTES do escopo da worktree.
 *
 * `TEST_DB_URL` — e SÓ ela — vem do ambiente. `DATABASE_URL` de propósito NÃO
 * entra nessa conta: `tests/setup.ts` existe para blindar a rodada do shell do
 * desenvolvedor, e quem exporta `DATABASE_URL` normalmente está apontando para
 * o banco de DEV (`maia`), não para o de teste. `TEST_DB_URL` é o interruptor
 * declarado da suíte de integração, e é o mesmo que `tests/globalSetup.ts` já
 * consultava.
 */
export function basePostgresUrl(env: AmbienteBruto = process.env): string {
  return env.TEST_DB_URL ?? BASE_TEST_DB_URL;
}

/** O nome do banco embutido numa URL do Postgres. */
export function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

/** As variáveis que a rodada de teste passa a enxergar, já escopadas. */
export interface AmbienteDeTeste {
  readonly DATABASE_URL: string;
  readonly POSTGRES_USER: string;
  readonly POSTGRES_PASSWORD: string;
  readonly POSTGRES_DB: string;
  readonly REDIS_URL: string;
  /** Só existe quando `TEST_DB_URL` existia — não inventamos o interruptor. */
  readonly TEST_DB_URL?: string;
}

/**
 * Compõe o ambiente escopado a partir de `env`. Chamada por `tests/setup.ts`
 * (todo worker) e por `tests/globalSetup.ts` (uma vez por rodada) — é a função
 * que garante que a URL LIMPA e a URL USADA são a mesma string.
 *
 * Credenciais e nome do banco saem da própria URL base: um `TEST_DB_URL` com
 * usuário/porta próprios não pode conviver com `POSTGRES_USER` fixo em
 * `maia_test`, que era o que havia antes.
 */
export function resolveTestEnv(
  env: AmbienteBruto = process.env,
  scope: WorktreeScope | null = resolveWorktreeScope(),
): AmbienteDeTeste {
  const basePg = basePostgresUrl(env);
  const pg = new URL(basePg);
  const escopada = scopedDatabaseUrl(basePg, scope);
  const composto: AmbienteDeTeste = {
    DATABASE_URL: escopada,
    POSTGRES_USER: decodeURIComponent(pg.username),
    POSTGRES_PASSWORD: decodeURIComponent(pg.password),
    POSTGRES_DB: databaseNameOf(escopada),
    REDIS_URL: scopedRedisUrl(baseRedisUrl(env), scope),
  };
  return env.TEST_DB_URL ? { ...composto, TEST_DB_URL: escopada } : composto;
}

/**
 * A URL sem a senha, para entrar em mensagem de erro e log.
 *
 * Um diagnóstico que ajuda tem de dizer PARA ONDE a conexão foi; um
 * diagnóstico seguro não pode carregar a credencial para o log do CI.
 */
export function sanitizarUrl(bruta: string): string {
  try {
    const u = new URL(bruta);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<url ilegível>';
  }
}

/** Idem, para texto livre (mensagem de biblioteca) que possa conter uma URL. */
export function sanitizarMensagem(texto: string): string {
  return texto.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*):[^\s@/]*@/gi, '$1:***@');
}
