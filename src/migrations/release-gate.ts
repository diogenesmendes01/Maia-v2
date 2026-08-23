/**
 * Release gate — o job one-shot da #516 para orquestradores SEM
 * `service_completed_successfully` (issue #565).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que a #516 comprou, e o que se perde fora do Compose
 * ─────────────────────────────────────────────────────────────────────────
 * `compose.prod.yml` monta o gate com três garantias:
 *
 *   1. o job roda as migrations UMA vez e sai 0 em sucesso / != 0 em falha;
 *   2. ele recebe APENAS o subset `migrator` do contrato (#515) — sem
 *      `.env.app`, portanto sem chave de LLM, sessão de WhatsApp ou
 *      credencial S3;
 *   3. `app`/`admin-ui` não sobem enquanto ele não terminar com sucesso.
 *
 * As três são propriedades do ARQUIVO: (1) é `restart: "no"` + os exit codes
 * de `scripts/migrate.ts`, (2) é a AUSÊNCIA de `env_file:` no serviço, (3) é
 * `depends_on: { migrate: { condition: service_completed_successfully } }`.
 *
 * `service_completed_successfully` é primitiva do Compose e não existe fora
 * dele. Num painel que faz build por Dockerfile e injeta UM conjunto de
 * variáveis em TODO container da aplicação (Coolify é assim — duas
 * aplicações, `docs/admin-ui-deploy.md`), a garantia (2) some por construção:
 * não há como "não passar" o env — o passo de migration nasce dentro do
 * ambiente completo da aplicação. É esse buraco que este módulo tapa.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que este módulo faz, e o que ele NÃO pode fazer
 * ─────────────────────────────────────────────────────────────────────────
 * FAZ, e é verificável nesta árvore:
 *
 *   - executa EXATAMENTE o mesmo comando do job do Compose
 *     (`MIGRATE_COMMAND`, pinado contra `compose.prod.yml` em
 *     `tests/unit/migrations/release-gate.spec.ts`);
 *   - entrega ao migrator SÓ o subset `migrator` do contrato mais um
 *     punhado de variáveis de PROCESSO (`PROCESS_PASSTHROUGH`) — tudo o mais
 *     é retido, e o que foi retido é REPORTADO por nome (nunca por valor);
 *   - propaga o exit code do migrator sem alterá-lo, e devolve != 0 em
 *     qualquer caminho de erro próprio (spawn que falha, morte por sinal,
 *     código fora da faixa). 0 sai daqui por um caminho só: o migrator saiu 0.
 *
 * NÃO FAZ, e nenhuma linha de teste pode fingir que faz: **fazer o
 * orquestrador honrar esse exit code**. Quem decide não subir o app é o
 * painel (campo de comando pré-deploy) ou o shell que encadeia
 * `gate && exec <app>`. O segundo é demonstrável aqui — um `&&` é semântica
 * de shell, e `tests/integration/release-migrate-gate.spec.ts` prova que o
 * consumidor encadeado NÃO roda quando o gate falha. O primeiro depende de
 * uma instância do painel e está marcado como NÃO VERIFICADO em
 * `docs/runbooks/deploy-prod.md` §7.
 *
 * PURO: nada aqui lê disco, rede ou `process.env`. Quem tem efeito é
 * `scripts/release-migrate.ts`.
 */
import { CONTRACT_ENTRIES, entriesForService, isUnknownMaiaKey } from '@/config/contract.js';

/**
 * O comando do job, byte a byte o mesmo `command:` de
 * `compose.prod.yml` → `services.migrate`. Se os dois divergirem, o gate
 * fora do Compose deixa de ser o job do Compose e vira outra coisa parecida
 * — que é exatamente o modo de falha que a #565 existe para evitar. O spec
 * lê os dois e compara.
 */
export const MIGRATE_COMMAND: readonly string[] = Object.freeze(['npm', 'run', 'db:migrate']);

/**
 * Variáveis de PROCESSO que atravessam o filtro.
 *
 * O migrator do Compose recebe estas da IMAGEM (PATH/HOME vêm do
 * `node:22-alpine`), não do `environment:` — por isso elas não estão no
 * contrato e mesmo assim precisam existir. Sem `PATH` não há `npm`; sem
 * `HOME`/`npm_config_cache` o npm tenta escrever cache num rootfs read-only.
 *
 * A lista é fechada de propósito. Duas ausências deliberadas:
 *
 *   - `NODE_OPTIONS` — permite injetar `--require` no processo que aplica
 *     DDL. Um passo de migration não é lugar para carregar código que o
 *     painel injetou;
 *   - `npm_config_*` em geral — só `npm_config_cache` passa. As demais podem
 *     carregar credencial de registry (`npm_config_//registry/:_authToken`),
 *     e o migrator não instala nada.
 */
export const PROCESS_PASSTHROUGH: readonly string[] = Object.freeze([
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'PWD',
  'TERM',
  'TMPDIR',
  'npm_config_cache',
]);

