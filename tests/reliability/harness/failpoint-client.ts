/**
 * Issue #510 (fatia B) — o lado do PROCESSO FILHO do failpoint.
 *
 * ═══ O contrato, em uma linha ═══════════════════════════════════════════════
 *
 * `await alcancar('after_turn_claim_before_running', { turn_id, attempt })`
 *
 * Com a injeção desligada, isso custa uma comparação de string e retorna. Com
 * ela ligada, o filho ANUNCIA que chegou ali e ESPERA a decisão do cenário.
 *
 * ═══ Por que o custo-zero importa tanto ═════════════════════════════════════
 *
 * Um failpoint mora no caminho de execução de um worker de verdade. Se o guard
 * fosse "monte o corpo, chame o fetch, veja que ninguém responde", ele mudaria
 * o comportamento do caminho que o teste existe para observar — e um harness
 * que altera o que mede não mede nada. Por isso a PRIMEIRA linha é a checagem
 * da env var: nada é construído, nada é importado, nada é aguardado quando a
 * injeção está desligada.
 *
 * ═══ E por que a recusa é FAIL-CLOSED depois disso ══════════════════════════
 *
 * Passada a checagem barata, o cliente chama `assertFailpointsAllowed()`, que
 * recusa em perfil de produção sem opt-out. A ordem é deliberada: o caminho
 * DESLIGADO é barato, e o caminho LIGADO é caro e desconfiado.
 *
 * ═══ As quatro respostas, e o que cada uma vale ════════════════════════════
 *
 *  `release`    — segue. É a resposta do gate liberado e do failpoint sem gate.
 *
 *  `error`      — `FailpointInjectedError`. Uma falha SINTÉTICA, e o nome do
 *                 erro diz isso: um cenário que a confunda com falha real
 *                 estaria provando o tratamento de erro do próprio harness.
 *
 *  `disconnect` — devolvido ao chamador em vez de lançado. Quem sabe o que
 *                 desconectar é o call site (um pool, um socket, um cliente
 *                 do Redis), não este módulo.
 *
 *  `kill`       — `SIGKILL` em `process.pid`. É o próprio processo, então não
 *                 existe risco de acertar PID alheio — a garantia que o
 *                 `ProcessSupervisor` protege com um registro fechado aqui é
 *                 estrutural. Nenhum `finally` roda, nenhum handler roda,
 *                 nenhum pool fecha: é a morte que a issue exige e que um
 *                 `throw` simulado não produz.
 *
 *                 O cenário PRECISA ter chamado `child.autorizarSaida()`
 *                 antes, senão o supervisor (corretamente) trata a morte como
 *                 saída inesperada e reprova. `armarKillEm()` faz os dois na
 *                 ordem certa.
 *
 * ═══ Um prazo próprio, sempre ═══════════════════════════════════════════════
 *
 * O `fetch` tem `AbortSignal.timeout`. Um gate esquecido pelo cenário não pode
 * virar um filho pendurado para sempre — ele vira um erro com o nome do
 * failpoint, que é diagnóstico.
 */
import {
  FAILPOINT_ENABLE_ENV,
  FAILPOINT_ENDPOINT_ENV,
  FAILPOINT_TOKEN_ENV,
  assertFailpointsAllowed,
  parseFailpointName,
} from './failpoints.js';
import { HEADER_TOKEN, ROTA_BARREIRA, ROTA_REACHED } from './failpoint-transport.js';

/** A falha SINTÉTICA. Nome próprio para não se confundir com falha real. */
export class FailpointInjectedError extends Error {
  readonly failpoint: string;
  constructor(failpoint: string) {
    super(`failpoint "${failpoint}" injetou uma falha SINTÉTICA (ação "error").`);
    this.name = 'FailpointInjectedError';
    this.failpoint = failpoint;
  }
}

/** O handshake não completou. Diagnóstico, nunca silêncio. */
export class FailpointTransportError extends Error {
  constructor(failpoint: string, causa: string) {
    super(
      `failpoint "${failpoint}": o handshake com o harness falhou (${causa}). ` +
        `Ou o cenário fechou o servidor com um gate ainda armado, ou ${FAILPOINT_ENDPOINT_ENV} ` +
        'aponta para o lugar errado.',
    );
    this.name = 'FailpointTransportError';
  }
}

