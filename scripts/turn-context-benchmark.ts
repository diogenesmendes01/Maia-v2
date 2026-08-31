/**
 * Gate de desempenho da carga de contexto do turno — issue #525.
 *
 * ## O que este arquivo é
 *
 * A #525 fechou com o orçamento de round-trips em **13** e a meta em **8**
 * (`TURN_ROUND_TRIP_TARGET`), e o dono condicionou o aceite a uma MEDIÇÃO, não
 * a uma opinião:
 *
 * > "Para #525, 13 ainda não vira orçamento definitivo. O gate deve usar
 * > Postgres real, pool 10, pelo menos 10 tenants concorrentes, braços
 * > cold/warm, zero erros/timeouts, pico por turno ≤6 e p95 de carga de
 * > contexto ≤600 ms e ≤baseline+20%."
 *
 * e, antes disso:
 *
 * > "Para o pool de 10 conexões, o gate será: 50 pares tenant/agente,
 * > concorrência 20, carga representativa com 1/10/100 entidades,
 * > `maia_turn_context_load_duration_ms{phase="loader"}` p95 ≤600 ms, p99 ≤1 s,
 * > zero timeouts e nenhuma saturação contínua do pool por 60 s."
 *
 * Os dois enunciados divergem (10 × 50 pares; o segundo acrescenta
 * concorrência 20 e p99). Este harness implementa o **superconjunto**: 50 pares
 * tenant/agente, concorrência 20, 1/10/100 entidades, braços cold e warm, e
 * mede — em vez de assumir — quantos tenants estiveram DE FATO concorrentes.
 *
 * ## O que ele mede, e o que ele NÃO mede
 *
 *  - **É medição real.** Cada turno chama `buildPrompt` (`src/agent/
 *    prompt-builder.ts`), que é o call site de produção: ele abre o frame do
 *    contador de queries, chama `loadTurnContext` e publica
 *    `maia_turn_context_load_duration_ms{phase="loader"}`. Toda leitura vai ao
 *    Postgres de verdade, pelo pool de verdade (`src/db/client.ts`, `max: 10`),
 *    contra linhas de verdade. Nenhum repositório é substituído por fake — eles
 *    são apenas ENVOLVIDOS por um contador (ver `instrument`), que é o que
 *    permite atribuir cada leitura ao seu turno e medir o pico instantâneo.
 *  - **NÃO é medição de produção.** É um host só, com um Postgres local, sem
 *    latência de rede entre app e banco e sem a carga que o resto do processo
 *    (workers, /metrics, gateway) impõe ao mesmo pool. Os números daqui são o
 *    PISO: em produção a mesma carga custa mais. É por isso que o veredicto
 *    contra o baseline é relativo (+20%) e não só absoluto.
 *  - **NÃO mede o turno inteiro: `resolveScope` fica de FORA.** O orçamento da
 *    #525 (`src/agent/turn-context/types.ts`) define "turno inteiro" como
 *    `resolveScope` + `buildPrompt`, e conta o JOIN `permissoes ⋈
 *    permission_profiles` do `resolveScope` como uma das queries. Este harness
 *    mede só `buildPrompt`: `buildContext` (abaixo) FABRICA o escopo em
 *    memória — monta `byEntity` no processo e nunca chama `resolveScope` — e a
 *    massa não semeia `permissoes` nem `permission_profiles`. Logo o gate
 *    afere um ORÇAMENTO PARCIAL. Um relatório deste harness NÃO é validação do
 *    custo completo do turno, e não deve ser apresentado como tal: uma
 *    regressão que more no `resolveScope` passa por ele sem ser vista. Enquanto
 *    o instrumento não incluir o `resolveScope`, qualquer decisão que dependa
 *    do custo total precisa de uma medição dirigida à parte.
 *
 * Quem citar um número deste harness, cite junto o braço (`cold`/`warm`), a
 * cardinalidade e o host.
 *
 * ## Braços
 *
 * | braço | `FEATURE_TURN_CONTEXT_CACHE` | identidade |
 * |---|---|---|
 * | `cold` | desligado (o default de produção — ver `src/config/generated/fixtures/*.env`) | lida do Postgres em TODO turno |
 * | `warm` | ligado, cache pré-aquecido por par | servida da memória do processo |
 *
 * O braço `cold` é o que o gate defende: é a configuração que roda hoje, e é o
 * pior caso de round-trips. O `warm` existe para quantificar o que o cache vale
 * (exatamente uma query — só o ramo do perfil operacional v2 é cacheável) e
 * para provar que ligá-lo não introduz erro nem estica a cauda.
 *
 * ## Ritmo da carga (`--think-ms`) — e por que ele decide um dos critérios
 *
 * O gerador é de malha FECHADA: `--concurrency` workers, cada um começando o
 * próximo turno assim que o anterior termina. Com `--think-ms 0` isso mantém
 * 20 turnos SEMPRE em voo; como cada turno pode segurar até
 * `TURN_CONTEXT_MAX_CONCURRENT_READS` (6) conexões de um pool de 10, a fila do
 * pool nunca esvazia — por aritmética, não por defeito. Medido neste host
 * (4 vCPU, Postgres local), concorrência 20, braço `cold`:
 *
 * | `--think-ms` | turnos/s | p50 | p95 | amostras do pool saturadas | maior sequência |
 * |---|---|---|---|---|---|
 * | 0   | 90,7  | 187,7 ms | 386,8 ms | 142/142 (100%) | toda a corrida |
 * | 50  | 110,8 | 119,3 ms | 163,0 ms | 143/143 (100%) | toda a corrida |
 * | 150 | 102,1 | 28,8 ms  | 108,7 ms | 99/145 (68%)   | 1,3 s |
 * | 300 | 60,0  | 14,5 ms  | 87,1 ms  | 27/149 (18%)   | 0,3 s |
 * | 600 | 30,9  | 12,7 ms  | 169,8 ms | 18/152 (12%)   | 0,3 s |
 *
 * Duas leituras saem daí. A primeira: o martelo (`0`) entrega MENOS vazão que o
 * ritmo de 150 ms (90,7 contra 102,1 turnos/s) e um p50 6,5× pior — passado o
 * joelho da capacidade, a fila só acrescenta espera. A segunda: o critério
 * "nenhuma saturação contínua do pool por 60 s" NÃO é falsificável em malha
 * fechada sem ritmo, e o default de 150 ms existe para que ele meça o pool em
 * vez de medir a ausência de pausa.
 *
 * ## Os dois perfis, e o que se mede em cada um
 *
 * O dono resolveu a aritmética acima separando os perfis:
 *
 * > "Concorrência 20 continua como máximo de requisições em voo, mas o perfil
 * > normal deve definir ritmo/`think_ms`. O perfil sem ritmo passa a ser teste
 * > de saturação; nele, exige-se zero erros/timeouts e drenagem depois que o
 * > produtor para — não drenagem enquanto 20 turnos são repostos
 * > continuamente."
 *
 * | perfil | como se roda | critério de drenagem |
 * |---|---|---|
 * | normal | `--think-ms 150` (default) | a fila esvazia DURANTE a carga e nunca fica saturada por 60 s seguidos |
 * | saturação | `--think-ms 0` | a fila esvazia DEPOIS que o produtor para. Zero erros/timeouts continua valendo |
 *
 * Por isso toda corrida passou a ter duas FASES: carga (produtor emitindo) e
 * escoamento (produtor parado, `--drain-window-ms`). O amostrador marca a
 * fronteira por timestamp e contabiliza as amostras de cada lado — sem essa
 * janela não existe fase de escoamento para observar, porque o gerador é de
 * malha fechada e todo turno já terminou quando os workers retornam.
 *
 * ## Medir e barrar são coisas diferentes (`--mode`)
 *
 * Este harness faz as duas, e misturá-las produziu o defeito que a review do
 * dono apontou: sem baseline registrado — o estado GARANTIDO de todo checkout
 * limpo, já que o arquivo não é versionado — o critério obrigatório saía
 * `passed: true` e a corrida saía com exit 0. O operador lia "gate passou" onde
 * o gate não tinha avaliado um dos seus critérios.
 *
 * O modo é declarado, não deduzido de uma flag no meio do comando:
 *
 * | `--mode` | o que é | exit code |
 * |---|---|---|
 * | `gate` (default) | o veredicto. Um critério NÃO AVALIADO reprova | 0 · 1 · 2 |
 * | `measure` | medição absoluta. NÃO emite veredicto de gate, e o relatório diz isso em caixa alta | 0 · 2 |
 * | `self-test` | prova que o gate reprova, sobre valores sintéticos | como `gate` |
 *
 * Um critério que não pôde ser avaliado sai como `n/a` e, em modo `gate`,
 * REPROVA: `Verdict.skipped === true` implica `Verdict.passed === false`. Um
 * gate sem a evidência que promete não é um gate.
 *
 * ## Veredicto legível por máquina
 *
 * Exit code 0 = gate passou; 1 = reprovou (inclui "não avaliado"); 2 = erro de
 * uso/infra. A tabela de veredictos sai em markdown (ou `--json`) com o número
 * medido ao lado do limite, para que a reprovação diga QUAL critério caiu e por
 * quanto.
 *
 * ## Baseline
 *
 * `scripts/turn-context-baseline.json` guarda o p95 por braço E o FINGERPRINT
 * da carga que o produziu. Não havendo arquivo — ou tendo ele sido medido com
 * outra forma de carga — a comparação é RECUSADA, o critério relativo sai como
 * `n/a` e o modo `gate` reprova. Gravar é uma decisão explícita e um modo
 * explícito: `--write-baseline` exige `--mode measure`. Uma corrida de gate
 * NUNCA grava baseline sozinha, e uma corrida que grava não se apresenta como
 * gate.
 *
 * O fingerprint existe porque o próprio corpo desta PR mostra `--think-ms`
 * movendo o p95 de 28,8 ms para 187,7 ms: comparar através dessa diferença
 * produz falso verde ou falso vermelho por mudança de CARGA, não de código. Os
 * campos comparados, e os deliberadamente deixados de fora, estão documentados
 * um a um em `RunFingerprint`.
 *
 * O arquivo NÃO é versionado (`.gitignore`). Ele mede uma máquina num momento:
 * o mesmo código, no mesmo host de 4 vCPU, mediu p95 67,0 ms num contêiner e
 * 135,5 ms no seguinte. Versioná-lo entregaria o critério relativo vermelho na
 * chegada para qualquer host que não fosse o que gravou.
 *
 * ## Uso
 *
 *   npm run turn:bench -- --sustain-s 60     # O GATE (modo `gate`, o default)
 *   npm run turn:bench -- --mode measure     # medição completa, SEM veredicto de gate
 *   npm run turn:bench -- --mode measure --sustain-s 60 --write-baseline
 *   npm run turn:bench -- --sustain-s 60 --json
 *   npm run turn:bench -- --self-test --inject p95_ms=900   # prova que o gate reprova
 *   npm run turn:bench -- --self-test --self-test-baseline missing   # idem, sem baseline
 *   npm run turn:bench -- --cleanup-only     # remove massa órfã de uma corrida abortada
 *
 * | Flag | Default | O que faz |
 * |---|---|---|
 * | `--pairs` | `50` | Pares tenant/agente distintos |
 * | `--concurrency` | `20` | Turnos simultâneos |
 * | `--turns` | `600` | Turnos por braço (mínimo; ver `--sustain-s`) |
 * | `--sustain-s` | `0` | Mantém a carga por N segundos além de `--turns`. O critério "sem saturação contínua do pool por 60 s" só é falsificável com `--sustain-s 60` |
 * | `--think-ms` | `150` | Pausa entre turnos do mesmo worker. **Não é cosmético** — ver "Ritmo da carga" abaixo |
 * | `--arm` | `all` | `cold` · `warm` · `all` |
 * | `--identity` | `profile` | `profile` (perfil v2 ativo) · `legacy` (fallback `self_state`, um round-trip a mais) |
 * | `--timeout-ms` | `5000` | Orçamento por turno. Casa com `connectionTimeoutMillis` do pool |
 * | `--sample-ms` | `100` | Período de amostragem do pool. Validado contra a janela que precisa resolver |
 * | `--sample-gap-factor` | `10` | Maior lacuna cega tolerada na amostragem, em múltiplos de `--sample-ms` |
 * | `--drain-window-ms` | `2000` | Quanto observar o pool DEPOIS que o produtor para. É a única evidência do critério do perfil de saturação |
 * | `--p95-ms` / `--p99-ms` | `600` / `1000` | Limites do gate |
 * | `--baseline-tolerance` | `0.20` | Folga sobre o p95 do baseline |
 * | `--mode` | `gate` | `gate` · `measure` · `self-test` — ver acima |
 * | `--write-baseline` | — | Grava o p95 medido como novo baseline. **Exige `--mode measure`** |
 * | `--self-test` | — | Apelido de `--mode self-test`. Não toca no banco |
 * | `--inject` | — | `p95_ms=900`, `warm.peak_reads=8`, `cold.errors=1`, … (exige `--self-test`) |
 * | `--self-test-baseline` | `ok` | `ok` · `missing` · `incompatible` (exige `--self-test`) |
 * | `--json` | — | Saída JSON |
 * | `--cleanup-only` | — | Só remove a massa `bench525-*` e sai |
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// O contrato de config é fail-closed no boot (issue #515). Os valores abaixo
// são os MESMOS de `tests/setup.ts` e só preenchem o que já não veio do
// ambiente — um `.env` real continua vencendo. Precisam existir ANTES do
// primeiro import de `@/config/env.js`, que é por isso que todos os imports do
// projeto abaixo são dinâmicos.
const ENV_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://maia_test:test1234@localhost:5432/maia_test',
  POSTGRES_USER: 'maia_test',
  POSTGRES_PASSWORD: 'test1234',
  POSTGRES_DB: 'maia_test',
  REDIS_URL: 'redis://localhost:6379',
  ANTHROPIC_API_KEY: 'sk-ant-benchmark-placeholder',
  OPENROUTER_API_KEY: 'sk-or-benchmark-placeholder',
  WHATSAPP_NUMBER_MAIA: '+5500000000000',
  OWNER_TELEFONE_WHATSAPP: '+5511111111111',
  OWNER_NOME: 'Benchmark Owner',
  VOYAGE_API_KEY: 'benchmark-voyage-key',
  ALERT_CHANNELS: 'log',
  // O cache é ligado/desligado POR BRAÇO em tempo de execução; ligar aqui é o
  // que permite `startTurnContextCacheInvalidationSubscriber()` armar o
  // subscriber antes do braço `warm`.
  FEATURE_TURN_CONTEXT_CACHE: 'true',
  // `llm_gateway.call` e `turn_context.degraded` saem uma vez por turno; em
  // carga, serializar log domina o relógio da medição.
  LOG_LEVEL: 'error',
};
for (const [k, v] of Object.entries(ENV_DEFAULTS)) process.env[k] ??= v;

// ============================================================================
// Opções
// ============================================================================

export type ArmName = 'cold' | 'warm';
const ALL_ARMS: ArmName[] = ['cold', 'warm'];

/** Cardinalidades de escopo que o enunciado do dono fixa. */
export const CARDINALITIES = [1, 10, 100] as const;

