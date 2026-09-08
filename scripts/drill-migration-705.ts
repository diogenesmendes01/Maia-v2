/**
 * Drill de migration em staging — issue #705, bancada de execução.
 *
 * ─── O que este arquivo É ────────────────────────────────────────────────────
 *
 * A bancada. Ele NÃO executa o drill por conta própria e NÃO decide nada: quem
 * executa é o condutor humano, dentro de uma janela que o dono registra. Este
 * script existe para que a janela seja gasta coletando evidência, e não
 * lembrando comandos.
 *
 * A #705 é explícita: *"Nenhum agente executa este drill, e nenhum agente marca
 * esta issue como concluída."* Nada aqui roda sozinho, nada aqui tem default de
 * alvo, e nada aqui abre conexão antes de um alvo ser DECLARADO.
 *
 * ─── O modo de falha que este desenho existe para eliminar ───────────────────
 *
 * O jeito óbvio de escrever este script seria ler `DATABASE_URL` do ambiente e
 * rodar. Ele funcionaria em toda demonstração e falharia uma vez só: no
 * terminal onde alguém exportou o staging por outro motivo — um `psql` de
 * diagnóstico meia hora antes — e agora um comando cujo nome diz "drill" aplica
 * uma migration deliberadamente quebrada onde ninguém pediu.
 *
 * Por isso o alvo é DECLARADO, não herdado:
 *
 *   1. `--alvo=<local|staging>` é obrigatório e não tem default. Ausente →
 *      `RequiredArgsError` → exit 2. Nenhuma fase existe sem ele.
 *   2. `--dsn-env=<NOME_DA_VARIAVEL>` é obrigatório e nomeia a variável de
 *      ambiente que carrega a connection string. O script NUNCA lê um nome que
 *      ele mesmo escolheu.
 *   3. Os nomes AMBIENTAIS são RECUSADOS (`DATABASE_URL`, `POSTGRES_URL`,
 *      `TEST_DB_URL`, `PGHOST`, …). São exatamente os que já estão exportados
 *      por outro motivo no terminal de um operador. O condutor exporta
 *      `DRILL_705_DSN` — um nome que ninguém tem exportado por acidente.
 *   4. O alvo declarado é CONFERIDO contra o host do DSN resolvido:
 *      `--alvo=local` que aponta para fora de `127.0.0.1`/`localhost`/`::1` é
 *      recusado (exit 3), e `--alvo=staging` que aponta para `localhost`
 *      também. Uma corrida rotulada errado não produz evidência: produz uma
 *      linha falsa no gabarito.
 *   5. As fases que ESCREVEM exigem `--executar`. Sem ele o script imprime o
 *      que faria e sai 0 sem tocar em nada.
 *   6. Em `--alvo=staging`, as fases que escrevem exigem também
 *      `--janela=<rótulo>` — o condutor precisa ter uma janela para citar.
 *
 * A inércia está sob teste, não sob comentário:
 * `tests/unit/ops/drill-705-alvo-declarado.spec.ts` reprova se qualquer um
 * desses pontos ganhar um default, e prova que nenhum pool é aberto antes do
 * portão.
 *
 * ─── A migration deliberadamente quebrada, e por que ela não vaza ────────────
 *
 * O item 2 da #705 é o coração do exercício: *provar que uma migration que
 * FALHA impede o app novo de iniciar*. Isso exige uma migration quebrada de
 * verdade. Um arquivo em `migrations/` que o runner normal enxergasse seria um
 * desastre — ele entraria no artefato empacotado da imagem, no `migrate status`
 * de todo mundo, no CI, e um dia em produção.
 *
 * Então ela mora em `scripts/drill/705-gate-de-migration/fixtures/`, e o drill
 * monta um diretório EFÊMERO em `os.tmpdir()` com cópias dos `.sql` reais mais
 * as duas fixtures, e aponta o runner para ELE (`RunnerDeps.migrationsDir` é
 * parâmetro — `src/migrations/runner.ts:151`). Consequências:
 *
 *   - `migrations/` nunca é escrito. `montarOverlay()` só lê de lá;
 *   - o artefato empacotado da imagem continua sem a fixture, então a leitura
 *     de readiness feita contra `migrations/` DE VERDADE vê a linha do ledger
 *     como `missing_file` e reprova — que é precisamente a evidência do item 2
 *     pelo lado da aplicação;
 *   - `assertFixtureNaoVazou()` roda ANTES de qualquer coisa e aborta (exit 4)
 *     se a fixture aparecer em `migrations/`;
 *   - `tests/unit/ops/drill-705-fixture-isolada.spec.ts` prova as três coisas
 *     sem banco: a fixture não está no artefato real, o overlay não escreve em
 *     `migrations/`, e o guard de vazamento dispara.
 *
 * ─── Códigos de saída (estáveis; o gabarito cita cada um) ────────────────────
 *
 *   0  — a fase concluiu e produziu a evidência esperada
 *   1  — falha inesperada (classe do erro no stderr, nunca a mensagem crua)
 *   2  — contrato de uso: alvo/dsn-env ausente, nome ambiental, sem `--executar`
 *   3  — alvo declarado incoerente com o host do DSN resolvido
 *   4  — a fixture do drill vazou para `migrations/`
 *   20 — a migration quebrada NÃO falhou: o gate não existe. É um ACHADO do
 *        drill, não um defeito deste script — e é a razão de o drill existir.
 *
 * ─── Referências ─────────────────────────────────────────────────────────────
 *
 *   - `docs/runbooks/drill-705-gabarito-de-coleta.md` — o formulário do condutor
 *   - `docs/runbooks/drill-705-checklist-de-aceite.md` — as sete evidências
 *   - `docs/runbooks/migrations.md` — dirty, repair, rollback
 *   - `scripts/embeddings-rebuild.ts` (#239) e `scripts/import-ofx.ts` (#720) —
 *     o padrão de escopo obrigatório / `RequiredArgsError` / exit 2 /
 *     `isDirectInvocation` que este arquivo segue em vez de inventar outro
 */
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  getMigrationStatus,
  getSchemaReadiness,
  repairMigration,
  runMigrations,
  type MigrationRunResult,
  type ReadOnlyPool,
  type RunnerDeps,
  type SchemaReadiness,
} from '@/migrations/index.js';
import type { RunnerPool } from '@/migrations/runner.js';
// O MESMO filtro que a #510 usa para todo artefato do harness. Importado, não
// reimplementado, e não afrouxado: o item 6 da #705 manda conferir que a
// redaction funciona no caminho real, e uma cópia relaxada aqui responderia a
// pergunta errada. Precedente de import cruzado scripts/→tests/:
// `scripts/test-infra.ts` importa `tests/helpers/lock-de-diretorio.js`.
import { jsonSanitizado, sanitizarTexto } from '../tests/reliability/harness/sanitize.js';