/** O que o call site precisa fazer depois de o failpoint devolver. */
export type AcaoLocal = 'release' | 'disconnect';

export interface OpcoesDeAlcance {
  /** Prazo do handshake. Default 60s — um gate `pause` dura o que o cenário quiser. */
  timeoutMs?: number;
  /** Ambiente. Injetável para o self-test; em produção do filho é `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * A injeção está ligada NESTE processo? Checagem barata e sem efeito — é o
 * guard que mantém o failpoint zero-custo no caminho normal.
 */
export function injecaoLigada(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[FAILPOINT_ENABLE_ENV] === '1' && typeof env[FAILPOINT_ENDPOINT_ENV] === 'string';
}

/**
 * ALCANÇOU o failpoint. Anuncia, espera a decisão do cenário e a aplica.
 *
 * `contexto` são os IDs que provam ao cenário que este é o anúncio certo
 * (`turn_id`, `attempt`, `worker_id`). Só string e número: o transporte
 * descarta o resto, e essa restrição é o que impede payload de usuário de
 * viajar por um canal de controle.
 */
export async function alcancar(
  failpointBruto: string,
  contexto: Readonly<Record<string, string | number>> = {},
  opts: OpcoesDeAlcance = {},
): Promise<AcaoLocal> {
  const env = opts.env ?? process.env;
  // PRIMEIRA linha, e de propósito: com a injeção desligada, o custo de um
  // failpoint no caminho de produção é esta comparação.
  if (!injecaoLigada(env)) return 'release';

  // Nome errado falha AQUI, no filho, no instante em que o call site roda —
  // e não trinta segundos depois num `waitForReached` que nunca observa nada.
  const failpoint = parseFailpointName(failpointBruto);
  const action = await falar(
    env,
    ROTA_REACHED,
    { failpoint, context: contexto },
    failpoint,
    opts.timeoutMs ?? 60_000,
  );

  switch (action) {
    case 'release':
    case undefined:
      return 'release';
    case 'disconnect':
      return 'disconnect';
    case 'error':
      throw new FailpointInjectedError(failpoint);
    case 'kill':
      // SIGKILL no PRÓPRIO pid. Nada roda depois desta linha — o `await` que
      // a segue existe só para o tipo de retorno, e nunca resolve.
      process.kill(process.pid, 'SIGKILL');
      return await new Promise<never>(() => {});
    default:
      throw new FailpointTransportError(failpoint, `ação desconhecida "${String(action)}"`);
  }
}

/**
 * BARREIRA: para aqui até o cenário dar o tiro de largada.
 *
 * É o que transforma "duas réplicas subiram" em "duas réplicas correram". Sem
 * ela, quem vence a corrida do claim é quem terminou de importar o grafo de
 * módulos primeiro — uma diferença de segundos que não tem nada a ver com a
 * exclusão mútua que o cenário quer provar.
 *
 * Não é um failpoint e não passa pelo catálogo: o catálogo é a lista fechada
 * dos pontos que a PRODUÇÃO tem, e uma barreira não é um deles.
 */
export async function barreira(
  nome: string,
  opts: OpcoesDeAlcance = {},
): Promise<AcaoLocal> {
  const env = opts.env ?? process.env;
  if (!injecaoLigada(env)) return 'release';
  await falar(env, ROTA_BARREIRA, { barreira: nome }, `barreira:${nome}`, opts.timeoutMs ?? 60_000);
  return 'release';
}

/** O fio propriamente dito. Um lugar só para o token, o prazo e o diagnóstico. */
async function falar(
  env: Readonly<Record<string, string | undefined>>,
  rota: string,
  corpo: Record<string, unknown>,
  rotulo: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const token = env[FAILPOINT_TOKEN_ENV];
  assertFailpointsAllowed(env, token);
  const url = `${String(env[FAILPOINT_ENDPOINT_ENV]).replace(/\/$/, '')}${rota}`;
  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [HEADER_TOKEN]: String(token) },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (erro) {
    throw new FailpointTransportError(rotulo, erro instanceof Error ? erro.message : String(erro));
  }
  if (!resposta.ok) {
    throw new FailpointTransportError(rotulo, `HTTP ${resposta.status} ${await resposta.text()}`);
  }
  const { action } = (await resposta.json()) as { action?: string };
  return action;
}