export type Thresholds = {
  p95_ms: number;
  p99_ms: number;
  /** `TURN_CONTEXT_MAX_CONCURRENT_READS`. Lido do código, não digitado aqui. */
  max_peak_reads: number;
  min_concurrent_tenants: number;
  /** Saturação contínua do pool que reprova, em ms. */
  saturation_ms: number;
  baseline_tolerance: number;
  pairs: number;
  concurrency: number;
  /**
   * Maior lacuna tolerada entre duas amostras do pool, em múltiplos de
   * `--sample-ms`. NÃO é um limite de desempenho: é o limite de QUALIDADE DA
   * EVIDÊNCIA. Um amostrador que ficou 6 s sem rodar não observou 6 s de
   * corrida, e o critério de saturação que ele alimenta não pode ser lido como
   * "o pool drenou" — foi só ninguém ter olhado.
   */
  sample_gap_factor: number;
};

/**
 * O MODO da corrida. Existe porque medir e barrar são coisas diferentes, e
 * misturá-las foi o defeito que a review do dono apontou: uma corrida sem
 * baseline saía com exit 0 e o operador lia isso como "o gate passou".
 *
 * | modo | o que é | exit code |
 * |---|---|---|
 * | `gate` | o veredicto. Todo critério obrigatório TEM que ter sido avaliado | 0 aprovado · 1 reprovado (inclui "não avaliado") · 2 erro de uso/infra |
 * | `measure` | medição absoluta. NÃO emite veredicto de gate e diz isso no relatório | 0 (a medição aconteceu) · 2 erro |
 * | `self-test` | prova que o gate reprova, sobre valores sintéticos | como `gate` |
 *
 * O default é `gate`: o modo mais estrito precisa ser o que sai de graça, para
 * que esquecer a flag produza um NÃO em vez de um sim sem evidência.
 */
export type RunMode = 'gate' | 'measure' | 'self-test';
const ALL_MODES: RunMode[] = ['gate', 'measure', 'self-test'];

/** Estado do baseline que o `--self-test` simula, para provar cada reprovação pela CLI. */
export type SelfTestBaseline = 'ok' | 'missing' | 'incompatible';

type Options = {
  mode: RunMode;
  pairs: number;
  concurrency: number;
  turns: number;
  sustain_s: number;
  think_ms: number;
  arms: ArmName[];
  identity: 'profile' | 'legacy';
  timeout_ms: number;
  sample_ms: number;
  /** Quanto tempo observar o pool DEPOIS que o produtor para. */
  drain_window_ms: number;
  thresholds: Thresholds;
  write_baseline: boolean;
  inject: Record<string, number>;
  self_test_baseline: SelfTestBaseline;
  json: boolean;
  cleanup_only: boolean;
};

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = join(HERE, 'turn-context-baseline.json');

/**
 * A FORMA da corrida que produziu um número — o que precisa bater para que
 * comparar dois p95 signifique alguma coisa.
 *
 * Cada campo aqui muda o NÚMERO MEDIDO, e é por isso que ele está aqui:
 *
 * | campo | por que muda o número |
 * |---|---|
 * | `pairs` | quantos pares tenant/agente distintos a carga toca — muda a localidade do cache do Postgres e o volume de linhas por escopo |
 * | `concurrency` | é o regime de fila. Fixa quantos turnos disputam um pool de 10 e domina a cauda |
 * | `think_ms` | medido nesta PR: p95 de 28,8 ms com 150 ms contra 187,7 ms com 0. É o parâmetro que mais move o número |
 * | `identity` | `legacy` cai no `self_state` e paga UM round-trip a mais por turno |
 * | `cardinalities` | o tamanho do escopo decide quantas entidades cada turno lê e renderiza |
 * | `pool_max` | o denominador da saturação. Comparar p95 de um pool 10 com um pool 20 é comparar dois sistemas |
 * | `max_concurrent_reads` | `TURN_CONTEXT_MAX_CONCURRENT_READS`: quantas leituras de um turno andam juntas |
 * | `turns` / `sustain_s` | a DURAÇÃO amortiza o transiente de aquecimento (JIT, conexões, cache do Postgres). Medido neste host, mesmo código, minutos de intervalo: 600 turnos (5,7 s) deram p95 118,6 ms; 60 s sustentados (7 389 turnos) deram 22,4 ms — 5×. Um baseline de corrida curta contra o gate canônico é falso vermelho garantido |
 *
 * E o que ficou DE FORA da comparação, de propósito, porque invalidaria o
 * baseline sem mudar o número — o fingerprint frouxo não protege, mas o
 * fingerprint barulhento é pior: o operador aprende a ignorá-lo:
 *
 * | campo | por que só é REGISTRADO |
 * |---|---|
 * | `host` / `node` / `platform` | o baseline já é por máquina (não é versionado). Comparar aqui reprovaria toda atualização de runtime sem dizer nada sobre o código |
 * | `timeout_ms` | classifica o que conta como timeout; não move a latência medida |
 * | `sample_ms` | é o período de observação do POOL; não entra no p95 do turno |
 */
/**
 * A FRONTEIRA do que este harness mede — e a razão de ela estar aqui, e não
 * só num comentário.
 *
 * O orçamento do turno (`src/agent/turn-context/types.ts`) é
 * `resolveScope` + `buildPrompt`. Este harness mede só `buildPrompt`:
 * `buildContext` fabrica o escopo em memória e a massa não semeia
 * `permissoes` nem `permission_profiles`. Enquanto isso for verdade, NENHUMA
 * corrida deste script pode produzir a aprovação do orçamento COMPLETO — nem
 * por exit code, nem por linha de relatório.
 *
 * A contenção é estrutural, em três pontos que se sustentam:
 *
 *  1. `evaluateGate` emite o critério do aceite completo como NÃO AVALIADO
 *     (`skipped: true`). Pela invariante do `Verdict`, não avaliado implica
 *     não aprovado, e em modo `gate` isso REPROVA a corrida. Um gate que não
 *     pode demonstrar o que promete não deve sair 0;
 *  2. `cobertura` entra no `RunFingerprint`, então um baseline gravado sob
 *     uma cobertura é RECUSADO para comparação sob outra. É o que mantém os
 *     números antigos identificados pela cobertura que os produziu, em vez de
 *     deixá-los circular como se medissem o turno inteiro;
 *  3. o relatório carrega o rótulo em todo modo, inclusive `measure`.
 *
 * Quando o `resolveScope` entrar na medição (issue #700), `resolve_scope_medido`
 * vira `true` e o `rotulo` muda — e a mudança do rótulo é justamente o que
 * invalida, de forma automática, todo baseline da cobertura anterior. Virar a
 * flag SEM incluir a medição é o defeito que a sonda vermelha da #700 tem de
 * pegar.
 */
export const COBERTURA_DA_MEDICAO = {
  /**
   * `false` enquanto `buildContext` fabricar o escopo em memória em vez de
   * chamar `resolveScope`. Ver issue #700.
   */
  resolve_scope_medido: false,
  rotulo: 'buildPrompt-sem-resolveScope',
} as const;

/** O rótulo da cobertura da corrida atual — carimbado no baseline e no relatório. */
export function coberturaAtual(): string {
  return COBERTURA_DA_MEDICAO.resolve_scope_medido
    ? 'resolveScope+buildPrompt'
    : COBERTURA_DA_MEDICAO.rotulo;
}

export type RunFingerprint = {
  pairs: number;
  concurrency: number;
  think_ms: number;
  identity: 'profile' | 'legacy';
  cardinalities: number[];
  pool_max: number;
  max_concurrent_reads: number;
  turns: number;
  sustain_s: number;
  /**
   * O que a corrida EXERCITOU. Comparado como qualquer outro campo: um
   * baseline de `buildPrompt-sem-resolveScope` não serve de referência para
   * uma corrida que passe a medir `resolveScope+buildPrompt`, e vice-versa —
   * os dois números medem coisas diferentes e compará-los produziria um
   * delta que não é regressão nem melhoria, e sim mudança de régua.
   */
  cobertura: string;
};

/**
 * Versão do formato do baseline. Um arquivo sem `schema_version` é de antes do
 * fingerprint: ele NÃO prova ter sido medido com a mesma carga, então a
 * comparação é recusada em vez de assumida. Aceitar o formato antigo em
 * silêncio reabriria exatamente o buraco que o fingerprint fecha.
 */
// v3: o fingerprint passou a carimbar `cobertura`. Um baseline v2 não diz o
// que mediu, então não dá para saber se ele inclui o `resolveScope` — e um
// número cuja fronteira é desconhecida não é referência. Recusado, não
// assumido. Regravar é uma linha de comando; assumir seria uma conclusão.
export const BASELINE_SCHEMA_VERSION = 3;

export type BaselineFile = {
  schema_version: number;
  /** Como o baseline foi obtido — texto livre, escrito por quem gravou. */
  recorded_at: string;
  recorded_by: string;
  host: string;
  note: string;
  /** Comparado: divergiu, a comparação é recusada. */
  fingerprint: RunFingerprint;
  /** Registrado, NÃO comparado — documenta a corrida sem invalidar o arquivo. */
  context: {
    timeout_ms: number;
    sample_ms: number;
    node: string;
    platform: string;
    mode: RunMode;
  };
  arms: Record<string, { p95_ms: number; p99_ms: number; turns: number; wall_ms: number }>;
};

/** O fingerprint da corrida ATUAL. `pool_max` vem do pool de verdade, não de um literal. */
export function runFingerprint(
  o: {
    pairs: number;
    concurrency: number;
    think_ms: number;
    identity: 'profile' | 'legacy';
    turns: number;
    sustain_s: number;
  },
  maxConcurrentReads: number,
  poolMax: number,
): RunFingerprint {
  return {
    pairs: o.pairs,
    concurrency: o.concurrency,
    think_ms: o.think_ms,
    identity: o.identity,
    cardinalities: [...CARDINALITIES],
    pool_max: poolMax,
    max_concurrent_reads: maxConcurrentReads,
    turns: o.turns,
    sustain_s: o.sustain_s,
    cobertura: coberturaAtual(),
  };
}

export type BaselineCompatibility = {
  status: 'ok' | 'missing' | 'legacy_schema' | 'incompatible';
  /** Uma linha por campo divergente, no formato `campo: baseline=X · agora=Y`. */
  diffs: string[];
};

/**
 * Decide se DÁ para comparar — e recusa quando não dá.
 *
 * O aviso não basta: um baseline medido com `--think-ms 0` comparado contra a
 * corrida canônica produz falso verde ou falso vermelho por mudança de CARGA,
 * não de código, e um aviso no meio de trinta linhas de tabela é lido como
 * ruído. Divergiu, o critério relativo não foi avaliado.
 */
export function checkBaselineCompatibility(
  baseline: BaselineFile | null,
  current: RunFingerprint,
): BaselineCompatibility {
  if (!baseline) return { status: 'missing', diffs: [] };
  if (baseline.schema_version !== BASELINE_SCHEMA_VERSION || !baseline.fingerprint) {
    return {
      status: 'legacy_schema',
      diffs: [
        `schema_version: baseline=${baseline.schema_version ?? 'ausente'} · ` +
          `esperado=${BASELINE_SCHEMA_VERSION} (arquivo sem fingerprint da carga)`,
      ],
    };
  }
  const fp = baseline.fingerprint;
  const diffs: string[] = [];
  const cmp = (field: keyof RunFingerprint): void => {
    const a = fp[field];
    const b = current[field];
    const same = Array.isArray(a) && Array.isArray(b) ? a.join('/') === b.join('/') : a === b;
    if (!same) {
      const show = (v: unknown): string =>
        v === undefined ? 'ausente' : Array.isArray(v) ? v.join('/') : String(v);
      diffs.push(`${field}: baseline=${show(a)} · agora=${show(b)}`);
    }
  };
  cmp('pairs');
  cmp('concurrency');
  cmp('think_ms');
  cmp('identity');
  cmp('cardinalities');
  cmp('pool_max');
  cmp('max_concurrent_reads');
  cmp('turns');
  cmp('sustain_s');
  cmp('cobertura');
  return diffs.length ? { status: 'incompatible', diffs } : { status: 'ok', diffs: [] };
}