// ─────────────────────────────────────────────────────────────────────────────
// Contrato de invocação
// ─────────────────────────────────────────────────────────────────────────────

/** Os alvos que o drill reconhece. Lista FECHADA — não há "outro". */
export const ALVOS = ['local', 'staging'] as const;
export type Alvo = (typeof ALVOS)[number];

/** As fases, na ordem em que a janela as executa. */
export const FASES = ['roteiro', 'contexto', 'quebrar', 'verificar', 'reparar', 'sanitizar'] as const;
export type Fase = (typeof FASES)[number];

/** As fases que ESCREVEM. Só elas exigem `--executar` (e `--janela` em staging). */
export const FASES_QUE_ESCREVEM: readonly Fase[] = ['quebrar', 'reparar'];

/**
 * Nomes de variável de ambiente RECUSADOS como `--dsn-env`.
 *
 * O critério não é "são secretos" — é "já estão exportados por outro motivo".
 * Um terminal de operador tem `DATABASE_URL` apontando para onde ele estava
 * diagnosticando cinco minutos atrás; herdar isso é o acidente inteiro. A
 * comparação é case-insensitive.
 */
export const NOMES_DE_ENV_AMBIENTE: readonly string[] = [
  'DATABASE_URL',
  'DB_URL',
  'PGDATABASE',
  'PGHOST',
  'PGPORT',
  'PGURL',
  'PG_URL',
  'POSTGRESQL_URL',
  'POSTGRES_URL',
  'TEST_DB_URL',
];

/** Hosts que contam como "esta máquina". */
export const HOSTS_LOCAIS: readonly string[] = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/** Id da migration deliberadamente quebrada, tal como o ledger a registra. */
export const MIGRATION_QUEBRADA = '900_drill705_falha_deliberada.sql';

/** Diretório das fixtures do drill — FORA de `migrations/`, e é o ponto. */
export const DIR_FIXTURES = join('scripts', 'drill', '705-gate-de-migration', 'fixtures');

/** Argumentos obrigatórios ausentes. Mesma forma de `scripts/import-ofx.ts`. */
export class RequiredArgsError extends Error {
  readonly code = 'MISSING_REQUIRED_ARGS';
  constructor(readonly missing: string[]) {
    super(
      `drill-705: faltam argumentos obrigatórios: ${missing.join(', ')}. ` +
        'uso: tsx scripts/drill-migration-705.ts --fase=<fase> --alvo=<local|staging> ' +
        '--dsn-env=<NOME_DA_VARIAVEL>',
    );
    this.name = 'RequiredArgsError';
  }
}

/** `--fase` ou `--alvo` fora da lista fechada. */
export class ValorDesconhecidoError extends Error {
  readonly code = 'DRILL_VALOR_DESCONHECIDO';
  constructor(flag: string, valor: string, aceitos: readonly string[]) {
    super(`drill-705: ${flag}="${valor}" não existe. Aceitos: ${aceitos.join(' | ')}.`);
    this.name = 'ValorDesconhecidoError';
  }
}

/** `--dsn-env` nomeou uma variável ambiental. Ver `NOMES_DE_ENV_AMBIENTE`. */
export class AmbienteRecusadoError extends Error {
  readonly code = 'DRILL_ENV_AMBIENTAL_RECUSADA';
  constructor(nome: string) {
    super(
      `drill-705: recuso ler o alvo de "${nome}" — é uma variável AMBIENTAL, ` +
        'provavelmente já exportada neste terminal por outro motivo. O drill não ' +
        'herda alvo: exporte um nome próprio (ex.: DRILL_705_DSN=…) e passe ' +
        '--dsn-env=DRILL_705_DSN.',
    );
    this.name = 'AmbienteRecusadoError';
  }
}

/** A variável nomeada por `--dsn-env` não existe (ou está vazia). Fail-closed. */
export class SegredoAusenteError extends Error {
  readonly code = 'DRILL_DSN_AUSENTE';
  constructor(nome: string) {
    super(
      `drill-705: a variável "${nome}" não está definida (ou está vazia). ` +
        'Sem alvo resolvido o drill não abre conexão nenhuma.',
    );
    this.name = 'SegredoAusenteError';
  }
}

/** O DSN resolvido não é uma URL legível. Nunca ecoa o valor. */
export class DsnIlegivelError extends Error {
  readonly code = 'DRILL_DSN_ILEGIVEL';
  constructor(nome: string) {
    super(
      `drill-705: o conteúdo de "${nome}" não é uma connection string legível ` +
        '(esperado postgres://…). O valor NÃO é ecoado.',
    );
    this.name = 'DsnIlegivelError';
  }
}

