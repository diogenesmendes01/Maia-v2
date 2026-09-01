/**
 * Issue #510 (fatia B) — self-tests do TRANSPORTE de failpoint.
 *
 * O harness precisa testar a si próprio, e a issue lista nominalmente o que:
 * "failpoint inexistente falha cedo", "gate duplicado/conflitante é rejeitado",
 * "timeout de handshake gera diagnóstico", "eventually imprime último estado".
 * A fatia A cobriu isso no `FailpointGateRegistry`, que é puro. Aqui a mesma
 * lista é cobrada do FIO — servidor HTTP de verdade, cliente de verdade,
 * processo filho de verdade nos casos em que só um processo serve.
 *
 * A afirmação central, e a que não pode ser vácuo: com um gate `pause` armado,
 * o filho PARA. Não "demora um pouco" — para, e não sai de lá até o cenário
 * mandar. É essa propriedade que faz um `hardKill` acertar um ponto exato do
 * caminho de execução em vez de "algum lugar por ali".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FAILPOINT_ENABLE_ENV,
  FAILPOINT_ENDPOINT_ENV,
  FAILPOINT_TOKEN_ENV,
  FailpointsForbiddenError,
  UnknownFailpointError,
} from '../harness/failpoints.js';
import {
  FailpointInjectedError,
  FailpointTransportError,
  alcancar,
  barreira,
  injecaoLigada,
} from '../harness/failpoint-client.js';
import { FailpointServer, HEADER_TOKEN, ROTA_REACHED } from '../harness/failpoint-transport.js';
import { estavelDurante } from '../harness/eventually.js';
import { ArtifactCollector } from '../harness/artifacts.js';
import { ProcessSupervisor } from '../harness/process-supervisor.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const FIXTURE_GATE = resolve(AQUI, '..', 'fixtures', 'filho-no-gate.ts');
const RAIZ = resolve(AQUI, '..', '..', '..');
/**
 * `--import tsx` e NÃO o CLI do tsx: o CLI spawna um NETO para aplicar os flags
 * do loader, e o pid que o supervisor registra passa a ser o do invólucro — um
 * `hardKill` que mata a casca e deixa vivo o processo que interessa. A armadilha
 * está documentada em `tests/reliability/README.md` desde a fatia D da #513, e
 * cada caso aqui volta a cobrá-la (`carga.pid === filho.pid`).
 */
const CARREGADOR_TSX = '--import tsx';

let servidor: FailpointServer;
let artefatos: ArtifactCollector;

/** O ambiente que um filho receberia — montado aqui, nunca lido do processo. */
function envDeFilho(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...servidor.envDoFilho(), ...extra };
}