function parseInject(raw: string | undefined): Record<string, number> {
  if (!raw) return {};
  const out: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) throw new Error(`--inject inválido: "${part}" (esperado chave=valor)`);
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--inject inválido: "${part}" (valor não numérico)`);
    out[k.trim()] = n;
  }
  return out;
}

export function parseArgs(argv: string[], maxPeakReads: number): Options {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (name: string, fallback: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`--${name} precisa de um número`);
    return parsed;
  };
  const armRaw = get('arm') ?? 'all';
  const arms =
    armRaw === 'all'
      ? [...ALL_ARMS]
      : armRaw.split(',').map((a) => {
          const t = a.trim();
          if (!ALL_ARMS.includes(t as ArmName)) {
            throw new Error(`--arm inválido: ${t} (esperado ${ALL_ARMS.join(' | ')} | all)`);
          }
          return t as ArmName;
        });
  const identityRaw = get('identity') ?? 'profile';
  if (identityRaw !== 'profile' && identityRaw !== 'legacy') {
    throw new Error(`--identity inválido: ${identityRaw} (esperado profile | legacy)`);
  }

  // --- modo -----------------------------------------------------------------
  // `--self-test` continua valendo como apelido de `--mode self-test`: é o que
  // o runbook e as esteiras já digitam.
  const modeRaw = get('mode');
  if (modeRaw !== undefined && !ALL_MODES.includes(modeRaw as RunMode)) {
    throw new Error(`--mode inválido: ${modeRaw} (esperado ${ALL_MODES.join(' | ')})`);
  }
  const selfTestFlag = argv.includes('--self-test');
  if (selfTestFlag && modeRaw !== undefined && modeRaw !== 'self-test') {
    throw new Error(`--self-test conflita com --mode ${modeRaw}`);
  }
  const mode: RunMode = selfTestFlag ? 'self-test' : ((modeRaw as RunMode | undefined) ?? 'gate');

  const inject = parseInject(get('inject'));
  if (Object.keys(inject).length > 0 && mode !== 'self-test') {
    // Injeção existe para PROVAR que o gate reprova. Deixá-la disponível numa
    // corrida de medição transformaria o gate num carimbo: `--inject p95_ms=1`
    // faria qualquer regressão passar.
    throw new Error('--inject só é aceito junto de --self-test (é a prova do gate, não uma medição)');
  }

  const selfTestBaselineRaw = get('self-test-baseline') ?? 'ok';
  if (!['ok', 'missing', 'incompatible'].includes(selfTestBaselineRaw)) {
    throw new Error(
      `--self-test-baseline inválido: ${selfTestBaselineRaw} (esperado ok | missing | incompatible)`,
    );
  }
  if (selfTestBaselineRaw !== 'ok' && mode !== 'self-test') {
    throw new Error('--self-test-baseline só é aceito junto de --self-test');
  }

  const write_baseline = argv.includes('--write-baseline');
  if (write_baseline && mode !== 'measure') {
    // Gravar baseline É uma medição absoluta, não um gate. Deixar as duas
    // coisas no mesmo comando é o que fazia uma corrida "de gate" produzir a
    // própria referência contra a qual ela seria julgada depois.
    throw new Error(
      '--write-baseline exige --mode measure (gravar baseline é medição, não veredicto): ' +
        'npm run turn:bench -- --mode measure --sustain-s 60 --write-baseline',
    );
  }

  const sample_ms = num('sample-ms', 100);
  const saturation_ms = num('saturation-ms', 60_000);
  const sustain_s = num('sustain-s', 0);
  // O período de amostragem é validado contra a JANELA que ele precisa
  // resolver. Um `--sample-ms` maior que a corrida devolve zero amostras, e
  // zero amostras já foi lido como "o pool drenou" — o defeito que esta
  // validação e o veredicto de cobertura fecham pelos dois lados.
  const MIN_SAMPLES_PER_WINDOW = 10;
  if (!Number.isInteger(sample_ms) || sample_ms < 1) {
    throw new Error(`--sample-ms precisa ser um inteiro ≥ 1 (recebido ${sample_ms})`);
  }
  if (sample_ms * MIN_SAMPLES_PER_WINDOW > saturation_ms) {
    throw new Error(
      `--sample-ms ${sample_ms} não resolve a janela de saturação de ${saturation_ms} ms ` +
        `(são necessárias ao menos ${MIN_SAMPLES_PER_WINDOW} amostras por janela; ` +
        `máximo aceito: ${Math.floor(saturation_ms / MIN_SAMPLES_PER_WINDOW)} ms)`,
    );
  }
  if (sustain_s > 0 && sample_ms * MIN_SAMPLES_PER_WINDOW > sustain_s * 1000) {
    throw new Error(
      `--sample-ms ${sample_ms} não resolve uma corrida de ${sustain_s}s ` +
        `(são necessárias ao menos ${MIN_SAMPLES_PER_WINDOW} amostras)`,
    );
  }
  // A janela de escoamento é a ÚNICA evidência do critério do perfil de
  // saturação. Uma janela que não comporta amostras não observa escoamento
  // nenhum — é o mesmo defeito de "zero amostras conta como drenou", um passo
  // adiante.
  const drain_window_ms = num('drain-window-ms', 2_000);
  if (drain_window_ms < sample_ms * MIN_SAMPLES_PER_WINDOW) {
    throw new Error(
      `--drain-window-ms ${drain_window_ms} não observa escoamento com --sample-ms ${sample_ms} ` +
        `(são necessárias ao menos ${MIN_SAMPLES_PER_WINDOW} amostras: mínimo ${sample_ms * MIN_SAMPLES_PER_WINDOW} ms)`,
    );
  }

  return {
    mode,
    pairs: num('pairs', 50),
    concurrency: num('concurrency', 20),
    turns: num('turns', 600),
    sustain_s,
    think_ms: num('think-ms', 150),
    arms,
    identity: identityRaw,
    timeout_ms: num('timeout-ms', 5_000),
    sample_ms,
    drain_window_ms,
    thresholds: {
      p95_ms: num('p95-ms', 600),
      p99_ms: num('p99-ms', 1_000),
      max_peak_reads: maxPeakReads,
      min_concurrent_tenants: num('min-tenants', 10),
      saturation_ms,
      baseline_tolerance: num('baseline-tolerance', 0.2),
      sample_gap_factor: num('sample-gap-factor', 10),
      // A FORMA da carga exigida vem do enunciado do dono, NÃO de `--pairs` /
      // `--concurrency`. Derivá-la das flags tornaria o critério circular:
      // `--pairs 4` aprovaria uma corrida de quatro tenants como se fosse o
      // gate. Quem quiser rodar menor roda — e o gate reprova, dizendo por quê.
      pairs: num('required-pairs', 50),
      concurrency: num('required-concurrency', 20),
    },
    write_baseline,
    inject,
    self_test_baseline: selfTestBaselineRaw as SelfTestBaseline,
    json: argv.includes('--json'),
    cleanup_only: argv.includes('--cleanup-only'),
  };
}

// ============================================================================
// Estatística
// ============================================================================

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

/**
 * Makespan de uma lista de leituras sob um semáforo FIFO de `permits`.
 *
 * É o modelo do `ReadGate` (`src/agent/turn-context/concurrency.ts`): a próxima
 * tarefa começa assim que UM permit vaga. Serve para responder à pergunta do
 * aceite — "quanto valeriam 8 round-trips em vez de 10?" — sem precisar
 * implementar as fusões de tabela: basta re-agendar as MESMAS durações medidas
 * com dois itens a menos.
 */
export function gateMakespan(durations: number[], permits: number): number {
  if (durations.length === 0) return 0;
  const finish = new Array<number>(Math.max(1, permits)).fill(0);
  for (const d of durations) {
    let i = 0;
    for (let j = 1; j < finish.length; j++) if (finish[j]! < finish[i]!) i = j;
    finish[i] = finish[i]! + d;
  }
  return Math.max(...finish);
}

/**
 * Funde os pares de leituras que a #525 lista como candidatos a `UNION ALL`
 * (`docs/architecture/modules/agent.md`): `capabilities ∪ gaps` e
 * `facts ∪ rules`. O custo de uma união sobre duas tabelas indexadas pelo mesmo
 * par (tenant, agent) é modelado como o MAIOR dos dois — otimista de
 * propósito, porque um modelo pessimista responderia a pergunta sozinho.
 */
export function mergeTwoPairs(reads: Array<{ section: string; ms: number }>): number[] {
  const MERGES: Array<[string, string]> = [
    ['capabilities', 'gaps'],
    ['facts', 'rules'],
  ];
  const remaining = reads.map((r) => ({ ...r }));
  for (const [a, b] of MERGES) {
    const ia = remaining.findIndex((r) => r.section === a);
    const ib = remaining.findIndex((r) => r.section === b);
    if (ia === -1 || ib === -1) continue;
    // A leitura fundida FICA NA POSIÇÃO DA PRIMEIRA das duas. Jogá-la para o
    // fim da lista mudaria a ordem FIFO do semáforo e o modelo passaria a medir
    // a reordenação em vez da fusão — foi o que produziu "ganho negativo" na
    // primeira versão deste harness.
    const keep = Math.min(ia, ib);
    const drop = Math.max(ia, ib);
    remaining[keep]!.ms = Math.max(remaining[ia]!.ms, remaining[ib]!.ms);
    remaining.splice(drop, 1);
  }
  return remaining.map((r) => r.ms);
}

// ============================================================================
// Amostragem do pool — contabilidade PURA, por relógio real
// ============================================================================

export type PoolSamplingSummary = {
  samples: number;
  saturated_samples: number;
  /**
   * Maior sequência saturada, medida por TIMESTAMPS. O acumulador antigo
   * (`streak += periodMs`) contava PERÍODOS PEDIDOS, não tempo decorrido: com o
   * event loop atrasado — que é exatamente quando a máquina está sob a carga
   * que interessa medir — dez amostras espalhadas por 6 s viravam "1 s
   * saturado", e o critério de 60 s passava sem nunca ter olhado 60 s.
   */
  max_streak_ms: number;
  /** Da primeira à última amostra. Zero quando não houve amostra alguma. */
  sampled_span_ms: number;
  /**
   * Maior intervalo CEGO: inclui o trecho antes da primeira amostra e o trecho
   * depois da última. Com zero amostras é a corrida inteira, que é como um
   * amostrador que nunca rodou se denuncia.
   */
  max_gap_ms: number;
  /**
   * Amostras da fase de CARGA (produtor emitindo) e da fase de ESCOAMENTO
   * (produtor parado). A fronteira existe porque o dono separou os dois perfis:
   * no perfil de saturação (`--think-ms 0`) a fila não pode esvaziar enquanto
   * 20 turnos são repostos continuamente — é aritmética — então ali o que se
   * exige é que ela esvazie DEPOIS que o produtor para.
   */
  load: PoolPhaseSummary;
  drain: PoolPhaseSummary;
  /**
   * Quanto tempo depois do produtor parar veio a primeira amostra drenada.
   * `NEVER_DRAINED` quando nenhuma veio — inclusive quando a fase sequer foi
   * observada, caso em que `drain.samples === 0` diz qual dos dois é.
   */
  drained_after_ms: number;
};

export type PoolPhaseSummary = {
  samples: number;
  saturated_samples: number;
};

/** "Não drenou" (ou não foi observado) — `drained_after_ms` é um número para poder ser injetado. */
export const NEVER_DRAINED = -1;

/**
 * A contabilidade da amostragem do pool, separada do `setInterval` para poder
 * ser provada com timestamps sintéticos.
 *
 * Duas decisões conservadoras, ambas na direção segura (superestimar a
 * saturação, nunca subestimá-la):
 *
 *  1. A sequência saturada começa no último instante em que se SABE que o pool
 *     não estava saturado — a amostra drenada anterior, ou o início da corrida.
 *     Erra para mais em até um período; o acumulador antigo errava para menos,
 *     sem limite.
 *  2. `max_gap_ms` inclui as pontas. Um amostrador que morreu no meio da
 *     corrida deixa um buraco visível em vez de um silêncio.
 */
export function createPoolSaturationTracker(startedAtMs: number): {
  observe: (atMs: number, saturated: boolean) => void;
  /** A fronteira temporal entre carga e escoamento: o instante em que o produtor parou. */
  markProducerStopped: (atMs: number) => void;
  summary: (endedAtMs: number) => PoolSamplingSummary;
} {
  let samples = 0;
  let saturatedSamples = 0;
  let maxStreak = 0;
  let maxGap = 0;
  let firstAt: number | null = null;
  let lastAt = startedAtMs;
  // Último instante conhecidamente NÃO saturado.
  let lastDrainedAt = startedAtMs;
  let producerStoppedAt: number | null = null;
  const load: PoolPhaseSummary = { samples: 0, saturated_samples: 0 };
  const drain: PoolPhaseSummary = { samples: 0, saturated_samples: 0 };
  let drainedAfterMs = NEVER_DRAINED;

  return {
    observe: (atMs: number, saturated: boolean): void => {
      samples++;
      if (firstAt === null) firstAt = atMs;
      const gap = atMs - lastAt;
      if (gap > maxGap) maxGap = gap;
      lastAt = atMs;
      // A atribuição de fase é por TIMESTAMP, e é por isso que a sequência
      // também precisa ser: a fronteira "o produtor parou" só é localizável
      // com precisão nas amostras se as amostras carregarem o relógio real.
      const phase = producerStoppedAt !== null && atMs > producerStoppedAt ? drain : load;
      phase.samples++;
      if (saturated) {
        saturatedSamples++;
        phase.saturated_samples++;
        const streak = atMs - lastDrainedAt;
        if (streak > maxStreak) maxStreak = streak;
      } else {
        lastDrainedAt = atMs;
        if (phase === drain && drainedAfterMs === NEVER_DRAINED) {
          drainedAfterMs = atMs - producerStoppedAt!;
        }
      }
    },
    markProducerStopped: (atMs: number): void => {
      if (producerStoppedAt === null) producerStoppedAt = atMs;
    },
    summary: (endedAtMs: number): PoolSamplingSummary => {
      const tail = endedAtMs - lastAt;
      return {
        samples,
        saturated_samples: saturatedSamples,
        max_streak_ms: maxStreak,
        sampled_span_ms: firstAt === null ? 0 : lastAt - firstAt,
        max_gap_ms: Math.max(maxGap, tail > 0 ? tail : 0),
        load: { ...load },
        drain: { ...drain },
        drained_after_ms: drainedAfterMs,
      };
    },
  };
}

/** A fatia de `ArmResult` que descreve a amostragem do pool. */
export type PoolMetrics = Pick<
  ArmResult,
  | 'pool_saturation_max_streak_ms'
  | 'pool_saturated_samples'
  | 'pool_samples'
  | 'pool_sample_ms'
  | 'pool_sampled_span_ms'
  | 'pool_max_sample_gap_ms'
  | 'pool_load_samples'
  | 'pool_load_saturated_samples'
  | 'pool_drain_samples'
  | 'pool_drain_saturated_samples'
  | 'pool_drained_after_ms'
>;

/**
 * A FRONTEIRA entre o amostrador e o avaliador.
 *
 * Existe como função própria porque corrigir só o avaliador não conserta nada:
 * se `runArm` continuar publicando `pool_samples: 0` como se fosse uma
 * observação, o spec passa e a corrida real segue mentindo. Toda a tradução
 * summary → `ArmResult` mora aqui, e é isto que o teste alimenta.
 */
export function poolMetricsFromSummary(summary: PoolSamplingSummary, sampleMs: number): PoolMetrics {
  return {
    pool_saturation_max_streak_ms: summary.max_streak_ms,
    pool_saturated_samples: summary.saturated_samples,
    pool_samples: summary.samples,
    pool_sample_ms: sampleMs,
    pool_sampled_span_ms: summary.sampled_span_ms,
    pool_max_sample_gap_ms: summary.max_gap_ms,
    pool_load_samples: summary.load.samples,
    pool_load_saturated_samples: summary.load.saturated_samples,
    pool_drain_samples: summary.drain.samples,
    pool_drain_saturated_samples: summary.drain.saturated_samples,
    pool_drained_after_ms: summary.drained_after_ms,
  };
}

// ============================================================================
// Resultado de um braço + veredictos (PUROS — testáveis sem Postgres)
// ============================================================================

export type CardinalityStats = {
  entities: number;
  turns: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
};

export type SectionLatency = {
  section: string;
  reads: number;
  p50_ms: number;
  p95_ms: number;
};

export type ArmResult = {
  arm: ArmName;
  turns: number;
  wall_ms: number;
  concurrency: number;
  pairs_exercised: number;
  /** Máximo de tenants DISTINTOS com turno em voo ao mesmo tempo. */
  max_concurrent_tenants: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  /** p95 estimado pelos buckets do histograma — o que o Grafana vai mostrar. */
  p95_from_histogram_ms: number;
  errors: number;
  timeouts: number;
  error_samples: string[];
  /** Pico de leituras simultâneas DE UM MESMO TURNO. O teto é 6. */
  peak_reads_per_turn: number;
  reads_per_turn_min: number;
  reads_per_turn_max: number;
  pool_max: number;
  pool_saturation_max_streak_ms: number;
  pool_saturated_samples: number;
  pool_samples: number;
  /** Período PEDIDO ao amostrador (`--sample-ms`). */
  pool_sample_ms: number;
  /** Da primeira à última amostra do pool. */
  pool_sampled_span_ms: number;
  /** Maior intervalo cego da amostragem, pontas incluídas. */
  pool_max_sample_gap_ms: number;
  /** Amostras da fase de CARGA (produtor emitindo). */
  pool_load_samples: number;
  pool_load_saturated_samples: number;
  /** Amostras da fase de ESCOAMENTO (produtor parado) — a evidência do perfil de saturação. */
  pool_drain_samples: number;
  pool_drain_saturated_samples: number;
  /** ms entre o produtor parar e a primeira amostra drenada · `NEVER_DRAINED` se não houve. */
  pool_drained_after_ms: number;
  /** Janela de observação do escoamento, pedida em `--drain-window-ms`. */
  pool_drain_window_ms: number;
  /**
   * O RITMO com que este braço rodou. Define o PERFIL, e portanto qual critério
   * de drenagem se aplica: `0` é o perfil de saturação.
   */
  think_ms: number;
  identity_cache: Record<string, number>;
  /** `maia_turn_context_load_duration_ms{phase="loader"}` — count e sum reais. */
  metric_count: number;
  metric_sum_ms: number;
  by_cardinality: CardinalityStats[];
  by_section: SectionLatency[];
  /** Modelo: p95 do makespan das leituras com 10 e com 8 round-trips. */
  modelled_makespan_p95_now_ms: number;
  modelled_makespan_p95_at_8_ms: number;
};

export type Verdict = {
  label: string;
  /**
   * INVARIANTE: `skipped === true` implica `passed === false`.
   *
   * "Não avaliado" deixou de ser sinônimo de "aprovado" — era essa igualdade
   * que deixava o veredicto final verde sem a evidência prometida. Quem decide
   * o que fazer com um critério não avaliado é o MODO: `gate` reprova, `measure`
   * apenas informa (ver `gateExitCode`).
   */
  passed: boolean;
  /** `true` quando o critério não pôde ser avaliado por falta de evidência. */
  skipped?: boolean;
  detail: string;
};

/** O que o gate precisa saber além dos números dos braços. */
export type GateContext = {
  mode: RunMode;
  /** A forma da corrida atual — comparada com a do baseline. */
  fingerprint: RunFingerprint;
};

/**
 * O gate. Função PURA sobre os resultados dos braços — é isto que
 * `tests/unit/turn-context-gate.spec.ts` alimenta com valores sintéticos para
 * provar que ele REPROVA quando deve.
 */
export function evaluateGate(
  arms: ArmResult[],
  th: Thresholds,
  baseline: BaselineFile | null,
  ctx: GateContext,
): Verdict[] {
  const out: Verdict[] = [];
  const compat = checkBaselineCompatibility(baseline, ctx.fingerprint);

  // ── O aceite COMPLETO, e por que ele vem PRIMEIRO ────────────────────
  // O orçamento do turno é `resolveScope` + `buildPrompt`. Enquanto o harness
  // fabricar o escopo em memória, este critério NÃO PODE ser avaliado — e
  // "não avaliado" não é "aprovado" (ver a invariante do `Verdict`).
  //
  // Ele encabeça a lista de propósito: quem lê a tabela de cima para baixo
  // encontra a fronteira ANTES dos números, e não depois de já ter formado
  // uma opinião sobre eles. Em modo `gate` isso reprova a corrida — é a
  // consequência pretendida: o gate não pode sair 0 sobre uma garantia que
  // não demonstra. Os critérios PARCIAIS abaixo continuam sendo avaliados e
  // continuam valendo para o trecho que exercitam.
  if (!COBERTURA_DA_MEDICAO.resolve_scope_medido) {
    out.push({
      label: 'aceite completo do orçamento do turno (resolveScope + buildPrompt)',
      passed: false,
      skipped: true,
      detail:
        `NÃO AVALIADO — a medição exclui o \`resolveScope\` (JOIN ` +
        `\`permissoes ⋈ permission_profiles\`): \`buildContext\` fabrica o escopo ` +
        `em memória e a massa não semeia essas tabelas. Cobertura desta ` +
        `corrida: \`${coberturaAtual()}\`. Os critérios abaixo valem para o ` +
        `trecho exercitado e NÃO para o custo completo do turno. Issue #700.`,
    });
  }

  for (const a of arms) {
    out.push({
      label: `[${a.arm}] p95 da carga de contexto ≤ ${th.p95_ms} ms`,
      passed: a.p95_ms <= th.p95_ms,
      detail: `p95=${a.p95_ms.toFixed(1)} ms (p50=${a.p50_ms.toFixed(1)} · máx=${a.max_ms.toFixed(1)})`,
    });
    out.push({
      label: `[${a.arm}] p99 da carga de contexto ≤ ${th.p99_ms} ms`,
      passed: a.p99_ms <= th.p99_ms,
      detail: `p99=${a.p99_ms.toFixed(1)} ms`,
    });
    out.push({
      label: `[${a.arm}] zero erros e zero timeouts`,
      passed: a.errors === 0 && a.timeouts === 0,
      detail:
        `erros=${a.errors} · timeouts=${a.timeouts} (orçamento por turno)` +
        (a.error_samples.length ? ` · ex.: ${a.error_samples.slice(0, 2).join(' | ')}` : ''),
    });
    out.push({
      label: `[${a.arm}] pico de leituras simultâneas por turno ≤ ${th.max_peak_reads}`,
      passed: a.peak_reads_per_turn <= th.max_peak_reads,
      detail:
        `pico=${a.peak_reads_per_turn} de um pool de ${a.pool_max} · ` +
        `leituras por turno ${a.reads_per_turn_min}–${a.reads_per_turn_max}`,
    });
    // O outro lado da mesma moeda: baixar o pico serializando passaria no
    // critério acima e jogaria fora tudo o que a #525 comprou. O gate exige que
    // o pico ALCANCE o teto quando há trabalho suficiente para isso.
    out.push({
      label: `[${a.arm}] o gate satura (pico alcança ${th.max_peak_reads}) — não foi "consertado" serializando`,
      passed: a.reads_per_turn_max < th.max_peak_reads || a.peak_reads_per_turn === th.max_peak_reads,
      detail: `pico=${a.peak_reads_per_turn} · leituras por turno até ${a.reads_per_turn_max}`,
    });
    out.push({
      label: `[${a.arm}] ≥ ${th.min_concurrent_tenants} tenants concorrentes de fato`,
      passed: a.max_concurrent_tenants >= th.min_concurrent_tenants,
      detail: `máximo simultâneo=${a.max_concurrent_tenants} · pares exercitados=${a.pairs_exercised}`,
    });

    // ANTES de perguntar se o pool drenou, perguntar se ALGUÉM OLHOU.
    //
    // Zero amostras era lido como "drenou": uma corrida com `--sample-ms` maior
    // que a duração, ou com o event loop impedindo o amostrador de rodar,
    // passava num dos critérios centrais do gate sem observação alguma. Uma
    // amostragem esburacada tem o mesmo efeito num pedaço da corrida — por isso
    // o que se cobra é a maior LACUNA, pontas incluídas.
    const maxGapAllowed = a.pool_sample_ms * th.sample_gap_factor;
    const sampled = a.pool_samples > 0 && a.pool_max_sample_gap_ms <= maxGapAllowed;
    out.push({
      label: `[${a.arm}] a amostragem do pool observou a corrida (lacuna ≤ ${th.sample_gap_factor}× --sample-ms)`,
      passed: sampled,
      detail:
        a.pool_samples === 0
          ? `NENHUMA AMOSTRA DO POOL em ${(a.wall_ms / 1000).toFixed(1)} s de corrida com ` +
            `--sample-ms ${a.pool_sample_ms} — o critério de saturação não foi observado`
          : `${a.pool_samples} amostras · período pedido=${a.pool_sample_ms} ms · ` +
            `maior lacuna=${a.pool_max_sample_gap_ms.toFixed(0)} ms (teto ${maxGapAllowed.toFixed(0)} ms) · ` +
            `cobertura=${(a.pool_sampled_span_ms / 1000).toFixed(1)} s de ${(a.wall_ms / 1000).toFixed(1)} s`,
    });

    // "Nenhuma saturação contínua do pool por 60 s".
    //
    // Comparar a maior SEQUÊNCIA com 60 s e mais nada é um falso verde à espera
    // de acontecer, e a primeira corrida deste harness o produziu: numa corrida
    // de 60,1 s o pool ficou saturado em 572 das 572 amostras — 100% do tempo —
    // e a sequência bateu 57,2 s, portanto "< 60 s", portanto verde. A sequência
    // é limitada pela DURAÇÃO da corrida, então esse teste sozinho só pergunta
    // se a corrida foi curta.
    //
    // O critério é, então, o que a frase quer dizer: **o pool tem que DRENAR** —
    // a fila precisa esvaziar pelo menos uma vez — e nunca ficar saturado por
    // 60 s seguidos. Um pool que jamais drena reprova em qualquer duração de
    // corrida.
    //
    // "Drenou" é uma contagem EXATA, não uma heurística sobre a duração: se
    // toda amostra viu a fila cheia, a fila nunca esvaziou. Comparar a
    // sequência com uma fração do relógio de parede erra justamente o caso que
    // motivou este critério (57,2 s de sequência em 60,1 s de corrida com
    // 572/572 amostras saturadas passaria por uma folga de 2%).
    // A fase de ESCOAMENTO — a evidência que o perfil de saturação exige, e que
    // nenhum perfil tinha antes: o amostrador era parado no mesmo instante em
    // que o produtor parava, então não havia UMA amostra depois da fronteira.
    const drainObserved = a.pool_drain_samples > 0;
    const drainedAfterStop = drainObserved && a.pool_drain_saturated_samples < a.pool_drain_samples;
    const drainDetail =
      `${a.pool_drain_saturated_samples}/${a.pool_drain_samples} amostras saturadas na janela de ` +
      `escoamento de ${(a.pool_drain_window_ms / 1000).toFixed(1)} s` +
      (drainedAfterStop
        ? ` · drenou ${a.pool_drained_after_ms.toFixed(0)} ms depois de o produtor parar`
        : drainObserved
          ? ' · A FILA NÃO ESVAZIOU DEPOIS QUE O PRODUTOR PAROU'
          : ' · FASE DE ESCOAMENTO NÃO OBSERVADA — nenhuma amostra depois de o produtor parar');

    if (a.think_ms === 0) {
      // PERFIL DE SATURAÇÃO (`--think-ms 0`), conforme a decisão do dono.
      //
      // Aqui NÃO se exige que a fila esvazie durante a carga: com 20 turnos
      // repostos continuamente contra um pool de 10, e até 6 conexões por
      // turno, ela não pode — é aritmética, não defeito, e cobrar isso produzia
      // um vermelho que não significava regressão. O que se exige é zero
      // erros/timeouts (critério próprio, acima) e que a fila esvazie DEPOIS
      // que o produtor para. Uma fila que não escoa quando ninguém mais pede é
      // conexão vazando, não carga.
      out.push({
        label: `[${a.arm}] perfil de SATURAÇÃO (--think-ms 0): o pool drena depois que o produtor para`,
        passed: sampled && drainedAfterStop,
        skipped: !sampled || !drainObserved,
        detail:
          drainDetail +
          ` · na carga: ${a.pool_load_saturated_samples}/${a.pool_load_samples} saturadas (esperado: quase todas)` +
          (sampled ? '' : ' · SEM AMOSTRAGEM VÁLIDA DO POOL'),
      });
    } else {
      // PERFIL NORMAL (com ritmo): o critério de drenagem continua como estava —
      // a fila tem que esvaziar DURANTE a carga e nunca ficar saturada por 60 s
      // seguidos.
      const observedFullWindow = a.wall_ms >= th.saturation_ms;
      const drained = a.pool_saturated_samples < a.pool_samples;
      const streakOk = a.pool_saturation_max_streak_ms < th.saturation_ms;
      // Só é "não avaliado" quando NADA de errado apareceu e a janela inteira
      // não coube na corrida. Sem amostragem válida não há o que avaliar — e
      // não avaliado NÃO é aprovado (ver `Verdict.passed`).
      const healthy = sampled && drained && streakOk && drainedAfterStop;
      out.push({
        label: `[${a.arm}] o pool drena (fila esvazia) e nunca fica saturado por ${(th.saturation_ms / 1000).toFixed(0)} s seguidos`,
        passed: healthy && observedFullWindow,
        skipped: !sampled || !drainObserved || (healthy && !observedFullWindow),
        detail:
          `maior sequência saturada=${(a.pool_saturation_max_streak_ms / 1000).toFixed(1)} s de ` +
          `${(a.wall_ms / 1000).toFixed(1)} s · ${a.pool_saturated_samples}/${a.pool_samples} amostras saturadas` +
          (sampled ? '' : ' · SEM AMOSTRAGEM VÁLIDA DO POOL — critério não observado') +
          (sampled && !drained ? ' · A FILA NUNCA ESVAZIOU' : '') +
          ` · ${drainDetail}` +
          (observedFullWindow
            ? ''
            : ` · janela de ${(th.saturation_ms / 1000).toFixed(0)} s não observada (use --sustain-s ${(th.saturation_ms / 1000).toFixed(0)})`),
      });
    }

    // A métrica que o enunciado nomeia tem que estar SAINDO. Um harness que
    // medisse com relógio próprio e não olhasse a métrica provaria o
    // desempenho e não provaria o observável — e é o observável que o operador
    // vai ler no Grafana.
    out.push({
      label: `[${a.arm}] \`maia_turn_context_load_duration_ms{phase="loader"}\` observou todos os turnos`,
      passed: a.metric_count === a.turns && a.turns > 0,
      detail: `count=${a.metric_count} · turnos=${a.turns} · p95 pelos buckets≈${a.p95_from_histogram_ms.toFixed(0)} ms`,
    });

    // O critério relativo só é avaliado contra um baseline COMPARÁVEL. Faltando
    // baseline, ou tendo sido ele medido com outra carga, o critério fica
    // `skipped` — e `skipped` não é aprovado: em modo `gate` isso derruba o
    // exit code. Um checkout limpo passou a dizer "não tenho a evidência" em
    // vez de sair 0.
    const base = compat.status === 'ok' ? baseline?.arms[a.arm] : undefined;
    if (!base) {
      const why =
        compat.status === 'missing'
          ? 'NÃO HÁ BASELINE REGISTRADO para este braço'
          : compat.status === 'legacy_schema'
            ? `BASELINE EM FORMATO ANTIGO — sem fingerprint da carga, a comparação seria uma suposição (${compat.diffs.join(' · ')})`
            : compat.status === 'incompatible'
              ? `BASELINE MEDIDO COM OUTRA CARGA — comparação RECUSADA (${compat.diffs.join(' · ')})`
              : `o baseline não tem o braço \`${a.arm}\``;
      out.push({
        label: `[${a.arm}] p95 ≤ baseline + ${(th.baseline_tolerance * 100).toFixed(0)}%`,
        passed: false,
        skipped: true,
        detail:
          `NÃO AVALIADO — ${why}. ` +
          'Grave um baseline com esta MESMA forma de carga: ' +
          'npm run turn:bench -- --mode measure --sustain-s 60 --write-baseline',
      });
    } else {
      const ceiling = base.p95_ms * (1 + th.baseline_tolerance);
      out.push({
        label: `[${a.arm}] p95 ≤ baseline + ${(th.baseline_tolerance * 100).toFixed(0)}%`,
        passed: a.p95_ms <= ceiling,
        detail:
          `p95=${a.p95_ms.toFixed(1)} ms · baseline=${base.p95_ms.toFixed(1)} ms · ` +
          `teto=${ceiling.toFixed(1)} ms · delta=${(((a.p95_ms - base.p95_ms) / base.p95_ms) * 100).toFixed(1)}%`,
      });
    }
  }

  // Forma da carga: o gate não vale nada se a corrida não exercitou o que o
  // enunciado pediu.
  const worst = arms.reduce<ArmResult | null>((acc, a) => (acc && acc.pairs_exercised <= a.pairs_exercised ? acc : a), null);
  if (worst) {
    out.push({
      label: `carga conforme o enunciado: ${th.pairs} pares tenant/agente, concorrência ${th.concurrency}, entidades ${CARDINALITIES.join('/')}`,
      passed:
        worst.pairs_exercised >= th.pairs &&
        worst.concurrency >= th.concurrency &&
        worst.by_cardinality.length === CARDINALITIES.length &&
        worst.by_cardinality.every((c) => c.turns > 0),
      detail:
        `pares=${worst.pairs_exercised} · concorrência=${worst.concurrency} · ` +
        `cardinalidades=${worst.by_cardinality.map((c) => `${c.entities}:${c.turns}`).join(' ')}`,
    });
  }

  return out;
}