/** O rótulo declarado não bate com o host resolvido. */
export class AlvoIncoerenteError extends Error {
  readonly code = 'DRILL_ALVO_INCOERENTE';
  constructor(alvo: Alvo, host: string) {
    super(
      `drill-705: --alvo=${alvo} não bate com o host resolvido "${host}". ` +
        (alvo === 'local'
          ? 'Um alvo declarado "local" tem de apontar para esta máquina.'
          : 'Um alvo declarado "staging" apontando para esta máquina é um rótulo errado — ' +
            'a evidência sairia falsa. Use --alvo=local para ensaiar aqui.'),
    );
    this.name = 'AlvoIncoerenteError';
  }
}

/** Fase que escreve, sem `--executar` (ou sem `--janela` em staging). */
export class SemAutorizacaoError extends Error {
  readonly code = 'DRILL_SEM_AUTORIZACAO';
  constructor(readonly faltando: string[], fase: Fase) {
    super(
      `drill-705: a fase "${fase}" ESCREVE no alvo e exige ${faltando.join(' e ')}. ` +
        'Sem isso ela não roda — o script imprime o que faria e sai.',
    );
    this.name = 'SemAutorizacaoError';
  }
}

/** A fixture do drill apareceu em `migrations/`. */
export class FixtureVazouError extends Error {
  readonly code = 'DRILL_FIXTURE_VAZOU';
  constructor(readonly arquivos: string[]) {
    super(
      `drill-705: ABORTADO — arquivo(s) do drill dentro de migrations/: ` +
        `${arquivos.join(', ')}. Eles NÃO podem existir lá: o runner de produção ` +
        'varre esse diretório. Remova-os antes de qualquer outra coisa.',
    );
    this.name = 'FixtureVazouError';
  }
}

export interface DrillArgs {
  readonly fase: Fase;
  readonly alvo: Alvo;
  readonly dsnEnv: string;
  readonly executar: boolean;
  readonly janela: string | null;
  readonly saida: string | null;
  readonly motivo: string | null;
  readonly imagem: string | null;
  readonly readyz: string | null;
  readonly log: string | null;
  readonly desfazerEfeito: boolean;
  readonly amostras: number;
}

/** `--nome=valor`. Mesma forma de `scripts/import-ofx.ts:107`. */
export function arg(argv: readonly string[], nome: string): string | undefined {
  const flag = `--${nome}=`;
  for (const a of argv) if (a.startsWith(flag)) return a.slice(flag.length);
  return undefined;
}

function flag(argv: readonly string[], nome: string): boolean {
  return argv.includes(`--${nome}`);
}

/**
 * Analisa argv. NENHUM dos três obrigatórios tem default — é esta função que a
 * trava de execução (`tests/unit/ops/drill-705-alvo-declarado.spec.ts`) prende:
 * ela fixa a lista `missing` inteira, então dar default a qualquer um deles
 * encurta a lista e reprova o teste.
 */
export function parseDrillArgs(argv: readonly string[]): DrillArgs {
  const fase = arg(argv, 'fase');
  const alvo = arg(argv, 'alvo');
  const dsnEnv = arg(argv, 'dsn-env');

  const missing: string[] = [];
  if (!fase) missing.push('--fase');
  if (!alvo) missing.push('--alvo');
  if (!dsnEnv) missing.push('--dsn-env');
  if (missing.length > 0) throw new RequiredArgsError(missing);

  if (!(FASES as readonly string[]).includes(fase as string)) {
    throw new ValorDesconhecidoError('--fase', fase as string, FASES);
  }
  if (!(ALVOS as readonly string[]).includes(alvo as string)) {
    throw new ValorDesconhecidoError('--alvo', alvo as string, ALVOS);
  }

  const amostrasBruto = arg(argv, 'amostras');
  const amostras = amostrasBruto ? Number.parseInt(amostrasBruto, 10) : 10;

  return {
    fase: fase as Fase,
    alvo: alvo as Alvo,
    dsnEnv: dsnEnv as string,
    executar: flag(argv, 'executar'),
    janela: arg(argv, 'janela') ?? null,
    saida: arg(argv, 'saida') ?? null,
    motivo: arg(argv, 'motivo') ?? null,
    imagem: arg(argv, 'imagem') ?? null,
    readyz: arg(argv, 'readyz') ?? null,
    log: arg(argv, 'log') ?? null,
    desfazerEfeito: flag(argv, 'desfazer-efeito'),
    amostras: Number.isFinite(amostras) && amostras > 0 ? amostras : 10,
  };
}

/**
 * Resolve a connection string a partir do NOME que o operador declarou.
 *
 * Três recusas, nesta ordem: nome ambiental → variável ausente → valor
 * ilegível. Nenhuma delas ecoa o valor lido.
 */
export function resolverDsn(dsnEnv: string, env: Record<string, string | undefined>): string {
  if (NOMES_DE_ENV_AMBIENTE.some((n) => n.toLowerCase() === dsnEnv.toLowerCase())) {
    throw new AmbienteRecusadoError(dsnEnv);
  }
  const bruto = env[dsnEnv];
  if (!bruto || bruto.trim() === '') throw new SegredoAusenteError(dsnEnv);
  return bruto.trim();
}

/** Host de um DSN, sem nunca devolver a credencial junto. */
export function hostDoDsn(dsn: string, dsnEnv: string): string {
  try {
    const url = new URL(dsn);
    if (url.hostname === '') throw new Error('sem host');
    return url.hostname;
  } catch {
    throw new DsnIlegivelError(dsnEnv);
  }
}