describe('#510 harness — transporte de failpoint', () => {
  beforeEach(async () => {
    artefatos = new ArtifactCollector('510-transporte', 'sem-seed');
    servidor = await FailpointServer.iniciar({ artefatos });
  });

  afterEach(async () => {
    await servidor.fechar();
  });

  it('escuta só em loopback e em porta efêmera — não há superfície pública', () => {
    expect(servidor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(servidor.url).not.toContain('0.0.0.0');
    expect(Number(new URL(servidor.url).port)).toBeGreaterThan(0);
  });

  it('sem gate armado, o failpoint devolve `release` e não custa nada', async () => {
    const acao = await alcancar('after_running_before_llm', { turn_id: 't1' }, { env: envDeFilho() });
    expect(acao).toBe('release');
  });

  it('com a injeção DESLIGADA o cliente nem fala com o servidor', async () => {
    // O caminho zero-custo: sem `TEST_RELIABILITY_FAILPOINTS=1` não há fetch,
    // e por isso um endpoint impossível não atrapalha.
    const env = { [FAILPOINT_ENDPOINT_ENV]: 'http://127.0.0.1:1' };
    expect(injecaoLigada(env)).toBe(false);
    await expect(alcancar('during_llm_request', {}, { env })).resolves.toBe('release');
  });

  it('failpoint inexistente falha CEDO, no filho, antes de qualquer rede', async () => {
    await expect(
      alcancar('nao_existe_esse_ponto', {}, { env: envDeFilho() }),
    ).rejects.toBeInstanceOf(UnknownFailpointError);
  });

  it('recusa em perfil de produção — sem opt-out, nem com token válido', async () => {
    await expect(
      alcancar('during_llm_request', {}, { env: envDeFilho({ MAIA_ENV: 'production' }) }),
    ).rejects.toBeInstanceOf(FailpointsForbiddenError);
  });

  it('o SERVIDOR não sobe em perfil de produção — nem abre socket', async () => {
    const antes = process.env.MAIA_ENV;
    process.env.MAIA_ENV = 'production';
    try {
      await expect(FailpointServer.iniciar()).rejects.toBeInstanceOf(FailpointsForbiddenError);
    } finally {
      if (antes === undefined) delete process.env.MAIA_ENV;
      else process.env.MAIA_ENV = antes;
    }
  });

  it('token de OUTRA rodada não arma nada — o SERVIDOR recusa, e diz por quê', async () => {
    // Quem decide é o servidor, e tinha de ser: o filho só conhece o token que
    // recebeu no ambiente, então uma checagem local só compararia a variável
    // consigo mesma. Este é exatamente o acidente que o token existe para
    // cobrir — um processo que herdou `TEST_RELIABILITY_FAILPOINTS` do ambiente
    // de outro job e aponta para um harness que não é o dele.
    await expect(
      alcancar(
        'during_llm_request',
        {},
        { env: envDeFilho({ [FAILPOINT_TOKEN_ENV]: 'token-de-outra-rodada' }) },
      ),
    ).rejects.toThrow(/HTTP 403 .*token_invalido/);
    // E o gate continua ARMADO: a recusa não consumiu nada.
    servidor.arm('during_llm_request', 'pause');
    expect(servidor.registry.armado('during_llm_request')).toBeDefined();
    servidor.disarm('during_llm_request');
  });

  it('requisição sem o header do token é recusada com 403', async () => {
    const r = await fetch(`${servidor.url}${ROTA_REACHED}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ failpoint: 'during_llm_request' }),
    });
    expect(r.status).toBe(403);
  });

  it('rota desconhecida é 404 — não há nada a enumerar', async () => {
    const r = await fetch(`${servidor.url}/qualquer-coisa`, {
      method: 'POST',
      headers: { [HEADER_TOKEN]: servidor.token },
    });
    expect(r.status).toBe(404);
  });

  it('gate `error` injeta uma falha SINTÉTICA, com nome próprio', async () => {
    servidor.arm('after_llm_before_tool', 'error');
    await expect(
      alcancar('after_llm_before_tool', {}, { env: envDeFilho() }),
    ).rejects.toBeInstanceOf(FailpointInjectedError);
  });

  it('gate `disconnect` volta ao call site em vez de lançar', async () => {
    servidor.arm('during_lease_heartbeat', 'disconnect');
    await expect(alcancar('during_lease_heartbeat', {}, { env: envDeFilho() })).resolves.toBe(
      'disconnect',
    );
  });

  it('gate duplicado é recusado no mesmo failpoint', () => {
    servidor.arm('after_turn_claim_before_running', 'pause');
    expect(() => servidor.arm('after_turn_claim_before_running', 'pause')).toThrow(
      /Gate duplicado/,
    );
  });

  it('o contexto do anúncio chega ao cenário — e só string/número passam', async () => {
    servidor.arm('after_running_before_llm', 'pause');
    const chamada = alcancar(
      'after_running_before_llm',
      // `conteudo` é objeto: o transporte o descarta. É o que impede payload de
      // usuário de viajar por um canal de controle.
      { turn_id: 'turno-42', attempt: 2, conteudo: { texto: 'oi' } } as never,
      { env: envDeFilho() },
    );
    const evento = await servidor.waitForReached('after_running_before_llm', { timeoutMs: 5_000 });
    expect(evento.context).toEqual({ turn_id: 'turno-42', attempt: 2 });
    servidor.liberar('after_running_before_llm');
    await expect(chamada).resolves.toBe('release');
  });

  it('o handshake que não chega estoura com diagnóstico do que estava armado', async () => {
    servidor.arm('before_successor_promotion', 'pause');
    await expect(
      servidor.waitForReached('before_successor_promotion', { timeoutMs: 120 }),
    ).rejects.toThrow(/Gates armados no momento do estouro: before_successor_promotion:pausex1/);
  });

  it('`liberar` devolve QUANTOS partiram — zero é um fato, não um sucesso', async () => {
    expect(servidor.liberar('after_running_before_llm')).toBe(0);
    servidor.arm('after_running_before_llm', 'pause');
    const chamada = alcancar('after_running_before_llm', {}, { env: envDeFilho() });
    await servidor.waitForReached('after_running_before_llm', { timeoutMs: 5_000 });
    expect(servidor.liberar('after_running_before_llm')).toBe(1);
    await chamada;
  });

  it('esperarParadoEm fecha a janela entre "chegou" e "estacionou" — a corrida que reprovou a FI-17', async () => {
    // O DEFEITO, reproduzido de forma determinística: um cenário que decide
    // soltar o gate com base num sinal INDIRETO pode soltá-lo antes de o filho
    // estacionar. `liberar` devolve 0, e a asserção `.toBe(1)` reprova — foi
    // literalmente isto no CI, na main:
    //
    //     ❯ fi-outbound-entrega.spec.ts:359
    //       expect(servidor.liberar('after_provider_accept_before_delivery_persist'))
    //       - 1
    //       + 0
    //
    // Aqui o "sinal indireto" é o instante ANTES de o filho subir. Não é
    // preciso um runner lento para provar: basta soltar cedo.
    servidor.arm('after_running_before_llm', 'pause');
    expect(
      servidor.liberar('after_running_before_llm'),
      'soltar um gate vazio devolve 0 — é o modo de falha que o primitivo fecha',
    ).toBe(0);

    const chamada = alcancar('after_running_before_llm', {}, { env: envDeFilho() });

    // E o CONTROLE: com o primitivo, a mesma solta acontece depois de o filho
    // estacionar, e devolve 1. Sem este par, "reprova sempre" também passaria
    // no caso acima.
    await servidor.esperarParadoEm('after_running_before_llm', 1, 10_000);
    expect(servidor.paradosEm('after_running_before_llm')).toBe(1);
    expect(servidor.liberar('after_running_before_llm')).toBe(1);
    await expect(chamada).resolves.toBe('release');
  });

  it('esperarParadoEm estoura dizendo QUANTOS chegaram, não só que estourou', async () => {
    // "Ninguém chegou" e "chegou um de dois" pedem investigações opostas: a
    // primeira é o filho que não subiu, a segunda é a réplica que travou antes
    // do ponto. Um estouro mudo obrigaria a rodar de novo para descobrir qual.
    servidor.arm('before_successor_promotion', 'pause');
    await expect(
      servidor.esperarParadoEm('before_successor_promotion', 2, 120),
    ).rejects.toThrow(/esperei 2 filho\(s\) PARADO\(s\) em 120ms e chegaram 0/);
  });

  it('a barreira solta N réplicas de uma vez só', async () => {
    const tres = [1, 2, 3].map(() => barreira('largada', { env: envDeFilho() }));
    await servidor.esperarNaBarreira('largada', 3, 5_000);
    expect(servidor.naBarreiraContagem('largada')).toBe(3);
    expect(servidor.abrirBarreira('largada')).toBe(3);
    await expect(Promise.all(tres)).resolves.toEqual(['release', 'release', 'release']);
  });

  it('a barreira que ninguém alcança estoura dizendo quantos chegaram', async () => {
    await expect(servidor.esperarNaBarreira('ninguem', 2, 120)).rejects.toThrow(
      /esperei 2 réplica\(s\) em 120ms e chegaram 0/,
    );
  });

  it('`fechar()` solta quem estava parado — nenhum filho pendurado', async () => {
    servidor.arm('after_outbound_claim_before_send', 'pause');
    const chamada = alcancar('after_outbound_claim_before_send', {}, { env: envDeFilho() });
    await servidor.waitForReached('after_outbound_claim_before_send', { timeoutMs: 5_000 });
    expect(servidor.pendentes()).toHaveLength(1);
    await servidor.fechar();
    await expect(chamada).resolves.toBe('release');
  });

  it('o prazo do cliente estoura com o nome do failpoint, e não em silêncio', async () => {
    servidor.arm('after_outbox_commit_before_delivery_enqueue', 'pause');
    await expect(
      alcancar(
        'after_outbox_commit_before_delivery_enqueue',
        {},
        { env: envDeFilho(), timeoutMs: 150 },
      ),
    ).rejects.toBeInstanceOf(FailpointTransportError);
    servidor.liberar('after_outbox_commit_before_delivery_enqueue');
  });
});

/**
 * Um PROCESSO parado num gate. É a propriedade que nenhum teste in-process
 * consegue afirmar: enquanto o gate não é liberado, o filho não avança uma
 * linha — e é isso que faz um `hardKill` acertar um ponto exato.
 */
describe('#510 harness — o gate PARA um processo de verdade', () => {
  let sup: ProcessSupervisor;

  beforeEach(async () => {
    artefatos = new ArtifactCollector('510-transporte-processo', 'sem-seed');
    servidor = await FailpointServer.iniciar({ artefatos });
    sup = new ProcessSupervisor(artefatos);
  });

  afterEach(async () => {
    await sup.dispose();
    await servidor.fechar();
  });

  it('o filho para no gate, é morto ali, e NUNCA imprime a linha seguinte', async () => {
    servidor.arm('after_turn_claim_before_running', 'pause');
    const filho = sup.spawn({
      label: 'filho-no-gate',
      script: FIXTURE_GATE,
      cwd: RAIZ,
      env: { ...servidor.envDoFilho(), [FAILPOINT_ENABLE_ENV]: '1', NODE_OPTIONS: CARREGADOR_TSX },
      readyTimeoutMs: 30_000,
    });
    const carga = await filho.esperarPronto(30_000);
    // A premissa de todo `hardKill` desta suíte: o pid que o supervisor mata é
    // o pid do processo que está no gate.
    expect(carga.pid).toBe(filho.pid);

    const evento = await servidor.waitForReached('after_turn_claim_before_running', {
      timeoutMs: 15_000,
    });
    expect(evento.context).toMatchObject({ etapa: 'antes' });
    expect(filho.stdout).toContain('##fi-antes##');

    // A LINHA SEGUINTE não existe — e a afirmação precisa de JANELA, não de
    // leitura instantânea: logo depois do anúncio o filho ainda não teve tempo
    // de imprimir nada, então um `not.toContain` seco passaria mesmo com o
    // gate liberando na hora. `estavelDurante` reprova no instante em que a
    // linha aparecer.
    await estavelDurante(() => filho.stdout.includes('##fi-depois##'), {
      label: 'o filho PARADO no gate não avança para a linha seguinte',
      janelaMs: 600,
      intervalMs: 30,
      justificativa:
        'a invariante é NEGATIVA ("não avançou"); não existe evento de linha que não foi impressa',
    });
    expect(filho.stdout).not.toContain('##fi-depois##');

    sup.hardKill(filho);
    const enc = await filho.esperarSaida(5_000);
    expect(enc.signal).toBe('SIGKILL');
    // E continua não existindo depois da morte — nenhum `finally`, nenhum
    // handler de saída, nada. É a diferença entre `SIGKILL` e `throw`.
    expect(filho.stdout).not.toContain('##fi-depois##');
  }, 60_000);

  it('a ação `kill` mata o filho DENTRO do failpoint, sem passar por finally', async () => {
    servidor.arm('after_turn_claim_before_running', 'kill');
    const filho = sup.spawn({
      label: 'filho-suicida',
      script: FIXTURE_GATE,
      cwd: RAIZ,
      env: { ...servidor.envDoFilho(), NODE_OPTIONS: CARREGADOR_TSX },
      readyTimeoutMs: 30_000,
    });
    const carga = await filho.esperarPronto(30_000);
    expect(carga.pid).toBe(filho.pid);
    // O cenário AUTORIZA a saída antes: sem isso o supervisor (corretamente)
    // trataria a morte pedida pelo próprio cenário como saída inesperada.
    filho.autorizarSaida();

    const enc = await filho.esperarSaida(10_000);
    expect(enc.signal).toBe('SIGKILL');
    expect(filho.stdout).toContain('##fi-antes##');
    expect(filho.stdout).not.toContain('##fi-depois##');
    expect(filho.stdout).not.toContain('##fi-finally##');
  }, 60_000);

  it('liberado, o filho segue e imprime a linha seguinte', async () => {
    servidor.arm('after_turn_claim_before_running', 'pause');
    const filho = sup.spawn({
      label: 'filho-liberado',
      script: FIXTURE_GATE,
      cwd: RAIZ,
      env: { ...servidor.envDoFilho(), NODE_OPTIONS: CARREGADOR_TSX },
      readyTimeoutMs: 30_000,
    });
    await filho.esperarPronto(30_000);
    await servidor.waitForReached('after_turn_claim_before_running', { timeoutMs: 15_000 });
    expect(filho.stdout).not.toContain('##fi-depois##');

    servidor.liberar('after_turn_claim_before_running');
    const enc = await filho.esperarSaida(10_000);
    expect(enc.code).toBe(0);
    expect(filho.stdout).toContain('##fi-depois##');
    expect(filho.stdout).toContain('##fi-finally##');
  }, 60_000);
});