/**
 * O exit code, POR MODO.
 *
 *  - `gate` / `self-test`: 0 só quando TODO critério foi avaliado e passou.
 *    Como `skipped` implica `passed === false`, um critério não avaliado
 *    reprova — que é a correção do achado "o veredicto final fica verde sem
 *    evidência equivalente à prometida".
 *  - `measure`: 0 porque a medição aconteceu. Este modo NÃO emite veredicto de
 *    gate, e o relatório diz isso em caixa alta; ler o exit code dele como
 *    aprovação é ler outra coisa. É o opt-out explícito, e ele não se apresenta
 *    como gate.
 *
 * O default é `gate` de propósito: esquecer o parâmetro tem que produzir o
 * julgamento estrito, nunca o permissivo.
 */
export function gateExitCode(verdicts: Verdict[], mode: RunMode = 'gate'): number {
  if (mode === 'measure') return 0;
  return verdicts.every((v) => v.passed) ? 0 : 1;
}

/**
 * Aplica `--inject` sobre os resultados ANTES da avaliação. Só existe para o
 * `--self-test`: é assim que se demonstra que o gate reprova sem esperar uma
 * degradação real acontecer.
 */
export function applyInjection(arms: ArmResult[], inject: Record<string, number>): string[] {
  const applied: string[] = [];
  const FIELDS = new Set([
    'p95_ms',
    'p99_ms',
    'errors',
    'timeouts',
    'peak_reads_per_turn',
    'max_concurrent_tenants',
    'pool_saturation_max_streak_ms',
    'pool_samples',
    'pool_saturated_samples',
    'pool_sample_ms',
    'pool_sampled_span_ms',
    'pool_max_sample_gap_ms',
    'pool_load_samples',
    'pool_load_saturated_samples',
    'pool_drain_samples',
    'pool_drain_saturated_samples',
    'pool_drained_after_ms',
    'pool_drain_window_ms',
    'think_ms',
    'wall_ms',
    'metric_count',
    'pairs_exercised',
    'reads_per_turn_max',
  ]);
  for (const [rawKey, value] of Object.entries(inject)) {
    const dot = rawKey.indexOf('.');
    const armFilter = dot === -1 ? null : rawKey.slice(0, dot);
    const field = dot === -1 ? rawKey : rawKey.slice(dot + 1);
    if (!FIELDS.has(field)) {
      throw new Error(`--inject: campo desconhecido "${field}" (conhecidos: ${[...FIELDS].join(', ')})`);
    }
    let hit = 0;
    for (const a of arms) {
      if (armFilter && a.arm !== armFilter) continue;
      (a as unknown as Record<string, number>)[field] = value;
      hit++;
    }
    if (hit === 0) throw new Error(`--inject: nenhum braço casa com "${armFilter ?? ''}"`);
    applied.push(`${armFilter ?? '*'}.${field}=${value}`);
  }
  return applied;
}