/** O rótulo declarado tem de bater com o host resolvido, nos dois sentidos. */
export function verificarCoerenciaDeAlvo(alvo: Alvo, host: string): void {
  const ehLocal = HOSTS_LOCAIS.includes(host.toLowerCase());
  if (alvo === 'local' && !ehLocal) throw new AlvoIncoerenteError(alvo, host);
  if (alvo === 'staging' && ehLocal) throw new AlvoIncoerenteError(alvo, host);
}

/** Fases que escrevem exigem autorização explícita — e janela, em staging. */
export function verificarAutorizacao(args: DrillArgs): void {
  if (!FASES_QUE_ESCREVEM.includes(args.fase)) return;
  const faltando: string[] = [];
  if (!args.executar) faltando.push('--executar');
  if (args.alvo === 'staging' && (!args.janela || args.janela.trim() === '')) {
    faltando.push('--janela="<data · HH:MM BRT · condutor>"');
  }
  if (faltando.length > 0) throw new SemAutorizacaoError(faltando, args.fase);
}

// ─────────────────────────────────────────────────────────────────────────────
// Isolamento da migration quebrada
// ─────────────────────────────────────────────────────────────────────────────

/** Nomes de arquivo do drill que NUNCA podem existir em `migrations/`. */
export function arquivosDoDrill(): readonly string[] {
  return [MIGRATION_QUEBRADA, MIGRATION_QUEBRADA.replace(/\.sql$/, '_down.sql')];
}

/**
 * Aborta se qualquer arquivo do drill estiver em `migrations/`.
 *
 * Roda antes de tudo, inclusive antes de abrir conexão, e inclusive nas fases
 * read-only: se a fixture vazou, o que o `status` reporta já está contaminado.
 * A varredura é por nome exato E por padrão (`drill.*705`), porque um vazamento
 * renomeado continua sendo um vazamento.
 */
export async function assertFixtureNaoVazou(migrationsDir: string): Promise<void> {
  const nomes = await readdir(migrationsDir);
  const exatos = new Set(arquivosDoDrill());
  const suspeitos = nomes.filter((n) => exatos.has(n) || /drill.{0,3}705/i.test(n));
  if (suspeitos.length > 0) throw new FixtureVazouError(suspeitos.sort());
}

export interface Overlay {
  readonly dir: string;
  readonly copiados: number;
  readonly fixtures: readonly string[];
}

/**
 * Monta o diretório EFÊMERO que o runner vai enxergar durante a fase `quebrar`.
 *
 * Cópia, não symlink, e não escrita em `migrations/`. O diretório nasce em
 * `os.tmpdir()` via `mkdtemp` (nome imprevisível, sem colisão entre worktrees)
 * e é removido em `finally` pelo chamador.
 *
 * A função RECUSA montar dentro do repositório: um overlay sob a árvore de
 * trabalho seria um vazamento com outro nome — `git status` o mostraria, e um
 * `git add -A` distraído o commitaria.
 */