/** O que o migrator vai receber, e o que ficou de fora — só nomes. */
export interface ScrubReport {
  /** O ambiente do processo filho. Único lugar deste módulo com valores. */
  readonly env: Readonly<Record<string, string>>;
  /** Nomes entregues, ordenados. */
  readonly passed: readonly string[];
  /**
   * Nomes RETIDOS que o contrato declara para algum outro serviço — a lista
   * acionável: são segredos de `app`/`admin-ui` que chegaram ao passo de
   * migration porque o painel injeta um ambiente só.
   */
  readonly withheldContract: readonly string[];
  /**
   * Nomes RETIDOS no namespace `MAIA_*`/`FEATURE_*` que o contrato NÃO
   * declara. Categoria própria porque o silêncio aqui custaria caro: se essa
   * variável tivesse chegado ao migrator, `validate.ts` (regra
   * `contract/unknown`) o faria recusar o boot — ou seja, é ou um erro de
   * digitação numa configuração que o operador acha ativa, ou uma variável
   * que alguém adicionou sem declarar. O gate a retém, e por isso mesmo tem
   * de NOMEÁ-LA: retenção silenciosa transformaria um erro de configuração
   * gritante num deploy verde.
   */
  readonly withheldUnknownMaia: readonly string[];
  /** Quantos outros nomes foram retidos (ruído de processo, npm_*, etc.). */
  readonly withheldOther: number;
}

const MIGRATOR_NAMES: ReadonlySet<string> = new Set(entriesForService('migrator').map((s) => s.name));
const CONTRACT_NAMES: ReadonlySet<string> = new Set(CONTRACT_ENTRIES.map((s) => s.name));
const PASSTHROUGH_NAMES: ReadonlySet<string> = new Set(PROCESS_PASSTHROUGH);

/**
 * Reduz um ambiente qualquer ao que o migrator pode ler.
 *
 * Allowlist, nunca denylist: uma variável nova em `.env.app` não precisa ser
 * lembrada aqui para ficar de fora — ela já está de fora. O contrário (uma
 * lista do que bloquear) só protege contra o que alguém previu.
 */
export function scrubToMigratorSubset(
  source: Readonly<Record<string, string | undefined>>,
): ScrubReport {
  const env: Record<string, string> = {};
  const passed: string[] = [];
  const withheldContract: string[] = [];
  const withheldUnknownMaia: string[] = [];
  let withheldOther = 0;

  for (const name of Object.keys(source).sort()) {
    const value = source[name];
    if (value === undefined) continue;
    if (MIGRATOR_NAMES.has(name) || PASSTHROUGH_NAMES.has(name)) {
      env[name] = value;
      passed.push(name);
      continue;
    }
    if (CONTRACT_NAMES.has(name)) withheldContract.push(name);
    else if (isUnknownMaiaKey(name)) withheldUnknownMaia.push(name);
    else withheldOther += 1;
  }

  return { env, passed, withheldContract, withheldUnknownMaia, withheldOther };
}

/** Como o processo filho terminou. */
export type MigratorOutcome =
  | { readonly kind: 'exit'; readonly code: number }
  | { readonly kind: 'signal'; readonly signal: string };

export interface ReleaseGateDeps {
  /** O ambiente bruto do orquestrador (em produção, `process.env`). */
  readonly source: Readonly<Record<string, string | undefined>>;
  /** Executa o comando com o ambiente já filtrado. */
  readonly run: (
    command: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => Promise<MigratorOutcome>;
  /** Linha de log estruturada. Só nomes, códigos e contagens. */
  readonly emit: (event: string, detail: Record<string, unknown>) => void;
}

/** Classe do erro — nunca a mensagem (a de `pg` embute a connection string). */
function errorClass(err: unknown): string {
  if (typeof (err as { code?: unknown } | null)?.code === 'string') return String((err as { code: string }).code);
  return err instanceof Error ? err.constructor.name : 'UnknownError';
}

/**
 * Normaliza o código do filho para a faixa que um processo pode devolver.
 *
 * Fail-closed: só o 0 literal vira 0. Qualquer outra coisa — negativo, NaN,
 * fracionário, > 255 — vira falha. Um gate que arredonde um código
 * inesperado para 0 libera o rollout justamente quando ninguém entendeu o
 * que aconteceu.
 */
export function normalizeExitCode(code: number): number {
  if (!Number.isFinite(code)) return 1;
  const int = Math.trunc(code);
  if (int === 0) return 0;
  if (int < 0 || int > 255) return 1;
  return int;
}

/**
 * Roda o gate. Devolve o exit code que o processo deve adotar.
 *
 * Não lança: um gate que morre por exceção não distingue "falhou" de "não
 * rodou", e as duas coisas têm de bloquear o rollout do mesmo jeito.
 */
export async function runReleaseGate(deps: ReleaseGateDeps): Promise<number> {
  const scrub = scrubToMigratorSubset(deps.source);
  deps.emit('release_gate.env_scrubbed', {
    command: MIGRATE_COMMAND.join(' '),
    passed: scrub.passed,
    withheld_contract: scrub.withheldContract,
    withheld_unknown_maia: scrub.withheldUnknownMaia,
    withheld_other: scrub.withheldOther,
  });

  let outcome: MigratorOutcome;
  try {
    outcome = await deps.run(MIGRATE_COMMAND, scrub.env);
  } catch (err) {
    deps.emit('release_gate.failed', { reason: 'spawn_failed', error_class: errorClass(err) });
    return 1;
  }

  if (outcome.kind === 'signal') {
    // OOM-killer, timeout do painel, `docker stop` no meio do rollout. O
    // schema pode ter ficado pela metade — a única resposta segura é != 0.
    deps.emit('release_gate.failed', { reason: 'killed_by_signal', signal: outcome.signal });
    return 1;
  }

  const code = normalizeExitCode(outcome.code);
  if (code === 0) {
    deps.emit('release_gate.passed', { exit_code: 0 });
    return 0;
  }
  deps.emit('release_gate.failed', { reason: 'migrator_exit', exit_code: code });
  return code;
}