/** Um braço sintético que PASSA em tudo — o ponto de partida do `--self-test`. */
export function syntheticPassingArm(arm: ArmName, th: Thresholds): ArmResult {
  return {
    arm,
    turns: 600,
    wall_ms: 61_000,
    concurrency: th.concurrency,
    pairs_exercised: th.pairs,
    max_concurrent_tenants: th.concurrency,
    p50_ms: 12,
    p95_ms: 40,
    p99_ms: 70,
    max_ms: 120,
    p95_from_histogram_ms: 50,
    errors: 0,
    timeouts: 0,
    error_samples: [],
    peak_reads_per_turn: th.max_peak_reads,
    reads_per_turn_min: 10,
    reads_per_turn_max: 10,
    pool_max: 10,
    pool_saturation_max_streak_ms: 0,
    pool_saturated_samples: 0,
    pool_samples: 610,
    pool_sample_ms: 100,
    pool_sampled_span_ms: 60_900,
    pool_max_sample_gap_ms: 100,
    pool_load_samples: 590,
    pool_load_saturated_samples: 0,
    pool_drain_samples: 20,
    pool_drain_saturated_samples: 0,
    pool_drained_after_ms: 100,
    pool_drain_window_ms: 2_000,
    // O braço sintético representa o PERFIL NORMAL: é o do comando canônico.
    // O perfil de saturação é exercitado com `--inject think_ms=0`.
    think_ms: 150,
    identity_cache: {},
    metric_count: 600,
    metric_sum_ms: 7_200,
    by_cardinality: CARDINALITIES.map((entities) => ({
      entities,
      turns: 200,
      p50_ms: 12,
      p95_ms: 40,
      p99_ms: 70,
      max_ms: 120,
    })),
    by_section: [],
    modelled_makespan_p95_now_ms: 30,
    modelled_makespan_p95_at_8_ms: 29,
  };
}

/**
 * O baseline sintético do `--self-test`.
 *
 * O autoteste NÃO pode depender do arquivo de baseline da máquina: ele prova o
 * GATE, e um gate cujo autoteste muda de resultado conforme o host não prova
 * nada. `estado` permite exercitar pela CLI as três reprovações do critério
 * relativo — presente e comparável, ausente, e medido com outra carga.
 */
export function syntheticBaseline(
  arms: ArmResult[],
  fingerprint: RunFingerprint,
  estado: SelfTestBaseline,
): BaselineFile | null {
  if (estado === 'missing') return null;
  return {
    schema_version: BASELINE_SCHEMA_VERSION,
    recorded_at: '1970-01-01T00:00:00.000Z',
    recorded_by: 'self-test',
    host: 'self-test',
    note: 'BASELINE SINTÉTICO do --self-test. Não é medição de máquina nenhuma.',
    fingerprint:
      estado === 'incompatible'
        ? // A carga que a PR mediu como 28,8 ms contra 187,7 ms de p95: é a
          // divergência que mais move o número, e por isso a que serve de prova.
          { ...fingerprint, think_ms: fingerprint.think_ms === 0 ? 150 : 0 }
        : fingerprint,
    context: {
      timeout_ms: 5_000,
      sample_ms: 100,
      node: process.versions.node,
      platform: process.platform,
      mode: 'self-test',
    },
    arms: Object.fromEntries(
      arms.map((a) => [a.arm, { p95_ms: a.p95_ms, p99_ms: a.p99_ms, turns: a.turns, wall_ms: a.wall_ms }]),
    ),
  };
}

// ============================================================================
// Instrumentação: quem leu, quando, por qual turno
// ============================================================================

type TurnFrame = {
  id: number;
  tenant: string;
  entities: number;
  inflight: number;
  peak: number;
  reads: Array<{ section: string; ms: number }>;
};

const turnALS = new AsyncLocalStorage<TurnFrame>();

/**
 * Envolve UM método de repositório mantendo a implementação real.
 *
 * Isto não é um mock: `orig.apply` é a query de verdade contra o Postgres de
 * verdade. O wrapper só marca início e fim, para que "pico de leituras
 * simultâneas deste turno" seja uma MEDIÇÃO e não uma dedução a partir do
 * código do gate. Um harness que contasse permits olhando o `ReadGate` provaria
 * que o semáforo conta certo; este prova que o TURNO não passa de seis
 * statements em voo.
 */
function instrument<T extends object>(obj: T, key: keyof T & string, section: string): void {
  const orig = obj[key];
  if (typeof orig !== 'function') return;
  const fn = orig as unknown as (...args: unknown[]) => Promise<unknown>;
  const wrapped = async function wrappedRead(...args: unknown[]): Promise<unknown> {
    const frame = turnALS.getStore();
    if (!frame) return fn.apply(obj, args);
    frame.inflight++;
    if (frame.inflight > frame.peak) frame.peak = frame.inflight;
    // A entrada é registrada no INÍCIO, não no fim: `reads` precisa estar na
    // ordem de ENFILEIRAMENTO para o modelo de makespan reagendar as mesmas
    // tarefas na mesma ordem FIFO que o `ReadGate` usou. Registrar no
    // `finally` daria a ordem de CONCLUSÃO, que é outra coisa.
    const entry = { section, ms: 0 };
    frame.reads.push(entry);
    const t0 = performance.now();
    try {
      return await fn.apply(obj, args);
    } finally {
      frame.inflight--;
      entry.ms = performance.now() - t0;
    }
  };
  (obj as unknown as Record<string, unknown>)[key] = wrapped;
}

// ============================================================================
// Massa de teste
// ============================================================================

/** Prefixo de TUDO que este harness cria. `--cleanup-only` apaga por ele. */
const PREFIX = 'bench525';

type Pair = {
  tenant_id: string;
  agent_id: string;
  pessoa_id: string;
  conversa_id: string;
  entidade_ids: string[];
  /** Linhas REAIS, lidas de volta do banco — o `PromptContext` do turno usa
   *  exatamente o que `core.ts` teria em mãos, não um literal inventado. */
  pessoa: Record<string, unknown>;
  conversa: Record<string, unknown>;
  inbound: Record<string, unknown>;
};

const ENTITIES_PER_PAIR = Math.max(...CARDINALITIES);

/**
 * Tabelas que o harness escreve, na ORDEM DE REMOÇÃO (filhas antes de pais).
 * `entity_states` sai por cascade de `entidades`; `mensagens` sai por cascade
 * de `conversas` — mas removê-las explicitamente torna a limpeza independente
 * do `ON DELETE` e é o que impede que uma corrida abortada deixe massa no banco
 * COMPARTILHADO.
 */
const SEEDED_TABLES = [
  'mensagens',
  'memory_entry',
  'behavioral_hint',
  'agent_facts',
  'learned_rules',
  'agent_capabilities_skill',
  'agent_capability_gaps',
  'agent_operational_profile_versions',
  'self_state',
  'entity_states',
  'entidades',
  'conversas',
  'pessoas',
  'agents',
] as const;

type PgPool = import('pg').Pool;
type PgClient = import('pg').PoolClient;

async function cleanup(c: PgClient): Promise<number> {
  let removed = 0;
  for (const table of SEEDED_TABLES) {
    const r = await c.query(`DELETE FROM ${table} WHERE tenant_id LIKE $1`, [`${PREFIX}-%`]);
    removed += r.rowCount ?? 0;
  }
  const r = await c.query(`DELETE FROM tenants WHERE id LIKE $1`, [`${PREFIX}-%`]);
  removed += r.rowCount ?? 0;
  return removed;
}

/**
 * Semeia UM par tenant/agente com uma carga representativa.
 *
 * "Representativa" aqui significa: mais linhas do que qualquer `LIMIT` do
 * caminho de leitura, para que os budgets (`SECTION_BUDGETS`) realmente cortem
 * e a query pague ordenação em vez de devolver a tabela inteira. Um par com
 * três fatos mede o custo de um índice vazio, não o do turno.
 *
 * Deliberadamente SEM `ANALYZE`: este banco é compartilhado com a suíte, e
 * `ANALYZE` não é desfeito por `ROLLBACK` — reescrever as estatísticas de
 * `entidades` aqui envenenaria o plano de todos os outros specs.
 */