export async function montarOverlay(opts: {
  readonly migrationsDir: string;
  readonly fixturesDir: string;
  readonly baseTmp: string;
  readonly raizDoRepo: string;
}): Promise<Overlay> {
  const dir = await mkdtemp(join(opts.baseTmp, 'maia-drill-705-'));
  if (resolve(dir).startsWith(resolve(opts.raizDoRepo))) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(
      'drill-705: o overlay cairia dentro do repositório — recusado. ' +
        'Aponte TMPDIR para fora da árvore de trabalho.',
    );
  }

  let copiados = 0;
  for (const nome of await readdir(opts.migrationsDir)) {
    if (!nome.endsWith('.sql')) continue;
    await copyFile(join(opts.migrationsDir, nome), join(dir, nome));
    copiados += 1;
  }

  const fixtures: string[] = [];
  for (const nome of await readdir(opts.fixturesDir)) {
    if (!nome.endsWith('.sql')) continue;
    await copyFile(join(opts.fixturesDir, nome), join(dir, nome));
    fixtures.push(nome);
  }

  return { dir, copiados, fixtures: fixtures.sort() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Coleta de evidência
// ─────────────────────────────────────────────────────────────────────────────

export interface DrillDeps {
  readonly env: Record<string, string | undefined>;
  readonly log: (linha: string) => void;
  readonly erro: (linha: string) => void;
  readonly criarPool: (dsn: string) => PoolDoDrill;
  readonly agora: () => Date;
  readonly raizDoRepo: string;
  readonly baseTmp: string;
  readonly buscar: (url: string) => Promise<{ status: number; corpo: string }>;
}

/**
 * O mínimo que o drill precisa de um pool — e o que `pg.Pool` já satisfaz
 * estruturalmente (é assim que `scripts/migrate.ts` o passa ao runner). Declarar
 * a interface em vez de aceitar `pg.Pool` é o que permite ao teste da trava
 * injetar um pool FALSO e provar que ele nunca é criado antes do portão.
 */
export type PoolDoDrill = RunnerPool & { end(): Promise<void> };

/** `RunnerPoolClient` e `ReadOnlyPoolClient` são a MESMA forma; isto documenta. */
const _poolDoDrillTambemServeParaLeitura = (p: PoolDoDrill): ReadOnlyPool => p;
void _poolDoDrillTambemServeParaLeitura;

/**
 * Grava um registro de evidência já SANITIZADO. Nada é escrito por outro
 * caminho — o item 6 da #705 pede logs sanitizados, e um `writeFile` cru em
 * qualquer lugar deste arquivo derrubaria a garantia.
 */
async function gravarEvidencia(
  dirSaida: string,
  nome: string,
  corpo: unknown,
  log: (l: string) => void,
): Promise<string> {
  await mkdir(dirSaida, { recursive: true });
  const caminho = join(dirSaida, nome);
  await writeFile(caminho, `${jsonSanitizado(corpo)}\n`, 'utf8');
  log(`evidência gravada: ${caminho}`);
  return caminho;
}

function dirDeSaidaPadrao(baseTmp: string, agora: Date): string {
  const carimbo = agora.toISOString().replace(/[:.]/g, '-');
  return join(baseTmp, `drill-705-evidencias-${carimbo}`);
}

/** Só a CLASSE do erro. A mensagem de um erro do `pg` embute o DSN com senha. */
function classeDoErro(err: unknown): string {
  if (typeof (err as { code?: unknown } | null)?.code === 'string') {
    return String((err as { code: string }).code);
  }
  return err instanceof Error ? err.constructor.name : 'UnknownError';
}

// ─────────────────────────────────────────────────────────────────────────────
// Fases
// ─────────────────────────────────────────────────────────────────────────────

/** O roteiro literal da janela. Não toca em nada — nem no banco, nem no disco. */
export function textoDoRoteiro(args: DrillArgs): string[] {
  const alvoFlag = `--alvo=${args.alvo} --dsn-env=${args.dsnEnv}`;
  const janela = args.alvo === 'staging' ? ' --janela="<data · HH:MM BRT · condutor>"' : '';
  return [
    '# Drill de migration — issue #705. Ordem de execução da janela.',
    '# Preencha docs/runbooks/drill-705-gabarito-de-coleta.md À MEDIDA que roda,',
    '# não depois. Cole a saída de cada passo no campo correspondente.',
    '',
    '# 0) o alvo é declarado, nunca herdado. Exporte um nome PRÓPRIO:',
    `#    export ${args.dsnEnv}='postgres://<usuario>:<senha>@<host>:<porta>/<banco>'`,
    '',
    '# 1) EVIDÊNCIAS 1 e 5 — contexto: quem, onde, qual imagem, qual head',
    `tsx scripts/drill-migration-705.ts --fase=contexto ${alvoFlag} \\`,
    '     --imagem=<tag-ou-sha-da-imagem-exercitada> --saida=<dir>',
    '',
    '# 2) EVIDÊNCIA 2 — a migration que FALHA (escreve; exige --executar)',
    `tsx scripts/drill-migration-705.ts --fase=quebrar ${alvoFlag} --executar${janela} \\`,
    '     --saida=<dir>',
    '#    esperado: exit 0 com ledger dirty registrado. exit 20 = O GATE NÃO EXISTE.',
    '',
    '# 3) EVIDÊNCIA 2 (lado app) — /readyz do app NOVO tem de ficar fora de prontidão',
    `tsx scripts/drill-migration-705.ts --fase=verificar ${alvoFlag} \\`,
    '     --readyz=https://<staging>/readyz --amostras=<n> --saida=<dir>',
    '',
    '# 4) EVIDÊNCIA 3 — recuperação, cronometrada (escreve; exige --executar)',
    `tsx scripts/drill-migration-705.ts --fase=reparar ${alvoFlag} --executar${janela} \\`,
    '     --desfazer-efeito --motivo="<o que voce conferiu no schema>" --saida=<dir>',
    '',
    '# 5) EVIDÊNCIA 4 — rollback do DEPLOY (manual, no painel; nada aqui executa down)',
    '#    reverta a versão do app; NÃO rode nenhum _down.sql automaticamente;',
    '#    confirme que a aplicação ANTERIOR sobe sobre o schema resultante e',
    `tsx scripts/drill-migration-705.ts --fase=contexto ${alvoFlag} --saida=<dir>`,
    '#    (o ledger v2 continua legível: é o próprio status acima que prova)',
    '',
    '# 6) EVIDÊNCIA 6 — sanitização, ANTES de colar qualquer log na issue',
    `tsx scripts/drill-migration-705.ts --fase=sanitizar ${alvoFlag} \\`,
    '     --log=<arquivo-de-log-bruto> --saida=<dir>',
    '',
    '# 7) EVIDÊNCIA 7 — decisão do dono. Não há comando. É humana, e é a issue.',
  ];
}

async function faseContexto(
  args: DrillArgs,
  deps: DrillDeps,
  pool: PoolDoDrill,
  migrationsDir: string,
  dirSaida: string,
): Promise<number> {
  const inspecao = { pool, migrationsDir };
  const status = await getMigrationStatus(inspecao);
  const readiness = await getSchemaReadiness(inspecao);

  const registro = {
    evidencia: ['1 (execução em staging)', '5 (versão testada)'],
    fase: args.fase,
    alvo_declarado: args.alvo,
    dsn_env: args.dsnEnv,
    janela_declarada: args.janela,
    imagem_declarada: args.imagem,
    coletado_em: deps.agora().toISOString(),
    ledger_presente: status.ledger_present,
    ledger_versao: status.ledger_version,
    expected_head: status.expected_head,
    applied_head: status.applied_head,
    contagens: status.counts,
    readiness_estado: readiness.state,
    readiness_pronto: readiness.ready,
    readiness_motivo: readiness.reason,
    blockers: readiness.blockers.map((b) => ({ kind: b.kind, detalhe: b.detail })),
  };

  deps.log(
    `contexto · expected_head=${status.expected_head ?? 'none'} · ` +
      `applied_head=${status.applied_head ?? 'none'} · readiness=${readiness.state} ` +
      `(pronto=${readiness.ready})`,
  );
  for (const b of readiness.blockers) deps.erro(`  BLOCKER ${b.kind}: ${b.detail}`);
  await gravarEvidencia(dirSaida, 'e1-e5-contexto.json', registro, deps.log);
  return 0;
}

async function faseQuebrar(
  args: DrillArgs,
  deps: DrillDeps,
  pool: PoolDoDrill,
  migrationsDir: string,
  dirSaida: string,
): Promise<number> {
  const overlay = await montarOverlay({
    migrationsDir,
    fixturesDir: join(deps.raizDoRepo, DIR_FIXTURES),
    baseTmp: deps.baseTmp,
    raizDoRepo: deps.raizDoRepo,
  });
  deps.log(
    `overlay efêmero em ${overlay.dir} · ${overlay.copiados} migrations reais + ` +
      `${overlay.fixtures.length} fixture(s) do drill`,
  );

  const eventos: Array<Record<string, unknown>> = [];
  const inicio = deps.agora();
  let resultado: MigrationRunResult;
  let readinessComoImagemQuebrada: SchemaReadiness | undefined;
  try {
    const runnerDeps: RunnerDeps = {
      pool,
      migrationsDir: overlay.dir,
      onEvent: (evento, detalhe) => {
        eventos.push({ evento, ...detalhe });
        deps.log(sanitizarTexto(JSON.stringify({ evento, ...detalhe })));
      },
    };
    resultado = await runMigrations(runnerDeps, {});
    // DOIS vereditos de readiness, e a diferença entre eles importa demais para
    // ficar implícita no gabarito:
    //
    //   - contra o OVERLAY: é o que uma imagem que REALMENTE empacotasse a
    //     migration quebrada veria. O blocker sai como `dirty_migration` — a
    //     forma que um release quebrado de verdade produz;
    //   - contra `migrations/` REAL (abaixo): é o que a imagem desta build vê.
    //     A linha do ledger existe para uma migration que ela não empacota, e
    //     o blocker sai como `missing_file`.
    //
    // Os dois reprovam fail-closed, que é o invariante sob teste. Registrar só
    // um deles faria o gabarito afirmar mais do que o drill provou.
    readinessComoImagemQuebrada = await getSchemaReadiness({
      pool,
      migrationsDir: overlay.dir,
    });
  } finally {
    await rm(overlay.dir, { recursive: true, force: true });
    deps.log(`overlay removido: ${overlay.dir}`);
  }
  const fim = deps.agora();

  const readiness = await getSchemaReadiness({ pool, migrationsDir });

  const linhaQuebrada = resultado.status?.entries.find((e) => e.id === MIGRATION_QUEBRADA);
  const ficouSuja = linhaQuebrada?.state === 'dirty' || resultado.failure?.ledger_status === 'dirty';

  const registro = {
    evidencia: ['2 (migration que FALHA impede o app novo de iniciar)'],
    fase: args.fase,
    alvo_declarado: args.alvo,
    janela_declarada: args.janela,
    migration_quebrada: MIGRATION_QUEBRADA,
    overlay_efemero: overlay.dir,
    overlay_migrations_reais: overlay.copiados,
    iniciado_em: inicio.toISOString(),
    terminado_em: fim.toISOString(),
    duracao_ms: fim.getTime() - inicio.getTime(),
    runner_ok: resultado.ok,
    runner_outcome: resultado.outcome,
    aplicadas_nesta_rodada: resultado.applied,
    falha_ledger_status: resultado.failure?.ledger_status ?? null,
    falha_migration_id: resultado.failure?.id ?? null,
    falha_classe: resultado.failure?.error_class ?? null,
    estado_da_linha_quebrada: linhaQuebrada?.state ?? null,
    ficou_dirty: ficouSuja,
    eventos_do_runner: eventos,
    // veredito que a IMAGEM DESTA BUILD vê (artefato = migrations/ real)
    readiness_apos_falha_estado: readiness.state,
    readiness_apos_falha_pronto: readiness.ready,
    readiness_apos_falha_blockers: readiness.blockers.map((b) => ({
      kind: b.kind,
      detalhe: b.detail,
    })),
    // veredito que uma imagem que EMPACOTASSE a migration quebrada veria
    readiness_como_imagem_quebrada_estado: readinessComoImagemQuebrada?.state ?? null,
    readiness_como_imagem_quebrada_pronto: readinessComoImagemQuebrada?.ready ?? null,
    readiness_como_imagem_quebrada_blockers:
      readinessComoImagemQuebrada?.blockers.map((b) => ({ kind: b.kind, detalhe: b.detail })) ??
      null,
  };
  await gravarEvidencia(dirSaida, 'e2-migration-que-falha.json', registro, deps.log);

  if (resultado.ok) {
    deps.erro('');
    deps.erro('  ┌────────────────────────────────────────────────────────────────┐');
    deps.erro('  │ A MIGRATION QUEBRADA NÃO FALHOU. O GATE NÃO EXISTE.            │');
    deps.erro('  │ Isto é um ACHADO do drill — registre-o no gabarito e PARE.     │');
    deps.erro('  └────────────────────────────────────────────────────────────────┘');
    return 20;
  }
  if (readiness.ready || readinessComoImagemQuebrada?.ready === true) {
    deps.erro('');
    deps.erro('  A migration falhou, MAS a readiness de schema segue verde.');
    deps.erro('  O app novo receberia tráfego sobre schema quebrado. ACHADO — registre e PARE.');
    return 20;
  }
  deps.log(
    `esperado: runner outcome=${resultado.outcome} · ledger dirty=${ficouSuja} · ` +
      `readiness(imagem desta build)=${readiness.state} · ` +
      `readiness(imagem que empacota a quebrada)=${readinessComoImagemQuebrada?.state ?? 'n/d'}`,
  );
  return 0;
}

async function faseVerificar(
  args: DrillArgs,
  deps: DrillDeps,
  pool: PoolDoDrill,
  migrationsDir: string,
  dirSaida: string,
): Promise<number> {
  const readiness = await getSchemaReadiness({ pool, migrationsDir });

  const amostras: Array<Record<string, unknown>> = [];
  if (args.readyz) {
    for (let i = 0; i < args.amostras; i += 1) {
      const em = deps.agora().toISOString();
      try {
        const r = await deps.buscar(args.readyz);
        amostras.push({ em, http_status: r.status, resposta_sanitizada: sanitizarTexto(r.corpo) });
        deps.log(`  /readyz [${i + 1}/${args.amostras}] ${em} → HTTP ${r.status}`);
      } catch (err) {
        amostras.push({ em, erro_classe: classeDoErro(err) });
        deps.log(`  /readyz [${i + 1}/${args.amostras}] ${em} → erro (${classeDoErro(err)})`);
      }
    }
  } else {
    deps.erro(
      'aviso: sem --readyz=<url> esta fase registra apenas o veredito de schema do ' +
        'banco. A #705 pede o /readyz do app NOVO — passe a URL.',
    );
  }

  const vermelhas = amostras.filter((a) => a['http_status'] !== 200);
  const registro = {
    evidencia: ['2 (readiness fora de prontidão)', '3 (quanto tempo ficou vermelho)'],
    fase: args.fase,
    alvo_declarado: args.alvo,
    readyz_url: args.readyz,
    coletado_em: deps.agora().toISOString(),
    readiness_estado: readiness.state,
    readiness_pronto: readiness.ready,
    readiness_blockers: readiness.blockers.map((b) => ({ kind: b.kind, detalhe: b.detail })),
    amostras_readyz: amostras,
    amostras_total: amostras.length,
    amostras_nao_200: vermelhas.length,
    primeira_amostra_em: amostras[0]?.['em'] ?? null,
    ultima_amostra_em: amostras[amostras.length - 1]?.['em'] ?? null,
  };
  await gravarEvidencia(dirSaida, 'e2-e3-readiness.json', registro, deps.log);
  return 0;
}

async function faseReparar(
  args: DrillArgs,
  deps: DrillDeps,
  pool: PoolDoDrill,
  migrationsDir: string,
  dirSaida: string,
): Promise<number> {
  if (!args.motivo || args.motivo.trim() === '') {
    throw new RequiredArgsError(['--motivo="<o que voce conferiu no schema>"']);
  }

  const inicio = deps.agora();
  let efeitoDesfeito: string | null = null;
  if (args.desfazerEfeito) {
    const down = join(
      deps.raizDoRepo,
      DIR_FIXTURES,
      MIGRATION_QUEBRADA.replace(/\.sql$/, '_down.sql'),
    );
    const sql = await readFile(down, 'utf8');
    const cliente = await pool.connect();
    try {
      await cliente.query(sql);
      efeitoDesfeito = basename(down);
      deps.log(`efeito parcial desfeito com ${efeitoDesfeito}`);
    } finally {
      cliente.release();
    }
  } else {
    deps.erro(
      'aviso: sem --desfazer-efeito o efeito parcial (tabela drill_705_marcador) ' +
        'permanece. Desfaça-o antes de marcar o ledger.',
    );
  }

  // `--as pending` e nunca `--as applied`: este build NÃO empacota a fixture, e
  // `repairAppliedRefusal` recusaria — corretamente. `pending` APAGA a linha do
  // ledger, que é o que tira o `missing_file` do caminho da readiness.
  const reparo = await repairMigration(
    { pool, migrationsDir },
    { id: MIGRATION_QUEBRADA, outcome: 'pending', reason: args.motivo },
  );
  const fim = deps.agora();

  const readiness = await getSchemaReadiness({ pool, migrationsDir });
  const registro = {
    evidencia: ['3 (recuperação, com repair auditável e quanto tempo levou)'],
    fase: args.fase,
    alvo_declarado: args.alvo,
    janela_declarada: args.janela,
    migration_quebrada: MIGRATION_QUEBRADA,
    efeito_parcial_desfeito_por: efeitoDesfeito,
    motivo_do_repair: args.motivo,
    reparo_ok: reparo.ok,
    reparo_recusa: reparo.ok ? null : reparo.reason,
    iniciado_em: inicio.toISOString(),
    terminado_em: fim.toISOString(),
    duracao_ms: fim.getTime() - inicio.getTime(),
    readiness_apos_reparo_estado: readiness.state,
    readiness_apos_reparo_pronto: readiness.ready,
    readiness_apos_reparo_blockers: readiness.blockers.map((b) => ({
      kind: b.kind,
      detalhe: b.detail,
    })),
  };
  await gravarEvidencia(dirSaida, 'e3-recuperacao.json', registro, deps.log);

  if (!reparo.ok) {
    deps.erro(`repair recusado: ${reparo.reason}`);
    return 1;
  }
  deps.log(
    `recuperado em ${fim.getTime() - inicio.getTime()}ms · ` +
      `readiness=${readiness.state} (pronto=${readiness.ready})`,
  );
  return readiness.ready ? 0 : 1;
}

async function faseSanitizar(
  args: DrillArgs,
  deps: DrillDeps,
  dirSaida: string,
): Promise<number> {
  if (!args.log) throw new RequiredArgsError(['--log=<arquivo-de-log-bruto>']);
  const bruto = await readFile(args.log, 'utf8');
  const limpo = sanitizarTexto(bruto);
  await mkdir(dirSaida, { recursive: true });
  const destino = join(dirSaida, 'e6-log-sanitizado.txt');
  await writeFile(destino, limpo, 'utf8');

  // Idempotência é a prova de que passou: rodar o filtro de novo não muda nada.
  const estavel = sanitizarTexto(limpo) === limpo;
  const registro = {
    evidencia: ['6 (logs sanitizados)'],
    fase: args.fase,
    origem: args.log,
    destino,
    bytes_entrada: Buffer.byteLength(bruto, 'utf8'),
    bytes_saida: Buffer.byteLength(limpo, 'utf8'),
    houve_redacao: limpo !== bruto,
    filtro_idempotente: estavel,
    filtro: 'tests/reliability/harness/sanitize.ts (allowlist da #510, não afrouxada)',
  };
  await gravarEvidencia(dirSaida, 'e6-sanitizacao.json', registro, deps.log);
  deps.log(`log sanitizado em ${destino} (redação aplicada: ${limpo !== bruto})`);
  return estavel ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrada
// ─────────────────────────────────────────────────────────────────────────────

export function depsPadrao(): DrillDeps {
  return {
    env: process.env,
    log: (l) => console.log(l),
    erro: (l) => console.error(l),
    criarPool: (dsn) => new pg.Pool({ connectionString: dsn }) as unknown as PoolDoDrill,
    agora: () => new Date(),
    raizDoRepo: process.cwd(),
    baseTmp: tmpdir(),
    buscar: async (url) => {
      const r = await fetch(url);
      return { status: r.status, corpo: await r.text() };
    },
  };
}

/**
 * Devolve o código de saída; NUNCA chama `process.exit`. Quem escolhe morrer é
 * o bloco de entrada lá embaixo, e só quando este arquivo é o entrypoint.
 *
 * A ordem dos portões é deliberada e está sob teste: argumentos → alvo
 * conhecido → nome de env não-ambiental → segredo presente → DSN legível →
 * coerência de alvo → autorização de escrita → fixture não vazou → SÓ ENTÃO
 * `criarPool`. Nenhuma conexão é aberta antes do último portão.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: DrillDeps = depsPadrao(),
): Promise<number> {
  let args: DrillArgs;
  try {
    args = parseDrillArgs(argv);
    verificarAutorizacao(args);
  } catch (err) {
    if (
      err instanceof RequiredArgsError ||
      err instanceof ValorDesconhecidoError ||
      err instanceof SemAutorizacaoError
    ) {
      deps.erro(err.message);
      imprimirUso(deps.erro);
      return 2;
    }
    throw err;
  }

  let dsn: string;
  try {
    dsn = resolverDsn(args.dsnEnv, deps.env);
    verificarCoerenciaDeAlvo(args.alvo, hostDoDsn(dsn, args.dsnEnv));
  } catch (err) {
    if (err instanceof AlvoIncoerenteError) {
      deps.erro(err.message);
      return 3;
    }
    if (
      err instanceof AmbienteRecusadoError ||
      err instanceof SegredoAusenteError ||
      err instanceof DsnIlegivelError
    ) {
      deps.erro(err.message);
      imprimirUso(deps.erro);
      return 2;
    }
    throw err;
  }

  const migrationsDir = join(deps.raizDoRepo, 'migrations');
  try {
    await assertFixtureNaoVazou(migrationsDir);
  } catch (err) {
    if (err instanceof FixtureVazouError) {
      deps.erro(err.message);
      return 4;
    }
    throw err;
  }

  const dirSaida = args.saida ?? dirDeSaidaPadrao(deps.baseTmp, deps.agora());

  if (args.fase === 'roteiro') {
    for (const linha of textoDoRoteiro(args)) deps.log(linha);
    return 0;
  }
  if (args.fase === 'sanitizar') {
    return faseSanitizar(args, deps, dirSaida);
  }

  const pool = deps.criarPool(dsn);
  try {
    switch (args.fase) {
      case 'contexto':
        return await faseContexto(args, deps, pool, migrationsDir, dirSaida);
      case 'quebrar':
        return await faseQuebrar(args, deps, pool, migrationsDir, dirSaida);
      case 'verificar':
        return await faseVerificar(args, deps, pool, migrationsDir, dirSaida);
      case 'reparar':
        return await faseReparar(args, deps, pool, migrationsDir, dirSaida);
      default:
        deps.erro(`drill-705: fase "${args.fase as string}" sem implementação.`);
        return 1;
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function imprimirUso(erro: (l: string) => void): void {
  erro('');
  erro('  uso: tsx scripts/drill-migration-705.ts \\');
  erro(`         --fase=<${FASES.join('|')}> \\`);
  erro(`         --alvo=<${ALVOS.join('|')}> \\`);
  erro('         --dsn-env=<NOME_DA_VARIAVEL_COM_A_CONNECTION_STRING>');
  erro('');
  erro('  Obrigatórios: --fase, --alvo, --dsn-env. NENHUM tem default.');
  erro(`  --dsn-env RECUSA nomes ambientais (${NOMES_DE_ENV_AMBIENTE.join(', ')}):`);
  erro('  o drill não herda alvo de um terminal. Exporte um nome próprio, ex.:');
  erro("    export DRILL_705_DSN='postgres://<usuario>:<senha>@<host>:<porta>/<banco>'");
  erro('');
  erro(`  Fases que ESCREVEM (${FASES_QUE_ESCREVEM.join(', ')}) exigem --executar,`);
  erro('  e --janela="<data · HH:MM BRT · condutor>" quando --alvo=staging.');
  erro('');
  erro('  Roteiro completo da janela: --fase=roteiro (não toca em nada).');
  erro('  Gabarito: docs/runbooks/drill-705-gabarito-de-coleta.md');
}

/**
 * Só executa quando este arquivo É o entrypoint. Mesma checagem de
 * `scripts/migrate.ts` e `scripts/import-ofx.ts`, e pelo mesmo motivo: um
 * `import` vindo de um teste não pode disparar `main()` nem abrir conexão.
 */
export function isDirectInvocation(entry: string | undefined, metaUrl: string): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url) && !process.env.DRILL_705_NO_MAIN) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // CLASSE apenas: a mensagem de um erro do `pg` embute a connection string
      // com senha, e este script existe para não vazar alvo.
      console.error(`drill-705: falha inesperada (${classeDoErro(err)})`);
      process.exitCode = 1;
    },
  );
}