async function seedPair(c: PgClient, index: number, identity: 'profile' | 'legacy'): Promise<Pair> {
  const tenant_id = `${PREFIX}-t${index}`;
  const agent_id = `${PREFIX}-a${index}`;
  await c.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [tenant_id]);
  await c.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [agent_id, tenant_id],
  );

  const pessoa = await c.query<{ id: string }>(
    `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo)
     VALUES ($1, $2, $3, $4, 'dono') RETURNING id`,
    [tenant_id, agent_id, `${PREFIX} Owner ${index}`, `+5511${String(900000000 + index)}`],
  );
  const pessoa_id = pessoa.rows[0]!.id;

  const ents = await c.query<{ id: string }>(
    `INSERT INTO entidades(tenant_id, agent_id, nome, tipo)
     SELECT $1, $2, '${PREFIX}-ent-' || lpad(g::text, 4, '0'), 'pj'
     FROM generate_series(1, $3) g
     RETURNING id`,
    [tenant_id, agent_id, ENTITIES_PER_PAIR],
  );
  const entidade_ids = ents.rows.map((r) => r.id);

  // Estados para um quinto das entidades: a projeção de estado tem cardinalidade
  // MENOR que a de entidades (é por isso que o LEFT JOIN existe), e medir com
  // 1:1 esconderia o `state: null` que o renderer trata.
  await c.query(
    `INSERT INTO entity_states(entidade_id, tenant_id, agent_id, saldo_consolidado, saldo_atualizado_em)
     SELECT unnest($1::uuid[]), $2, $3, '1234.56', now()`,
    [entidade_ids.slice(0, Math.ceil(ENTITIES_PER_PAIR / 5)), tenant_id, agent_id],
  );

  const conversa = await c.query<{ id: string }>(
    `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, escopo_entidades)
     VALUES ($1, $2, $3, $4::uuid[]) RETURNING id`,
    [tenant_id, agent_id, pessoa_id, entidade_ids],
  );
  const conversa_id = conversa.rows[0]!.id;

  // 24 mensagens contra um `SECTION_BUDGETS.history.max_items` de 10: o
  // `ORDER BY created_at DESC LIMIT 10` precisa ter o que descartar.
  await c.query(
    `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, created_at)
     SELECT $1, $2, $3,
            CASE WHEN g % 2 = 0 THEN 'in' ELSE 'out' END,
            'texto',
            '${PREFIX} mensagem de histórico número ' || g || ' com corpo suficiente para o orçamento de bytes da seção de histórico não ser trivial.',
            now() - (g || ' minutes')::interval
     FROM generate_series(1, 24) g`,
    [tenant_id, agent_id, conversa_id],
  );

  // Fatos nos TRÊS escopos que o loader monta: global, pessoa e entidade.
  await c.query(
    `INSERT INTO agent_facts(tenant_id, agent_id, escopo, chave, valor, confianca, fonte)
     SELECT $1, $2, 'global', '${PREFIX}-fato-global-' || g,
            jsonb_build_object('content', '${PREFIX} fato global ' || g), 0.9, 'aprendido'
     FROM generate_series(1, 12) g`,
    [tenant_id, agent_id],
  );
  await c.query(
    `INSERT INTO agent_facts(tenant_id, agent_id, escopo, chave, valor, confianca, fonte)
     SELECT $1, $2, 'pessoa:' || $3, '${PREFIX}-fato-pessoa-' || g,
            jsonb_build_object('content', '${PREFIX} fato de pessoa ' || g), 0.9, 'aprendido'
     FROM generate_series(1, 12) g`,
    [tenant_id, agent_id, pessoa_id],
  );
  await c.query(
    `INSERT INTO agent_facts(tenant_id, agent_id, escopo, chave, valor, confianca, fonte)
     SELECT $1, $2, 'entidade:' || $3, '${PREFIX}-fato-entidade-' || g,
            jsonb_build_object('content', '${PREFIX} fato de entidade ' || g), 0.9, 'aprendido'
     FROM generate_series(1, 8) g`,
    [tenant_id, agent_id, entidade_ids[0]],
  );

  await c.query(
    `INSERT INTO learned_rules(tenant_id, agent_id, tipo, contexto, acao, confianca)
     SELECT $1, $2, 'classificacao', '${PREFIX} contexto ' || g, '${PREFIX} acao ' || g, 0.5 + (g % 5) * 0.1
     FROM generate_series(1, 40) g`,
    [tenant_id, agent_id],
  );

  await c.query(
    `INSERT INTO memory_entry(tenant_id, agent_id, content, memory_type, scope_type, subject_id,
                              sensitivity, proactive_use, mention_allowed)
     SELECT $1, $2, '${PREFIX} memória de agente ' || g, 'preference', 'agent', NULL, 'low', true, true
     FROM generate_series(1, 25) g`,
    [tenant_id, agent_id],
  );
  await c.query(
    `INSERT INTO memory_entry(tenant_id, agent_id, content, memory_type, scope_type, subject_id,
                              sensitivity, proactive_use, mention_allowed)
     SELECT $1, $2, '${PREFIX} memória de interlocutor ' || g, 'preference', 'interlocutor', $3, 'low', true, true
     FROM generate_series(1, 15) g`,
    [tenant_id, agent_id, pessoa_id],
  );
  await c.query(
    `INSERT INTO memory_entry(tenant_id, agent_id, content, memory_type, scope_type, subject_id,
                              sensitivity, proactive_use, mention_allowed)
     SELECT $1, $2, '${PREFIX} memória de conversa ' || g, 'preference', 'conversation', $3, 'low', true, true
     FROM generate_series(1, 15) g`,
    [tenant_id, agent_id, conversa_id],
  );

  await c.query(
    `INSERT INTO behavioral_hint(tenant_id, agent_id, scope_type, subject_id, hint_text, derived_sensitivity)
     SELECT $1, $2, 'agent', NULL, '${PREFIX} hint de agente ' || g, 'low'
     FROM generate_series(1, 15) g`,
    [tenant_id, agent_id],
  );
  await c.query(
    `INSERT INTO behavioral_hint(tenant_id, agent_id, scope_type, subject_id, hint_text, derived_sensitivity)
     SELECT $1, $2, 'interlocutor', $3, '${PREFIX} hint de interlocutor ' || g, 'low'
     FROM generate_series(1, 10) g`,
    [tenant_id, agent_id, pessoa_id],
  );
  await c.query(
    `INSERT INTO behavioral_hint(tenant_id, agent_id, scope_type, subject_id, hint_text, derived_sensitivity)
     SELECT $1, $2, 'conversation', $3, '${PREFIX} hint de conversa ' || g, 'low'
     FROM generate_series(1, 10) g`,
    [tenant_id, agent_id, conversa_id],
  );

  await c.query(
    `INSERT INTO agent_capabilities_skill(tenant_id, agent_id, domain, skill_name, confidence, evidence_count, success_count)
     SELECT $1, $2, 'financeiro', '${PREFIX}-skill-' || g, 0.7, 10, 9
     FROM generate_series(1, 12) g`,
    [tenant_id, agent_id],
  );
  await c.query(
    `INSERT INTO agent_capability_gaps(tenant_id, agent_id, capability_description, tipo, current_level,
                                       frequency_score, severity_score)
     SELECT $1, $2, '${PREFIX} lacuna de capacidade ' || g, 'knowledge',
            CASE WHEN g % 2 = 0 THEN 'mentionable' ELSE 'proposed' END, 3, 3
     FROM generate_series(1, 10) g`,
    [tenant_id, agent_id],
  );

  if (identity === 'profile') {
    await c.query(
      `INSERT INTO agent_operational_profile_versions
         (tenant_id, agent_id, version, status, profile_body, proposed_by, activated_at)
       VALUES ($1, $2, 1, 'active', $3::jsonb, '${PREFIX}', now())`,
      [
        tenant_id,
        agent_id,
        JSON.stringify({
          core_immutable: {
            identity_block: `Você é a Maia do tenant ${tenant_id}.`,
            principles: ['Backend decide, LLM propõe.', 'Nunca invente saldo.'],
          },
          operational_profile: { voice_descriptor: 'Direta, curta, sem floreio.' },
          episodic_temp: { entries: [] },
          growth_backlog: { items: [] },
        }),
      ],
    );
  } else {
    // Sem perfil v2 ativo, `loadIdentity` cai no `self_state` — um round-trip
    // A MAIS por turno, e não cacheável (o publisher não existe).
    await c.query(
      `INSERT INTO self_state(tenant_id, agent_id, versao, system_prompt, resumo_aprendizados, ativa)
       VALUES ($1, $2, 1, $3, $4, true)`,
      [tenant_id, agent_id, `Você é a Maia do tenant ${tenant_id}.`, 'Aprendizados acumulados.'],
    );
  }

  const pessoaRow = await c.query(`SELECT * FROM pessoas WHERE id = $1`, [pessoa_id]);
  const conversaRow = await c.query(`SELECT * FROM conversas WHERE id = $1`, [conversa_id]);
  const inboundRow = await c.query(
    `SELECT * FROM mensagens WHERE conversa_id = $1 AND direcao = 'in'
     ORDER BY created_at DESC LIMIT 1`,
    [conversa_id],
  );

  return {
    tenant_id,
    agent_id,
    pessoa_id,
    conversa_id,
    entidade_ids,
    pessoa: pessoaRow.rows[0] as Record<string, unknown>,
    conversa: conversaRow.rows[0] as Record<string, unknown>,
    inbound: inboundRow.rows[0] as Record<string, unknown>,
  };
}

/**
 * O `PromptContext` do turno.
 *
 * Montado UMA vez por (par, cardinalidade) e reusado: o que está sendo medido é
 * a carga de contexto, e construir o mapa de permissões dentro do relógio
 * mediria o harness. `byEntity` é o que o renderer percorre para escrever o
 * bloco "## Escopo desta conversa" — sem ele o turno renderiza um escopo vazio
 * e a cardinalidade deixa de custar o que custa em produção.
 *
 * É AQUI que o `resolveScope` sai da medição: o escopo nasce pronto, em
 * memória, e o custo real de resolvê-lo no Postgres nunca entra no relógio.
 * Ver a seção "o que ele NÃO mede" no topo do arquivo.
 */
function buildContext(pair: Pair, entities: number): unknown {
  const ids = pair.entidade_ids.slice(0, entities);
  const byEntity = new Map<string, unknown>();
  for (const id of ids) {
    byEntity.set(id, {
      permissao: { id: `${PREFIX}-perm-${id}`, entidade_id: id },
      profile: {
        id: `${PREFIX}-profile`,
        nome: `${PREFIX}-profile`,
        acoes: ['registrar_transacao'],
        limite_default: '100',
      },
      effective_limits: { valor_max: 100 },
    });
  }
  return {
    pessoa: pair.pessoa,
    conversa: pair.conversa,
    scope: { entidades: ids, byEntity },
    inbound: pair.inbound,
    activeRole: null,
    current_role_id: null,
    current_channel_id: null,
    // `undefined` (e não `null`) de propósito: é o caminho MAIS CARO, o que faz
    // o loader resolver a execução de procedimento por conta própria. Medir o
    // caminho barato e reportá-lo como o custo do turno seria escolher o
    // número em vez de medi-lo.
    activeExecution: undefined,
  };
}

// ============================================================================
// main
// ============================================================================

type Deps = Awaited<ReturnType<typeof loadDeps>>;

async function loadDeps() {
  const [
    clientMod,
    loaderMod,
    typesMod,
    promptMod,
    tenantMod,
    metricsMod,
    cacheMod,
    reposMod,
    configMod,
  ] = await Promise.all([
    import('@/db/client.js'),
    import('@/agent/turn-context/loader.js'),
    import('@/agent/turn-context/types.js'),
    import('@/agent/prompt-builder.js'),
    import('@/db/tenant-context.js'),
    import('@/lib/metrics.js'),
    import('@/agent/turn-context/cache.js'),
    import('@/db/repositories.js'),
    import('@/config/env.js'),
  ]);
  return {
    pool: clientMod.pool,
    // Não é o call site do turno (quem mede é `buildPrompt`), mas é importado
    // para o pré-aquecimento e para deixar explícito qual módulo está sob
    // medição.
    loadTurnContext: loaderMod.loadTurnContext,
    MAX_CONCURRENT_READS: typesMod.TURN_CONTEXT_MAX_CONCURRENT_READS,
    buildPrompt: promptMod.buildPrompt,
    runWithTenantContext: tenantMod.runWithTenantContext,
    renderPrometheus: metricsMod.renderPrometheus,
    resetMetrics: metricsMod._resetForTests,
    turnContextCache: cacheMod.turnContextCache,
    startSubscriber: cacheMod.startTurnContextCacheInvalidationSubscriber,
    stopSubscriber: cacheMod.stopTurnContextCacheInvalidationSubscriber,
    repos: reposMod,
    config: configMod.config,
  };
}

function instrumentAll(repos: Deps['repos']): void {
  instrument(repos.operationalProfileVersionsRepo, 'getActive', 'identity');
  instrument(repos.selfStateRepo, 'getActive', 'identity_self_state');
  instrument(repos.mensagensRepo, 'recentInConversation', 'history');
  instrument(repos.entidadesRepo, 'byIdsWithState', 'entities');
  instrument(repos.entityStatesRepo, 'byIds', 'entity_states');
  instrument(repos.factsRepo, 'listMentionableForScopes', 'facts');
  instrument(repos.rulesRepo, 'listActive', 'rules');
  instrument(repos.memoryEntryRepo, 'findRelevant', 'memories');
  instrument(repos.behavioralHintRepo, 'findActiveForScopes', 'hints');
  instrument(repos.capabilitiesSkillRepo, 'listAll', 'capabilities');
  instrument(repos.capabilityGapsRepo, 'listByLevels', 'gaps');
  instrument(repos.procedureExecutionsRepo, 'findActiveForConversa', 'procedure');
  instrument(repos.procedureDefinitionsRepo, 'findById', 'procedure_definition');
}

/**
 * Amostrador do pool. Saturado = alguém esperando por conexão, ou o pool cheio
 * sem nenhuma conexão ociosa. É a grandeza do critério "nenhuma saturação
 * contínua por 60 s" — que é sobre DURAÇÃO, não sobre um pico instantâneo, e
 * por isso o que se guarda é a maior SEQUÊNCIA.
 */
export function startPoolSampler(
  pool: PgPool,
  periodMs: number,
  startedAtMs = performance.now(),
): {
  markProducerStopped: (atMs?: number) => void;
  stop: (endedAtMs?: number) => PoolSamplingSummary;
} {
  const tracker = createPoolSaturationTracker(startedAtMs);
  const max = pool.options.max ?? 10;
  const timer = setInterval(() => {
    const saturated = pool.waitingCount > 0 || (pool.totalCount >= max && pool.idleCount === 0);
    tracker.observe(performance.now(), saturated);
  }, periodMs);
  timer.unref?.();
  return {
    markProducerStopped: (atMs = performance.now()) => tracker.markProducerStopped(atMs),
    stop: (endedAtMs = performance.now()) => {
      clearInterval(timer);
      return tracker.summary(endedAtMs);
    },
  };
}

/** Lê `count`/`sum` e estima p95 pelos buckets da série nomeada no aceite. */
async function readLoaderHistogram(
  renderPrometheus: Deps['renderPrometheus'],
): Promise<{ count: number; sum: number; p95: number }> {
  const text = await renderPrometheus();
  const METRIC = 'maia_turn_context_load_duration_ms';
  let count = 0;
  let sum = 0;
  const buckets: Array<{ le: number; n: number }> = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(METRIC)) continue;
    if (!line.includes('phase="loader"')) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (!Number.isFinite(value)) continue;
    if (line.startsWith(`${METRIC}_count`)) count += value;
    else if (line.startsWith(`${METRIC}_sum`)) sum += value;
    else if (line.startsWith(`${METRIC}_bucket`)) {
      const m = /le="([^"]+)"/.exec(line);
      if (!m) continue;
      const le = m[1] === '+Inf' ? Number.POSITIVE_INFINITY : Number(m[1]);
      const existing = buckets.find((b) => b.le === le);
      if (existing) existing.n += value;
      else buckets.push({ le, n: value });
    }
  }
  buckets.sort((a, b) => a.le - b.le);
  // Interpolação linear dentro do bucket, que é exatamente o que
  // `histogram_quantile` do Prometheus faz — é o número que o operador verá.
  const target = count * 0.95;
  let prevLe = 0;
  let prevN = 0;
  let p95 = 0;
  for (const b of buckets) {
    if (b.n >= target) {
      p95 = Number.isFinite(b.le)
        ? prevLe + ((target - prevN) / Math.max(1e-9, b.n - prevN)) * (b.le - prevLe)
        : prevLe;
      break;
    }
    prevLe = Number.isFinite(b.le) ? b.le : prevLe;
    prevN = b.n;
  }
  return { count, sum, p95 };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isTimeoutError(message: string): boolean {
  return /timeout|timed out|ETIMEDOUT/i.test(message);
}

type TurnSample = {
  ms: number;
  entities: number;
  peak: number;
  reads: Array<{ section: string; ms: number }>;
};

async function runArm(
  arm: ArmName,
  opts: Options,
  pairs: Pair[],
  deps: Deps,
): Promise<ArmResult> {
  // `FEATURE_TURN_CONTEXT_CACHE` é lido a CADA `readCached`, então virar a
  // chave entre braços no mesmo processo é suficiente e evita subir dois
  // processos só para trocar um booleano. A mutação é local ao harness e está
  // aqui, à vista, em vez de escondida num `.env` de benchmark.
  (deps.config as unknown as Record<string, boolean>).FEATURE_TURN_CONTEXT_CACHE = arm === 'warm';
  deps.turnContextCache.resetForTests();
  deps.resetMetrics();

  // Um `PromptContext` por (par, cardinalidade), pronto antes do relógio.
  const contexts = new Map<string, unknown>();
  for (let i = 0; i < pairs.length; i++) {
    for (const n of CARDINALITIES) contexts.set(`${i}:${n}`, buildContext(pairs[i]!, n));
  }

  /**
   * UM turno. Chama `buildPrompt` — o call site de PRODUÇÃO (`src/agent/
   * prompt-builder.ts`), que abre o frame do contador de queries, chama
   * `loadTurnContext` e publica `maia_turn_context_load_duration_ms
   * {phase="loader"}`. Medir por aqui, e não chamando o loader direto, é o que
   * faz o número deste harness ser a MESMA grandeza que o gate nomeia: um
   * harness que chamasse o loader e emitisse a métrica por conta própria
   * continuaria verde no dia em que `buildPrompt` parasse de chamar o loader.
   */
  const runTurn = (pairIndex: number, entities: number): Promise<unknown> => {
    const pair = pairs[pairIndex]!;
    const ctx = contexts.get(`${pairIndex}:${entities}`);
    return deps.runWithTenantContext(
      { tenant_id: pair.tenant_id, agent_id: pair.agent_id },
      () => deps.buildPrompt(ctx as Parameters<Deps['buildPrompt']>[0]),
    );
  };

  if (arm === 'warm') {
    // Pré-aquecimento: uma passada por par para popular o cache de identidade.
    // Sem isto o braço "warm" mediria 50 misses no meio da carga e a diferença
    // entre os braços viraria ruído.
    for (let i = 0; i < pairs.length; i++) await runTurn(i, 1);
    deps.resetMetrics();
  }

  const samples: TurnSample[] = [];
  const errorSamples: string[] = [];
  let errors = 0;
  let timeouts = 0;
  let issued = 0;
  let maxConcurrentTenants = 0;
  const inFlightTenants = new Map<string, number>();
  const exercisedPairs = new Set<string>();

  const startedAt = performance.now();
  const sampler = startPoolSampler(deps.pool, opts.sample_ms, startedAt);
  const sustainMs = opts.sustain_s * 1000;

  const worker = async (): Promise<void> => {
    for (;;) {
      const elapsed = performance.now() - startedAt;
      if (issued >= opts.turns && elapsed >= sustainMs) return;
      const index = issued++;
      const pairIndex = index % pairs.length;
      const pair = pairs[pairIndex]!;
      const entities = CARDINALITIES[index % CARDINALITIES.length]!;
      exercisedPairs.add(pair.tenant_id);

      inFlightTenants.set(pair.tenant_id, (inFlightTenants.get(pair.tenant_id) ?? 0) + 1);
      if (inFlightTenants.size > maxConcurrentTenants) maxConcurrentTenants = inFlightTenants.size;

      const frame: TurnFrame = {
        id: index,
        tenant: pair.tenant_id,
        entities,
        inflight: 0,
        peak: 0,
        reads: [],
      };
      const t0 = performance.now();
      try {
        await turnALS.run(frame, () => runTurn(pairIndex, entities));
        const ms = performance.now() - t0;
        samples.push({ ms, entities, peak: frame.peak, reads: frame.reads });
        if (ms > opts.timeout_ms) timeouts++;
      } catch (err) {
        errors++;
        const message = (err as Error)?.message ?? String(err);
        if (isTimeoutError(message)) timeouts++;
        if (errorSamples.length < 5) errorSamples.push(message);
      } finally {
        const n = (inFlightTenants.get(pair.tenant_id) ?? 1) - 1;
        if (n <= 0) inFlightTenants.delete(pair.tenant_id);
        else inFlightTenants.set(pair.tenant_id, n);
      }
      if (opts.think_ms > 0) await sleep(opts.think_ms);
    }
  };

  await Promise.all(Array.from({ length: opts.concurrency }, worker));

  // O PRODUTOR PAROU. Daqui em diante o harness não emite mais nenhum turno, e
  // o que se observa é o ESCOAMENTO.
  //
  // Sem esta janela não existe fase de escoamento para observar: o gerador é de
  // malha fechada, então quando `Promise.all` resolve todos os turnos já
  // terminaram e o amostrador era parado nesse mesmo instante. O critério
  // "drena depois que o produtor para" — que é o que o dono fixou para o perfil
  // de saturação — não teria UMA amostra em que se apoiar.
  const producerStoppedAt = performance.now();
  sampler.markProducerStopped(producerStoppedAt);
  // `wall_ms` continua sendo a duração da CARGA: é ela que responde "a janela
  // de 60 s foi observada?". A janela de escoamento é reportada à parte.
  const wall_ms = producerStoppedAt - startedAt;
  await sleep(opts.drain_window_ms);
  const endedAt = performance.now();
  const pool = poolMetricsFromSummary(sampler.stop(endedAt), opts.sample_ms);

  const all = samples.map((s) => s.ms).sort((a, b) => a - b);
  const hist = await readLoaderHistogram(deps.renderPrometheus);

  const by_cardinality: CardinalityStats[] = CARDINALITIES.map((entities) => {
    const arr = samples.filter((s) => s.entities === entities).map((s) => s.ms).sort((a, b) => a - b);
    return {
      entities,
      turns: arr.length,
      p50_ms: percentile(arr, 50),
      p95_ms: percentile(arr, 95),
      p99_ms: percentile(arr, 99),
      max_ms: arr.length ? arr[arr.length - 1]! : 0,
    };
  });

  const bySection = new Map<string, number[]>();
  for (const s of samples) {
    for (const r of s.reads) {
      const arr = bySection.get(r.section) ?? [];
      arr.push(r.ms);
      bySection.set(r.section, arr);
    }
  }
  const by_section: SectionLatency[] = [...bySection.entries()]
    .map(([section, arr]) => {
      arr.sort((a, b) => a - b);
      return { section, reads: arr.length, p50_ms: percentile(arr, 50), p95_ms: percentile(arr, 95) };
    })
    .sort((a, b) => b.p95_ms - a.p95_ms);

  const makespanNow = samples
    .map((s) => gateMakespan(s.reads.map((r) => r.ms), 6))
    .sort((a, b) => a - b);
  const makespanAt8 = samples
    .map((s) => gateMakespan(mergeTwoPairs(s.reads), 6))
    .sort((a, b) => a - b);

  const readsPerTurn = samples.map((s) => s.reads.length);
  const identity_cache = await readCacheOutcomes(deps.renderPrometheus);

  return {
    arm,
    turns: samples.length,
    wall_ms,
    concurrency: opts.concurrency,
    pairs_exercised: exercisedPairs.size,
    max_concurrent_tenants: maxConcurrentTenants,
    p50_ms: percentile(all, 50),
    p95_ms: percentile(all, 95),
    p99_ms: percentile(all, 99),
    max_ms: all.length ? all[all.length - 1]! : 0,
    p95_from_histogram_ms: hist.p95,
    errors,
    timeouts,
    error_samples: errorSamples,
    peak_reads_per_turn: samples.reduce((m, s) => Math.max(m, s.peak), 0),
    reads_per_turn_min: readsPerTurn.length ? Math.min(...readsPerTurn) : 0,
    reads_per_turn_max: readsPerTurn.length ? Math.max(...readsPerTurn) : 0,
    pool_max: deps.pool.options.max ?? 10,
    ...pool,
    pool_drain_window_ms: opts.drain_window_ms,
    think_ms: opts.think_ms,
    identity_cache,
    metric_count: hist.count,
    metric_sum_ms: hist.sum,
    by_cardinality,
    by_section,
    modelled_makespan_p95_now_ms: percentile(makespanNow, 95),
    modelled_makespan_p95_at_8_ms: percentile(makespanAt8, 95),
  };
}

async function readCacheOutcomes(
  renderPrometheus: Deps['renderPrometheus'],
): Promise<Record<string, number>> {
  const text = await renderPrometheus();
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (!line.startsWith('maia_turn_context_cache_total')) continue;
    const m = /result="([^"]+)"/.exec(line);
    if (!m) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) out[m[1]!] = (out[m[1]!] ?? 0) + value;
  }
  return out;
}

// ============================================================================
// Relatório
// ============================================================================

function fmt(n: number, digits = 1): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * A tarja do modo. É o que impede o operador de ler uma medição como um gate:
 * os dois modos imprimem a mesma tabela, e sem a tarja a única diferença
 * visível seria o exit code — que é justamente o que ele NÃO leu.
 */
function modeBanner(mode: RunMode, injected: string[]): string {
  if (mode === 'self-test') {
    return (
      `> **AUTOTESTE DO GATE — NÃO É MEDIÇÃO.**` +
      (injected.length ? ` Valores injetados: \`${injected.join('`, `')}\`.` : '') +
      `\n> Os números abaixo são sintéticos; servem apenas para provar que o gate reprova.\n\n`
    );
  }
  if (mode === 'measure') {
    return (
      `> **MEDIÇÃO ABSOLUTA — NÃO É O GATE.** Esta corrida NÃO emite veredicto de gate e\n` +
      `> sai com exit code 0 por ter medido, não por ter aprovado. Os critérios abaixo são\n` +
      `> informativos. O gate é \`npm run turn:bench -- --sustain-s 60\` (modo \`gate\`, o default).\n\n`
    );
  }
  return (
    `> **MODO GATE.** Todo critério obrigatório precisa ter sido AVALIADO: um critério\n` +
    `> \`n/a\` reprova a corrida, porque um gate sem a evidência não é um gate.\n` +
    (COBERTURA_DA_MEDICAO.resolve_scope_medido
      ? ''
      : `>\n> **E hoje um critério obrigatório É \`n/a\`: o aceite completo do orçamento do\n` +
        `> turno.** Enquanto o \`resolveScope\` estiver fora da medição, esta corrida NÃO\n` +
        `> pode sair 0 — e o exit code 1 significa "não demonstrado", não "regrediu".\n` +
        `> Leia os critérios parciais na tabela: eles foram avaliados e valem para o\n` +
        `> trecho que exercitam. Issue #700.\n`) +
    `\n`
  );
}

function renderReport(
  opts: Options,
  arms: ArmResult[],
  verdicts: Verdict[],
  baseline: BaselineFile | null,
  injected: string[],
  fingerprint: RunFingerprint,
): string {
  const head =
    `### Gate de carga de contexto do turno — issue #525\n\n` +
    modeBanner(opts.mode, injected) +
    `${opts.pairs} pares tenant/agente · concorrência ${opts.concurrency} · ` +
    `${opts.turns} turnos por braço (mín.)` +
    (opts.sustain_s ? ` · carga sustentada por ${opts.sustain_s}s` : '') +
    ` · entidades ${CARDINALITIES.join('/')} · identidade \`${opts.identity}\`\n` +
    `Pool: \`max=${arms[0]?.pool_max ?? 10}\` (\`src/db/client.ts\`) · ` +
    `teto de leituras por turno: ${opts.thresholds.max_peak_reads} ` +
    `(\`TURN_CONTEXT_MAX_CONCURRENT_READS\`)\n\n` +
    `> **Cobertura desta corrida: \`${coberturaAtual()}\`.**\n` +
    `> **Escopo do que foi medido — orçamento PARCIAL.** Este gate mede ` +
    `\`buildPrompt\`; o \`resolveScope\` (JOIN \`permissoes ⋈ ` +
    `permission_profiles\`) fica de FORA: o escopo é fabricado em memória ` +
    `pelo harness e a massa não semeia essas tabelas. Os números abaixo NÃO ` +
    `validam o custo completo do turno como definido em ` +
    `\`src/agent/turn-context/types.ts\`, e não devem ser apresentados como ` +
    `tal. Uma regressão que more no \`resolveScope\` passa por este gate sem ` +
    `ser vista.\n`;

  const rows: string[][] = [
    ['Métrica', ...arms.map((a) => `\`${a.arm}\``)],
    ['---', ...arms.map(() => '---')],
    ['turnos medidos', ...arms.map((a) => String(a.turns))],
    ['duração do braço (s)', ...arms.map((a) => fmt(a.wall_ms / 1000))],
    ['p50 (ms)', ...arms.map((a) => fmt(a.p50_ms))],
    ['**p95 (ms)**', ...arms.map((a) => `**${fmt(a.p95_ms)}**`)],
    ['**p99 (ms)**', ...arms.map((a) => `**${fmt(a.p99_ms)}**`)],
    ['máx (ms)', ...arms.map((a) => fmt(a.max_ms))],
    ['p95 pelos buckets do histograma (ms)', ...arms.map((a) => fmt(a.p95_from_histogram_ms, 0))],
    ['erros', ...arms.map((a) => String(a.errors))],
    ['timeouts', ...arms.map((a) => String(a.timeouts))],
    ['**pico de leituras simultâneas por turno**', ...arms.map((a) => `**${a.peak_reads_per_turn}**`)],
    ['leituras por turno (mín–máx)', ...arms.map((a) => `${a.reads_per_turn_min}–${a.reads_per_turn_max}`)],
    ['tenants concorrentes (máx.)', ...arms.map((a) => String(a.max_concurrent_tenants))],
    ['pares exercitados', ...arms.map((a) => String(a.pairs_exercised))],
    [
      'maior sequência com pool saturado (s)',
      ...arms.map((a) => fmt(a.pool_saturation_max_streak_ms / 1000)),
    ],
    [
      'amostras do pool saturadas',
      ...arms.map((a) => `${a.pool_saturated_samples}/${a.pool_samples}`),
    ],
    [
      'escoamento (produtor parado)',
      ...arms.map(
        (a) =>
          `${a.pool_drain_saturated_samples}/${a.pool_drain_samples} saturadas em ` +
          `${fmt(a.pool_drain_window_ms / 1000)}s · ` +
          (a.pool_drained_after_ms === NEVER_DRAINED
            ? '**não drenou**'
            : `drenou em ${fmt(a.pool_drained_after_ms, 0)}ms`),
      ),
    ],
    [
      'perfil',
      ...arms.map((a) => (a.think_ms === 0 ? '**saturação** (`--think-ms 0`)' : `normal (ritmo ${a.think_ms}ms)`)),
    ],
    [
      'amostragem do pool (cobertura · maior lacuna)',
      ...arms.map(
        (a) =>
          `${fmt(a.pool_sampled_span_ms / 1000)}s · ${fmt(a.pool_max_sample_gap_ms, 0)}ms ` +
          `(período ${a.pool_sample_ms}ms)`,
      ),
    ],
    [
      'cache de identidade',
      ...arms.map((a) =>
        Object.entries(a.identity_cache)
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([k, v]) => `${k}=${v}`)
          .join(' · ') || '—',
      ),
    ],
    [
      '`maia_turn_context_load_duration_ms{phase="loader"}`',
      ...arms.map((a) => `count=${a.metric_count} · sum=${fmt(a.metric_sum_ms, 0)}ms`),
    ],
  ];
  const table = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');

  const cardinality = [
    '\n#### Por cardinalidade de escopo\n',
    `| braço | entidades | turnos | p50 | p95 | p99 | máx |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    ...arms.flatMap((a) =>
      a.by_cardinality.map(
        (c) =>
          `| \`${a.arm}\` | ${c.entities} | ${c.turns} | ${fmt(c.p50_ms)} | ${fmt(c.p95_ms)} | ${fmt(c.p99_ms)} | ${fmt(c.max_ms)} |`,
      ),
    ),
  ].join('\n');

  const sections = [
    '\n#### Latência por leitura (onde o tempo do turno mora)\n',
    `| braço | leitura | n | p50 (ms) | p95 (ms) |`,
    `| --- | --- | --- | --- | --- |`,
    ...arms.flatMap((a) =>
      a.by_section.map(
        (s) => `| \`${a.arm}\` | ${s.section} | ${s.reads} | ${fmt(s.p50_ms, 2)} | ${fmt(s.p95_ms, 2)} |`,
      ),
    ),
  ].join('\n');

  const target8 = [
    '\n#### O que ≤8 round-trips valeria (modelo sobre as durações medidas)\n',
    `| braço | makespan p95 hoje (ms) | makespan p95 com 8 leituras (ms) | ganho |`,
    `| --- | --- | --- | --- |`,
    ...arms.map((a) => {
      const gain = a.modelled_makespan_p95_now_ms - a.modelled_makespan_p95_at_8_ms;
      const pct = a.p95_ms > 0 ? (gain / a.p95_ms) * 100 : 0;
      return `| \`${a.arm}\` | ${fmt(a.modelled_makespan_p95_now_ms, 2)} | ${fmt(a.modelled_makespan_p95_at_8_ms, 2)} | ${fmt(gain, 2)} ms (${fmt(pct, 2)}% do p95) |`;
    }),
    '',
    'O modelo reagenda as MESMAS durações medidas sob o mesmo semáforo de 6 permits,',
    'fundindo `capabilities ∪ gaps` e `facts ∪ rules` (os candidatos listados em',
    '`docs/architecture/modules/agent.md`) ao custo do MAIOR dos dois — otimista de propósito.',
  ].join('\n');

  const compat = checkBaselineCompatibility(baseline, fingerprint);
  const fingerprintRows = [
    '',
    '',
    'Forma da corrida (o que precisa bater para comparar dois p95):',
    '',
    `| campo | esta corrida | baseline |`,
    `| --- | --- | --- |`,
    ...(Object.keys(fingerprint) as Array<keyof RunFingerprint>).map((k) => {
      const mine = fingerprint[k];
      const theirs = baseline?.fingerprint?.[k];
      const show = (v: unknown): string => (v === undefined ? '—' : Array.isArray(v) ? v.join('/') : String(v));
      // Sem baseline não há divergência a apontar: marcar as sete linhas com ⚠
      // seria ruído sobre uma informação que o bloco acima já deu em caixa alta.
      const flag = theirs === undefined || show(mine) === show(theirs) ? '' : ' ⚠';
      return `| \`${k}\` | ${show(mine)} | ${show(theirs)}${flag} |`;
    }),
  ].join('\n');

  const baselineBlock =
    baseline && compat.status === 'ok'
      ? `\n#### Baseline\n\nRegistrado em ${baseline.recorded_at} por \`${baseline.recorded_by}\` (${baseline.host}).\n` +
        `${baseline.note}\n\n` +
        `| braço | p95 do baseline (ms) | p99 do baseline (ms) |\n| --- | --- | --- |\n` +
        Object.entries(baseline.arms)
          .map(([k, v]) => `| \`${k}\` | ${fmt(v.p95_ms)} | ${fmt(v.p99_ms)} |`)
          .join('\n') +
        fingerprintRows
      : baseline
        ? `\n#### Baseline\n\n**BASELINE RECUSADO — ele não mede a mesma carga que esta corrida.** ` +
          `A comparação foi RECUSADA, não apenas avisada: um baseline medido com outra forma de ` +
          `carga produz falso verde ou falso vermelho por mudança de CARGA, não de código ` +
          `(nesta PR, \`--think-ms\` sozinho move o p95 de 28,8 ms para 187,7 ms).\n\n` +
          compat.diffs.map((d) => `- ${d}`).join('\n') +
          `\n\nRe-grave com a forma desta corrida: ` +
          `\`npm run turn:bench -- --mode measure --sustain-s 60 --write-baseline\`.` +
          fingerprintRows
        : `\n#### Baseline\n\n**NÃO HÁ BASELINE REGISTRADO.** Nenhum \`${BASELINE_PATH}\` foi encontrado, ` +
          `então o critério "p95 ≤ baseline + ${(opts.thresholds.baseline_tolerance * 100).toFixed(0)}%" ` +
          `NÃO FOI AVALIADO nesta corrida — ele aparece como \`n/a\` na lista de veredictos, e ` +
          `${opts.mode === 'gate' ? '**em modo `gate` isso REPROVA a corrida**' : 'em modo `measure` isso é apenas informativo'}. ` +
          `Para gravar um baseline inicial: ` +
          `\`npm run turn:bench -- --mode measure --sustain-s 60 --write-baseline\`. ` +
          `O arquivo gravado diz explicitamente que é a primeira medição e não uma referência histórica.` +
          fingerprintRows;

  const naCount = verdicts.filter((v) => v.skipped).length;
  const failCount = verdicts.filter((v) => !v.passed && !v.skipped).length;
  const verdictBlock =
    '\n\n#### Veredictos\n\n' +
    verdicts
      .map(
        (v) =>
          `- ${v.skipped ? (opts.mode === 'measure' ? 'n/a   ' : 'n/a→REPROVA') : v.passed ? 'OK  ' : 'FALHOU'}` +
          ` — ${v.label}: ${v.detail}`,
      )
      .join('\n') +
    (opts.mode === 'measure'
      ? `\n\n**Nenhum veredicto de gate foi emitido** (modo \`measure\`): ${failCount} critério(s) ` +
        `fora do limite e ${naCount} não avaliado(s), todos informativos.`
      : `\n\n${failCount} critério(s) reprovado(s) e ${naCount} não avaliado(s). ` +
        `Em modo \`${opts.mode}\`, não avaliado conta como reprovação.`);

  return `${head}\n${table}\n${cardinality}\n${sections}\n${target8}\n${baselineBlock}${verdictBlock}\n`;
}

// ============================================================================
// Entrypoint
// ============================================================================

function readBaseline(): BaselineFile | null {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as BaselineFile;
}

function writeBaseline(
  arms: ArmResult[],
  opts: Options,
  fingerprint: RunFingerprint,
  existing: BaselineFile | null,
): void {
  const file: BaselineFile = {
    schema_version: BASELINE_SCHEMA_VERSION,
    recorded_at: new Date().toISOString(),
    recorded_by: process.env.USER ?? 'unknown',
    host: `${process.platform} node ${process.versions.node}`,
    note: existing
      ? 'Baseline re-medido. Substitui a referência anterior; o motivo pertence ao PR que fez esta troca.'
      : 'PRIMEIRA MEDIÇÃO — não havia baseline registrado antes desta corrida. ' +
        'Este arquivo não é uma referência histórica: é o ponto zero, e a folga de +20% ' +
        'sobre ele só passa a significar "não regrediu" a partir da PRÓXIMA corrida.',
    fingerprint,
    context: {
      timeout_ms: opts.timeout_ms,
      sample_ms: opts.sample_ms,
      node: process.versions.node,
      platform: process.platform,
      mode: opts.mode,
    },
    arms: Object.fromEntries(
      arms.map((a) => [
        a.arm,
        { p95_ms: a.p95_ms, p99_ms: a.p99_ms, turns: a.turns, wall_ms: a.wall_ms },
      ]),
    ),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(file, null, 2)}\n`);
}

export async function main(argv: string[]): Promise<number> {
  // `TURN_CONTEXT_MAX_CONCURRENT_READS` vem do CÓDIGO. Digitar "6" aqui faria o
  // gate concordar consigo mesmo quando alguém mudasse a constante.
  const { TURN_CONTEXT_MAX_CONCURRENT_READS } = await import('@/agent/turn-context/types.js');
  const opts = parseArgs(argv, TURN_CONTEXT_MAX_CONCURRENT_READS);

  // --- autoteste: prova o GATE, não mede nada ------------------------------
  if (opts.mode === 'self-test') {
    const arms = opts.arms.map((a) => syntheticPassingArm(a, opts.thresholds));
    // `pool_max` do braço sintético é 10, o mesmo de `src/db/client.ts`.
    const fingerprint = runFingerprint(opts, opts.thresholds.max_peak_reads, arms[0]?.pool_max ?? 10);
    // O baseline sai dos braços ANTES da injeção: com `--inject p95_ms=900` o
    // critério relativo reprova junto do absoluto, em vez de a injeção mover os
    // dois lados da comparação e se cancelar.
    const baseline = syntheticBaseline(
      opts.arms.map((a) => syntheticPassingArm(a, opts.thresholds)),
      fingerprint,
      opts.self_test_baseline,
    );
    const injected = applyInjection(arms, opts.inject);
    const verdicts = evaluateGate(arms, opts.thresholds, baseline, {
      mode: opts.mode,
      fingerprint,
    });
    const code = gateExitCode(verdicts, opts.mode);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ mode: opts.mode, self_test: true, injected, options: opts, fingerprint, arms, verdicts, exit_code: code }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(renderReport(opts, arms, verdicts, baseline, injected, fingerprint));
    }
    return code;
  }

  const pg = (await import('pg')).default;
  const seedPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

  if (opts.cleanup_only) {
    const c = await seedPool.connect();
    try {
      const removed = await cleanup(c);
      process.stdout.write(`removidas ${removed} linhas com tenant_id LIKE '${PREFIX}-%'\n`);
    } finally {
      c.release();
      await seedPool.end();
    }
    return 0;
  }

  const deps = await loadDeps();
  instrumentAll(deps.repos);
  deps.startSubscriber();

  let seeded = false;
  const onSignal = (): void => {
    // Um Ctrl-C no meio da carga não pode deixar 13 mil linhas no banco
    // COMPARTILHADO. A limpeza é síncrona-o-suficiente porque roda antes do
    // exit e o pool de seed tem conexões dedicadas.
    if (!seeded) process.exit(130);
    seedPool
      .connect()
      .then(async (c) => {
        try {
          await cleanup(c);
        } finally {
          c.release();
        }
      })
      .catch(() => undefined)
      .finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const c = await seedPool.connect();
    const pairs: Pair[] = [];
    try {
      // Massa órfã de uma corrida anterior abortada envenenaria os escopos.
      await cleanup(c);
      seeded = true;
      for (let i = 0; i < opts.pairs; i++) pairs.push(await seedPair(c, i, opts.identity));
    } finally {
      c.release();
    }

    const arms: ArmResult[] = [];
    for (const arm of opts.arms) arms.push(await runArm(arm, opts, pairs, deps));

    const fingerprint = runFingerprint(
      opts,
      opts.thresholds.max_peak_reads,
      deps.pool.options.max ?? 10,
    );
    const baselineBefore = readBaseline();
    const verdicts = evaluateGate(arms, opts.thresholds, baselineBefore, {
      mode: opts.mode,
      fingerprint,
    });
    const code = gateExitCode(verdicts, opts.mode);

    if (opts.write_baseline) writeBaseline(arms, opts, fingerprint, baselineBefore);

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ mode: opts.mode, self_test: false, options: opts, fingerprint, arms, verdicts, exit_code: code, gate_evaluated: opts.mode !== 'measure' }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(renderReport(opts, arms, verdicts, baselineBefore, [], fingerprint));
    }
    return code;
  } finally {
    const c = await seedPool.connect().catch(() => null);
    if (c) {
      try {
        await cleanup(c);
      } finally {
        c.release();
      }
    }
    await seedPool.end().catch(() => undefined);
    await deps.stopSubscriber().catch(() => undefined);
    await deps.pool.end().catch(() => undefined);
    const { redis } = await import('@/lib/redis.js');
    await redis.quit().catch(() => undefined);
  }
}

/**
 * Só roda `main()` quando este arquivo É o entrypoint — não quando um teste o
 * importa para exercitar `evaluateGate` (que é a parte que precisa ser provada
 * sem Postgres).
 */
export function isDirectInvocation(entry: string | undefined, metaUrl: string): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(`turn-context-benchmark falhou: ${(err as Error)?.message ?? String(err)}\n`);
      process.exit(2);
    },
  );
}
