/**
 * P01 — CARACTERIZAÇÃO de `runReActLoop` (`src/agent/react-loop.ts`).
 *
 * Spec Maia+Hermes §5.1.1 (tabela "Detalhes que a extração não pode apagar"),
 * §5.4 (desfechos ReAct) e §5.10.3 (aceite "Paridade local").
 *
 * ─── O que este arquivo é, e o que ele NÃO é ────────────────────────────────
 *
 * É a PRIMEIRA suíte unitária de `runReActLoop`. Antes dela, as únicas specs
 * que executavam a função eram de integração com banco real
 * (`tests/integration/turn-lease-lost-react-loop-real-db.spec.ts`,
 * `turn-lease-lost-reasoner-real-db.spec.ts`), que fazem `describe.skip` sem
 * `TEST_DB_URL` — e toda spec unitária do core SUBSTITUI o laço inteiro por um
 * dublê (`tests/unit/agent-core-channel-resolution.spec.ts:134`). Ou seja: as
 * linhas da tabela §5.1.1 estavam, até aqui, ou só em integração ou sem
 * nenhuma asserção.
 *
 * NÃO é uma suíte de "comportamento desejado". É caracterização: ela PINA o
 * comportamento ATUAL, **inclusive o defeituoso** — ver o bloco
 * "DISCREPÂNCIA CONHECIDA" lá embaixo. Um caso vermelho durante a extração do
 * engine significa uma de duas coisas, e as duas são úteis:
 *
 *   1. a extração mudou comportamento sem querer → conserte o código; ou
 *   2. a mudança é intencional → o diff DESTE arquivo é a nota de
 *      compatibilidade que §5.10.3 pede ("Marcar correção de sumários como
 *      mudança intencional").
 *
 * Cada caso carrega um comentário curto dizendo QUAL comportamento congela e
 * por que ele importa para a extração.
 *
 * ─── Por que dublês e não injeção de dependência ────────────────────────────
 *
 * `tests/unit/agent-execute-skill.spec.ts` prova que a casa também aceita DI
 * (`ExecuteSelectedSkillDeps`), o que sairia mais barato. Mas caracterização
 * não pode pedir mudança na fronteira que ela existe para medir: `runReActLoop`
 * tem a assinatura que tem HOJE, e é essa que a extração vai substituir. Os
 * dublês seguem o padrão da casa (`vi.hoisted` + factories de `vi.mock`),
 * copiado de `tests/unit/output-dispatch-delivery-phase.spec.ts:21-45`.
 *
 * Ficam REAIS de propósito, porque são o que dá sentido às asserções:
 *   - `@/runtime/turns/execution-context.js` — `TurnOwnershipLostError` precisa
 *     ser a classe real para o `instanceof` valer (precedente:
 *     `tests/unit/decision-engine-trace-ownership-boundary.spec.ts:50-56`), e
 *     `assertTurnOwnership` real permite dirigir a perda de posse de verdade,
 *     abrindo um `runWithTurnExecution` com o sinal abortado;
 *   - `@/runtime/outbound/egress-guard.js` + `send-paths.ts` — assim o teste
 *     da reação PROVA que `agent.react_loop_tool_reaction` é uma exceção de
 *     egresso DECLARADA, em vez de supor;
 *   - `./gap-detector.js`, `./tool-execution-summary.js` e `@/lib/utils.js`
 *     (`uuid`) — funções puras; dublá-las apagaria justamente o que se mede.
 *
 * Esta suíte é unitária: não exige Postgres nem Redis.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';
import type { LLMMessage, LLMResponse } from '@/lib/llm/types.js';
import type { RunReActLoopParams, ReActLoopResult } from '@/agent/react-loop.js';
import type { TurnExecutionContext } from '@/runtime/turns/claim.js';
import {
  runWithTurnExecution,
  TurnOwnershipLostError,
} from '@/runtime/turns/execution-context.js';
import { currentEgressAuthorization } from '@/runtime/outbound/egress-guard.js';

// ─── Dublês ──────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  runCognitiveModule: vi.fn(),
  callLLM: vi.fn(),
  dispatchTool: vi.fn(),
  safeDispatchOutput: vi.fn(),
  mensagensCreate: vi.fn(),
  findActiveSnapshot: vi.fn(),
  audit: vi.fn(),
  forCurrentAgentChannel: vi.fn(),
  sendReaction: vi.fn(),
  reflect: vi.fn(),
  classify: vi.fn(),
  persistCandidate: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  /**
   * O `REGISTRY` é lido POR CHAMADA (`REGISTRY[tu.tool]`), então um objeto
   * mutável estável basta: cada caso declara as tools que precisa.
   */
  registry: {} as Record<string, { side_effect: string; sensitive?: boolean }>,
  /** Índices (1-based) com que `instrumentReactIteration` foi envolvido. */
  spansDeIteracao: [] as number[],
}));

vi.mock('@/cognition/runner.js', () => ({ runCognitiveModule: h.runCognitiveModule }));
vi.mock('@/lib/claude.js', () => ({ callLLM: h.callLLM }));
vi.mock('@/tools/_dispatcher.js', () => ({ dispatchTool: h.dispatchTool }));
vi.mock('@/tools/_registry.js', () => ({ REGISTRY: h.registry }));
vi.mock('@/agent/output-dispatch.js', () => ({ safeDispatchOutput: h.safeDispatchOutput }));
vi.mock('@/db/repositories.js', () => ({
  mensagensRepo: { create: h.mensagensCreate },
  pendingQuestionsRepo: { findActiveSnapshot: h.findActiveSnapshot },
}));
/**
 * `react-loop` importa `pgErrorCode` de `@/db/client.js`, e aquele módulo abre
 * um `pg.Pool` no topo a partir de `DATABASE_URL` — numa rodada unitária (sem
 * `TEST_DB_URL`) o import falha. O dublê do SQLSTATE é o mesmo das specs que já
 * fazem isso (`tests/unit/db/createinbound-stream-fail-closed.spec.ts:159`,
 * `tests/unit/onboarding/audit-fk-safety.spec.ts:188`). O que se mede aqui é a
 * REGRA de `classifyFlushFailure` (prefixo 22/23 ⇒ permanente), que vive em
 * `react-loop.ts:66-90`; a caminhada pela cadeia de `cause` é de `db/client.ts`
 * e tem cobertura própria.
 */
vi.mock('@/db/client.js', () => ({
  pgErrorCode: (err: unknown) => (err as { code?: string } | null)?.code,
}));
vi.mock('@/governance/audit.js', () => ({ audit: h.audit }));
vi.mock('@/lib/logger.js', () => ({ logger: h.logger }));
vi.mock('@/gateway/line-output.js', () => ({
  forCurrentAgentChannel: h.forCurrentAgentChannel,
}));
vi.mock('@/cognition/reflector.js', () => ({ reflect: h.reflect }));
vi.mock('@/cognition/classifier.js', () => ({ classify: h.classify }));
vi.mock('@/cognition/persister.js', () => ({ persistCandidate: h.persistCandidate }));
/**
 * Passa-adiante, como o dublê de `withSpan` em
 * `tests/unit/agent-core-channel-resolution.spec.ts:113`. Este arquivo mede o
 * laço, não a árvore de spans (quem prova o aninhamento é
 * `tests/integration/turn-span-tree-hot-path.spec.ts`) — mas registramos o
 * índice recebido, porque "um span por iteração, 1-based" é contrato de
 * `react-loop.ts:672`.
 */
vi.mock('@/observability/instrumentation.js', () => ({
  instrumentReactIteration: <T,>(iteration: number, fn: () => Promise<T>): Promise<T> => {
    h.spansDeIteracao.push(iteration);
    return fn();
  },
}));

const mod = moduloDeProducao(() => import('@/agent/react-loop.js'));

// ─── Fábricas locais ─────────────────────────────────────────────────────────
//
// `tests/factories/db.ts` é SQL-only (toda fábrica exige um `pg.PoolClient`) e
// não tem `Conversa`/`Mensagem`. O padrão reutilizável para spec unitária é o
// de `tests/unit/prompt-builder.spec.ts:53-131`, copiado aqui.

function mkPessoa(over: Partial<Pessoa> = {}): Pessoa {
  return { id: 'pessoa-1', nome: 'Owner', tipo: 'dono', status: 'ativa', ...over } as Pessoa;
}

function mkConversa(over: Partial<Conversa> = {}): Conversa {
  return { id: 'conv-1', pessoa_id: 'pessoa-1', channel_id: null, ...over } as Conversa;
}

function mkInbound(over: Partial<Mensagem> = {}): Mensagem {
  return {
    id: 'msg-inbound',
    conversa_id: 'conv-1',
    direcao: 'in',
    tipo: 'texto',
    conteudo: 'oi',
    metadata: {},
    ...over,
  } as Mensagem;
}

function mkParams(over: Partial<RunReActLoopParams> = {}): RunReActLoopParams {
  return {
    pessoa: mkPessoa(),
    conversa: mkConversa(),
    inbound: mkInbound(),
    scope: { entidades: ['ent-1'], byEntity: new Map() },
    jid: '5511999999999@s.whatsapp.net',
    system: 'sistema',
    messages: [{ role: 'user', content: 'oi' }] as LLMMessage[],
    tools: [],
    ...over,
  };
}

function llmRes(over: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: null,
    tool_uses: [],
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    model: 'modelo-de-teste',
    ...over,
  };
}

/** Uma resposta do reasoner que pede UMA tool. */
function comTool(id: string, tool = 'minha_tool', args: unknown = { a: 1 }): LLMResponse {
  return llmRes({ tool_uses: [{ id, tool, args }], stop_reason: 'tool_use' });
}

/** Enfileira as respostas do `callLLM`, uma por iteração. */
function reasonerResponde(...respostas: LLMResponse[]): void {
  for (const r of respostas) h.callLLM.mockResolvedValueOnce(r);
}

function run(params: RunReActLoopParams = mkParams()): Promise<ReActLoopResult> {
  return mod().runReActLoop(params);
}

/** Sinais que o dublê do runner entregou ao `fn` — um por iteração. */
let sinaisEntreguesAoFn: AbortSignal[] = [];

function mkTurnContext(over: Partial<TurnExecutionContext> = {}): TurnExecutionContext {
  return {
    tenant_id: 'tn-1',
    agent_id: 'ag-1',
    turn_id: 'turn-1',
    attempt: 1,
    claim_token: 'tok-1',
    worker_id: 'worker-1',
    deadline: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
    ...over,
  } as TurnExecutionContext;
}

/** Deixa o microtask queue drenar (para os caminhos fire-and-forget). */
function proximoTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** O dublê PADRÃO do runner: chama o `fn` com um sinal sentinela por iteração. */
function runnerPassaAdiante(): void {
  h.runCognitiveModule.mockImplementation(
    async (_opts: unknown, fn: (s: AbortSignal) => Promise<unknown>) => {
      const sinal = new AbortController().signal;
      sinaisEntreguesAoFn.push(sinal);
      return {
        output: await fn(sinal),
        status: 'success',
        fallback_triggered: false,
        latency_ms: 1,
      };
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  sinaisEntreguesAoFn = [];
  h.spansDeIteracao.length = 0;
  for (const k of Object.keys(h.registry)) delete h.registry[k];
  h.registry.minha_tool = { side_effect: 'read' };

  // O runner real compõe (sinal do caller + timeout) e entrega o composto ao
  // `fn`. O dublê entrega um sinal SENTINELA por iteração — é o que permite
  // afirmar, abaixo, que o laço repassa ESSE sinal ao `callLLM`.
  runnerPassaAdiante();
  // Default: o modelo encerra sem texto (nenhum envio, nenhum efeito).
  h.callLLM.mockResolvedValue(llmRes());
  h.dispatchTool.mockResolvedValue({ ok: true });
  h.safeDispatchOutput.mockResolvedValue({ status: 'delivered' });
  h.mensagensCreate.mockResolvedValue(undefined);
  h.findActiveSnapshot.mockResolvedValue(null);
  h.audit.mockResolvedValue(undefined);
  h.forCurrentAgentChannel.mockResolvedValue({ sendReaction: h.sendReaction });
  h.reflect.mockResolvedValue(null);
  h.classify.mockResolvedValue(null);
  h.persistCandidate.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.1 linha 1 — teto de iterações, guard de posse e opções do reasoner
// ─────────────────────────────────────────────────────────────────────────────

describe('§5.1.1 — teto de 5 iterações e contrato do reasoner', () => {
  it('para em exatamente 5 iterações quando toda resposta pede tool, e sai por iteration_cap', async () => {
    // CONGELA: `MAX_REACT_ITERATIONS = 5` como TETO EFETIVO do laço, não só
    // como constante. A extração precisa preservar este limite na
    // implementação local (§5.1.1: "a porta de engine não é uma troca global
    // de provider"). O literal 5 é deliberado: comparar com a constante
    // importada deixaria a asserção verde se alguém mudasse a constante.
    reasonerResponde(...Array.from({ length: 8 }, (_, i) => comTool(`tu-${i}`)));

    const r = await run();

    expect(h.runCognitiveModule).toHaveBeenCalledTimes(5);
    expect(h.dispatchTool).toHaveBeenCalledTimes(5);
    expect(mod().MAX_REACT_ITERATIONS).toBe(5);
    expect(r.delivery).toEqual({
      dispatched: false,
      exitReason: 'iteration_cap',
      persistUnknown: false,
      sideEffectsCommitted: false,
    });
    // Um span por iteração, índice 1-based (`react-loop.ts:672`).
    expect(h.spansDeIteracao).toEqual([1, 2, 3, 4, 5]);
  });

  it('chama runCognitiveModule com o objeto de opções exato (name/version/triggered_by/timeout/ids)', async () => {
    // CONGELA: os limites do reasoner que a extração tem de reproduzir —
    // módulo `reasoner` v1, `sync_required`, 30s, correlacionado por
    // conversa/turno (`react-loop.ts:295-312`).
    await run();

    expect(h.runCognitiveModule).toHaveBeenNthCalledWith(
      1,
      {
        name: 'reasoner',
        version: 'v1',
        triggered_by: 'sync_required',
        timeoutMs: 30000,
        conversa_id: 'conv-1',
        turno_id: 'msg-inbound',
        signal: undefined, // fora de um turno reivindicado
      },
      expect.any(Function),
    );
  });

  it('chama callLLM com workload/max_tokens/pessoa_id e repassa o MESMO sinal que recebeu do runner', async () => {
    // CONGELA: `workload:'reasoner'` + `max_tokens:1024` (§5.1.1) e, sobretudo,
    // a identidade do sinal: sem a linha `signal` de `react-loop.ts:328` o
    // cancelamento vira decoração (o race devolve ao caller enquanto a
    // requisição HTTP segue viva).
    const params = mkParams({ system: 'sistema-x', tools: [] });

    await run(params);

    const [arg] = h.callLLM.mock.calls[0] as [Record<string, unknown>];
    expect(arg).toEqual({
      workload: 'reasoner',
      system: 'sistema-x',
      messages: params.messages,
      tools: params.tools,
      max_tokens: 1024,
      pessoa_id: 'pessoa-1',
      signal: sinaisEntreguesAoFn[0],
    });
    expect(arg.signal).toBe(sinaisEntreguesAoFn[0]);
  });

  it('com a posse já perdida, o guard do topo lança ANTES de qualquer chamada ao reasoner', async () => {
    // CONGELA: `assertTurnOwnership('react_iteration')` em `react-loop.ts:294`.
    // O valor dele é o custo que ele evita ANTES do dispatcher e do outbound:
    // uma iteração é um round-trip pago em nome de um turno que não é mais
    // nosso. Lançar (em vez de sair com `exitReason`) é o que impede a
    // tentativa velha de decidir o desfecho — §5.4.2 item 1.
    const ac = new AbortController();
    ac.abort();
    const ctx = mkTurnContext({ signal: ac.signal });

    const erro = await runWithTurnExecution(ctx, () => run()).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(TurnOwnershipLostError);
    expect((erro as TurnOwnershipLostError).boundary).toBe('react_iteration');
    expect(h.runCognitiveModule).not.toHaveBeenCalled();
    expect(h.callLLM).not.toHaveBeenCalled();
  });

  it('dentro de um turno, o sinal da tentativa entra nas opções do runner', async () => {
    // CONGELA: `turnSignal` é lido UMA vez, fora do laço, e é o MESMO em todas
    // as iterações (`react-loop.ts:263`).
    const ctx = mkTurnContext();
    reasonerResponde(comTool('tu-0'), comTool('tu-1'));

    await runWithTurnExecution(ctx, () => run());

    expect(h.runCognitiveModule.mock.calls.length).toBeGreaterThan(1);
    for (const chamada of h.runCognitiveModule.mock.calls) {
      expect((chamada[0] as { signal?: AbortSignal }).signal).toBe(ctx.signal);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.1 linha 2 — `conversation = messages` MUTA o array do caller
// ─────────────────────────────────────────────────────────────────────────────

describe('§5.1.1 — o array `messages` recebido é mutado (aliasing)', () => {
  it('acrescenta o turno assistant (tool_use) e o turno user (tool_result) NO array do caller', async () => {
    // CONGELA o aliasing de `react-loop.ts:232` (`const conversation = messages`).
    // É o item que a extração NÃO pode reproduzir: um snapshot durável precisa
    // de CÓPIA e serialização antes de iniciar, nunca de referência mutável
    // (§5.1.1). O teste existe para que essa troca apareça como diff.
    const messages: LLMMessage[] = [{ role: 'user', content: 'oi' }];
    reasonerResponde(comTool('tu-1'));

    await run(mkParams({ messages }));

    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu-1', name: 'minha_tool', input: { a: 1 } }],
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu-1',
          content: JSON.stringify({ ok: true }),
          is_error: false,
        },
      ],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.1 linha 3 — ausência de saída é `reasoner_failed`
// ─────────────────────────────────────────────────────────────────────────────

describe('§5.1.1 — reasoner sem saída encerra o turno como reasoner_failed', () => {
  it('output null para o laço na 1ª iteração, sem inventar envio e sem queimar as outras 4', async () => {
    // CONGELA `react-loop.ts:349-360`. Importa para a extração porque
    // `reasoner_failed` é o único desfecho que `decideTurnAction` traduz em
    // RETRY junto com `outbound_failure` — declarar isso quando algo JÁ foi
    // produzido reenfileiraria efeito. Também congela "não queima orçamento":
    // é `return 'stop'`, não `continue`.
    h.runCognitiveModule.mockResolvedValue({
      output: null,
      status: 'timeout',
      fallback_triggered: true,
      latency_ms: 30000,
    });

    const r = await run();

    expect(r.delivery).toEqual({
      dispatched: false,
      exitReason: 'reasoner_failed',
      persistUnknown: false,
      sideEffectsCommitted: false,
    });
    expect(r.outboundText).toBe('');
    expect(r.toolsCalled).toEqual([]);
    expect(h.safeDispatchOutput).not.toHaveBeenCalled();
    expect(h.runCognitiveModule).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith(
      { conversa_id: 'conv-1', mensagem_id: 'msg-inbound', status: 'timeout' },
      'react_loop.reasoner_failed',
    );
  });

  it('status cancelled com a posse perdida lança em vez de virar reasoner_failed', async () => {
    // CONGELA `react-loop.ts:344-346`: cancelamento NÃO é falha de raciocínio.
    // Sem este ramo o turno sairia como `reasoner_failed` → RETRY, que é
    // exatamente a gravação que a perda de posse proíbe.
    const ac = new AbortController();
    const ctx = mkTurnContext({ signal: ac.signal });
    h.runCognitiveModule.mockImplementation(async () => {
      ac.abort(); // a lease morre durante o round-trip do reasoner
      return { output: null, status: 'cancelled', fallback_triggered: false, latency_ms: 10 };
    });

    const erro = await runWithTurnExecution(ctx, () => run()).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(TurnOwnershipLostError);
    expect((erro as TurnOwnershipLostError).boundary).toBe('react_reasoner');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.1 linha 4 — `totalTokens` soma apenas as respostas RECEBIDAS
// ─────────────────────────────────────────────────────────────────────────────

describe('§5.1.1 — totalTokens', () => {
  it('soma input+output só das respostas que chegaram; iteração sem output não soma nada', async () => {
    // CONGELA `react-loop.ts:361`. §5.1.1 é explícita: isto NÃO prova custo de
    // chamada abortada — `totalTokens` legado não é ledger financeiro. O teste
    // fixa o escopo da soma para que a extração não a confunda com o uso
    // reportado por um motor remoto.
    reasonerResponde(
      llmRes({
        tool_uses: [{ id: 'tu-1', tool: 'minha_tool', args: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
      llmRes({
        tool_uses: [{ id: 'tu-2', tool: 'minha_tool', args: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    );
    // Duas iterações normais e, na 3ª, um reasoner que não devolve nada.
    let iteracao = 0;
    h.runCognitiveModule.mockImplementation(
      async (_o: unknown, fn: (s: AbortSignal) => Promise<unknown>) => {
        iteracao += 1;
        if (iteracao > 2) {
          return { output: null, status: 'error', fallback_triggered: true, latency_ms: 1 };
        }
        return {
          output: await fn(new AbortController().signal),
          status: 'success',
          fallback_triggered: false,
          latency_ms: 1,
        };
      },
    );

    const r = await run();

    expect(r.totalTokens).toBe(130);
    expect(r.delivery.exitReason).toBe('reasoner_failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.1 linha 5 — trim, prefixo de role e envio DENTRO do laço
// ─────────────────────────────────────────────────────────────────────────────

describe('§5.1.1 — trim e prefixo de role (outboundPrefix)', () => {
  it('prefixo + texto viram `prefixo\\n\\ntexto` no envio e em outboundText', async () => {
    // CONGELA `react-loop.ts:364-373`. Até aqui `outboundPrefix` tinha ZERO
    // cobertura em todo o repositório (`grep -rn outboundPrefix tests/` não
    // devolvia nada), embora `core.ts` o passe. É o T04 da matriz de testes.
    reasonerResponde(llmRes({ content: '  Tudo certo por aqui.  ' }));

    const r = await run(mkParams({ outboundPrefix: '[mudando para suporte]' }));

    const [ctx] = h.safeDispatchOutput.mock.calls[0] as [{ text: string }];
    expect(ctx.text).toBe('[mudando para suporte]\n\nTudo certo por aqui.');
    expect(r.outboundText).toBe('[mudando para suporte]\n\nTudo certo por aqui.');
  });

  it('texto só com espaços NÃO despacha e NÃO deixa anúncio órfão', async () => {
    // CONGELA a condição `rawText &&` de `react-loop.ts:370` e o `if (text)`
    // de `:374`: um turno vazio continua vazio — o prefixo sozinho nunca vira
    // uma bolha de mensagem.
    reasonerResponde(llmRes({ content: '   ' }));

    const r = await run(mkParams({ outboundPrefix: '[mudando para suporte]' }));

    expect(h.safeDispatchOutput).not.toHaveBeenCalled();
    expect(r.outboundText).toBe('');
    expect(r.delivery).toEqual({
      dispatched: false,
      exitReason: 'empty_final_text',
      persistUnknown: false,
      sideEffectsCommitted: false,
    });
  });

  it.each([
    ['null', null],
    ['string vazia', ''],
    ['ausente', undefined],
  ])('prefixo %s deixa o texto intacto (só o trim)', async (_nome, prefixo) => {
    // CONGELA `typeof prefix === 'string' && prefix.length > 0`: os três casos
    // "sem anúncio" são indistinguíveis no resultado.
    reasonerResponde(llmRes({ content: '  resposta  ' }));

    const r = await run(mkParams({ outboundPrefix: prefixo as string | null | undefined }));

    const [ctx] = h.safeDispatchOutput.mock.calls[0] as [{ text: string }];
    expect(ctx.text).toBe('resposta');
    expect(r.outboundText).toBe('resposta');
  });

  it('detectGap recebe o texto SEM prefixo (rawText), não o texto despachado', async () => {
    // CONGELA `react-loop.ts:415` + `:417`. A montagem é deliberada: o prefixo
    // contém `?`, e o filtro de falso-positivo de `detectGap` suprime o sinal
    // quando há `?` na janela de 80 chars. Se alguém trocar `rawText` por
    // `text`, a lacuna deixa de ser detectada e este caso fica vermelho.
    reasonerResponde(llmRes({ content: 'Não sei o saldo dessa conta agora.' }));
    h.reflect.mockResolvedValue({ insight: 'falta acesso ao saldo' });
    h.classify.mockResolvedValue({ tipo: 'lacuna' });

    await run(mkParams({ outboundPrefix: 'Posso ajudar?' }));
    await proximoTick();

    expect(h.reflect).toHaveBeenCalledTimes(1);
    const [evento] = h.reflect.mock.calls[0] as [{ attempted_response: string }];
    expect(evento.attempted_response).toBe('Não sei o saldo dessa conta agora.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.1 linha 6 — gap/reflection é fire-and-forget
// ─────────────────────────────────────────────────────────────────────────────

describe('§5.1.1 — reflexão de lacuna nunca bloqueia nem derruba o turno', () => {
  it('o laço resolve sem esperar a reflexão (reflect pendente para sempre)', async () => {
    // CONGELA `void (async () => …)()` de `react-loop.ts:419`: a reflexão é
    // custo cognitivo posterior e NÃO pode entrar no caminho da resposta. Na
    // extração isso vira hook Maia pós-saída (§5.1.1), e continua sem bloquear.
    reasonerResponde(llmRes({ content: 'Não sei o saldo dessa conta agora.' }));
    h.reflect.mockReturnValue(new Promise(() => {})); // nunca resolve

    const r = await run();

    expect(r.delivery.dispatched).toBe(true);
    expect(h.reflect).toHaveBeenCalledTimes(1);
  });

  it('reflect rejeitando não rejeita o laço nem muda o delivery — só um warn', async () => {
    // CONGELA o `catch` de `react-loop.ts:433-438`.
    reasonerResponde(llmRes({ content: 'Não sei o saldo dessa conta agora.' }));
    h.reflect.mockRejectedValue(new Error('reflector fora do ar'));

    const r = await run();
    await proximoTick();

    expect(r.delivery).toEqual({
      dispatched: true,
      exitReason: 'empty_final_text',
      persistUnknown: false,
      sideEffectsCommitted: false,
    });
    expect(h.logger.warn).toHaveBeenCalledWith(
      { err: 'reflector fora do ar', mensagem_id: 'msg-inbound' },
      'gap.reflection.failed',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.1 linha 7 — tools sequenciais, `request_id` novo, resultados na ordem
// ─────────────────────────────────────────────────────────────────────────────

describe('§5.1.1 — execução de tools', () => {
  it('duas tools na mesma resposta rodam EM SÉRIE, cada uma com request_id próprio', async () => {
    // CONGELA a serialização de `react-loop.ts:458-474` (o `for…of` com
    // `await`). §5.1.1: a extração não pode paralelizar handlers como efeito
    // colateral. O rastro início/fim é o que prova série — contar chamadas não
    // provaria.
    const rastro: string[] = [];
    h.dispatchTool.mockImplementation(async (input: { tool: string }) => {
      rastro.push(`inicio:${input.tool}`);
      await proximoTick();
      rastro.push(`fim:${input.tool}`);
      return { ok: input.tool };
    });
    h.registry.tool_a = { side_effect: 'read' };
    h.registry.tool_b = { side_effect: 'read' };
    reasonerResponde(
      llmRes({
        stop_reason: 'tool_use',
        tool_uses: [
          { id: 'tu-a', tool: 'tool_a', args: { x: 1 } },
          { id: 'tu-b', tool: 'tool_b', args: { y: 2 } },
        ],
      }),
    );

    await run();

    expect(rastro).toEqual(['inicio:tool_a', 'fim:tool_a', 'inicio:tool_b', 'fim:tool_b']);

    const chamadas = h.dispatchTool.mock.calls as Array<
      [{ tool: string; ctx: { request_id: string } }]
    >;
    expect(chamadas.map((c) => c[0].tool)).toEqual(['tool_a', 'tool_b']);
    const ids = chamadas.map((c) => c[0].ctx.request_id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('o ctx do dispatcher carrega pessoa, scope, conversa e mensagem_id do turno', async () => {
    // CONGELA a forma de `ToolContext` que a extração tem de reidratar: §5.1.2
    // é explícita em que o adapter NOVO jamais recebe `Pessoa`/`Conversa`.
    const params = mkParams();
    reasonerResponde(comTool('tu-1'));

    await run(params);

    const [entrada] = h.dispatchTool.mock.calls[0] as [
      { args: unknown; ctx: Record<string, unknown> },
    ];
    expect(entrada.args).toEqual({ a: 1 });
    expect(entrada.ctx).toEqual({
      pessoa: params.pessoa,
      scope: params.scope,
      conversa: params.conversa,
      mensagem_id: 'msg-inbound',
      request_id: expect.any(String),
    });
  });

  it('os tool_result entram no histórico na ordem do pedido, com JSON.stringify e is_error', async () => {
    // CONGELA `react-loop.ts:624-629` + `:655`: o conteúdo do `tool_result` é
    // o resultado CRU serializado, e `is_error` é derivado da presença da
    // chave `error` (`:475`), não do transporte.
    const messages: LLMMessage[] = [{ role: 'user', content: 'oi' }];
    h.registry.tool_a = { side_effect: 'read' };
    h.registry.tool_b = { side_effect: 'read' };
    h.dispatchTool
      .mockResolvedValueOnce({ saldo: 10 })
      .mockResolvedValueOnce({ error: 'forbidden' });
    reasonerResponde(
      llmRes({
        stop_reason: 'tool_use',
        tool_uses: [
          { id: 'tu-a', tool: 'tool_a', args: {} },
          { id: 'tu-b', tool: 'tool_b', args: {} },
        ],
      }),
    );

    await run(mkParams({ messages }));

    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu-a',
          content: JSON.stringify({ saldo: 10 }),
          is_error: false,
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu-b',
          content: JSON.stringify({ error: 'forbidden' }),
          is_error: true,
        },
      ],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.1 linha 8 — recusa por posse lança ANTES de acumular; sideEffects na
// INVOCAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

describe('§5.1.1 — recusa por posse e rastreio de efeito irreversível', () => {
  it('dispatcher devolvendo turn_ownership_lost lança ANTES de audit, sumário e flush', async () => {
    // CONGELA `react-loop.ts:494-499` e, principalmente, a POSIÇÃO do throw:
    // antes de `sideEffectsCommitted`, `toolsCalled`, `audit()` e
    // `results.push`. Era exatamente isso que produzia três gravações depois de
    // o turno já não ser nosso — inclusive a row de `mensagens` do flush.
    const ctx = mkTurnContext();
    h.registry.minha_tool = { side_effect: 'write' };
    h.dispatchTool.mockResolvedValue({ error: 'turn_ownership_lost' });
    reasonerResponde(comTool('tu-1'));

    const erro = await runWithTurnExecution(ctx, () => run()).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(TurnOwnershipLostError);
    expect((erro as TurnOwnershipLostError).boundary).toBe('react_tool_refused');
    expect((erro as TurnOwnershipLostError).turn_id).toBe('turn-1');
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.mensagensCreate).not.toHaveBeenCalled();
    expect(h.safeDispatchOutput).not.toHaveBeenCalled();
  });

  it.each([
    ['write', 'write'],
    ['communication', 'communication'],
  ])('tool %s marca sideEffectsCommitted MESMO retornando erro', async (_nome, sideEffect) => {
    // CONGELA `react-loop.ts:511-514`: marca na INVOCAÇÃO, não no sucesso. Um
    // `isError` do dispatcher não prova que nada foi aplicado. §5.4.2 manda
    // NÃO relaxar isso por acidente na extração — o custo de errar para o lado
    // seguro é intervenção manual; para o outro, é cobrar duas vezes.
    h.registry.minha_tool = { side_effect: sideEffect };
    h.dispatchTool.mockResolvedValue({ error: 'validation_failed' });
    reasonerResponde(...Array.from({ length: 5 }, (_, i) => comTool(`tu-${i}`)));

    const r = await run();

    expect(r.delivery.sideEffectsCommitted).toBe(true);
    // CONTROLE: erro COMUM de tool não encerra o laço — ele seguiu até o teto.
    // É o contraste que dá sentido ao caso acima (`turn_ownership_lost`, que
    // encerra na hora): o mesmo formato `{ error }` tem dois destinos, e só um
    // deles é fim de tentativa. Mesmo controle da barreira de integração
    // `turn-lease-lost-react-loop-real-db.spec.ts:373`.
    expect(h.runCognitiveModule).toHaveBeenCalledTimes(5);
    expect(r.delivery.exitReason).toBe('iteration_cap');
  });

  it.each([['read'], ['none']])('tool %s NÃO marca sideEffectsCommitted', async (sideEffect) => {
    // Contraprova da linha acima: sem ela, "marca sempre" passaria igual.
    h.registry.minha_tool = { side_effect: sideEffect };
    reasonerResponde(comTool('tu-1'));

    const r = await run();

    expect(r.delivery.sideEffectsCommitted).toBe(false);
  });

  it('toolsCalled devolve nome e resultado CRU de cada invocação', async () => {
    // CONGELA `react-loop.ts:518`: é o material do step-evaluator pós-turno, e
    // §5.1.1 exige que o resultado novo preserve esse material.
    h.dispatchTool.mockResolvedValue({ saldo: 42 });
    reasonerResponde(comTool('tu-1'));

    const r = await run();

    expect(r.toolsCalled).toEqual([{ name: 'minha_tool', result: { saldo: 42 } }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.1 linha 9 — revalidação da pendência com `findActiveSnapshot`
// ─────────────────────────────────────────────────────────────────────────────

describe('§5.1.1 — revalidação de ask_pending_question', () => {
  const RESULTADO_PENDENTE = {
    pending_question_id: 'pq-1',
    opcoes_validas: [{ key: 'a', label: 'Sim' }],
  };

  beforeEach(() => {
    h.registry.ask_pending_question = { side_effect: 'communication' };
  });

  it('snapshot ativo e casando faz o latestPending chegar ao safeDispatchOutput', async () => {
    // CONGELA `react-loop.ts:536-543`: um ID devolvido pelo cache de
    // idempotência (5 min) do dispatcher NÃO prova pergunta ainda aberta —
    // por isso a releitura. §5.5.2 manda preservar esse gate na extração.
    h.dispatchTool.mockResolvedValue(RESULTADO_PENDENTE);
    h.findActiveSnapshot.mockResolvedValue({ id: 'pq-1' });
    reasonerResponde(comTool('tu-1', 'ask_pending_question'), llmRes({ content: 'Confirma?' }));

    await run();

    expect(h.findActiveSnapshot).toHaveBeenCalledWith('conv-1');
    const [ctx] = h.safeDispatchOutput.mock.calls[0] as [{ latestPending: unknown }];
    expect(ctx.latestPending).toEqual({
      id: 'pq-1',
      opcoes_validas: [{ key: 'a', label: 'Sim' }],
    });
  });

  it.each([
    ['id divergente', async () => ({ id: 'pq-OUTRA' })],
    ['sem pendência ativa', async () => null],
    [
      'leitura falhando',
      async () => {
        throw new Error('db caiu');
      },
    ],
  ])('%s derruba o candidato e avisa stale_pending_id_dropped', async (_nome, snapshot) => {
    // CONGELA o `.catch(() => null)` de `:538` e o ramo `else` de `:544-549`:
    // falha de leitura é tratada como "não confirmado", nunca como confirmado.
    h.dispatchTool.mockResolvedValue(RESULTADO_PENDENTE);
    h.findActiveSnapshot.mockImplementation(snapshot as () => Promise<unknown>);
    reasonerResponde(comTool('tu-1', 'ask_pending_question'), llmRes({ content: 'Confirma?' }));

    await run();

    const [ctx] = h.safeDispatchOutput.mock.calls[0] as [{ latestPending: unknown }];
    expect(ctx.latestPending).toBeNull();
    expect(h.logger.warn).toHaveBeenCalledWith(
      { tool: 'ask_pending_question', candidate: 'pq-1', conversa_id: 'conv-1' },
      'agent.stale_pending_id_dropped',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.1 linha 10 — sensibilidade deduplicada e captura do PDF
// ─────────────────────────────────────────────────────────────────────────────

describe('§5.1.1 — sensibilidade e PDF de relatório', () => {
  it('a mesma tool sensível duas vezes vira UMA entrada em sensitiveTools', async () => {
    // CONGELA o guard de dedup de `react-loop.ts:558`: a lista é um CONJUNTO,
    // mesmo quando o modelo dispara a mesma tool para duas entidades. Esses
    // fatos vêm de execução Maia, nunca do engine (§5.1.1).
    h.registry.consulta_saldo = { side_effect: 'read', sensitive: true };
    reasonerResponde(
      llmRes({
        stop_reason: 'tool_use',
        tool_uses: [
          { id: 'tu-1', tool: 'consulta_saldo', args: { e: 1 } },
          { id: 'tu-2', tool: 'consulta_saldo', args: { e: 2 } },
        ],
      }),
      llmRes({ content: 'Seus saldos.' }),
    );

    await run();

    const [ctx] = h.safeDispatchOutput.mock.calls[0] as [
      { turnHasSensitive: boolean; sensitiveTools: string[] },
    ];
    expect(ctx.turnHasSensitive).toBe(true);
    expect(ctx.sensitiveTools).toEqual(['consulta_saldo']);
  });

  it('generate_report com as quatro chaves e sem erro vira latestReportPdf', async () => {
    // CONGELA `react-loop.ts:563-586`. §5.1.1: PDF temporário não basta para
    // recovery entre processos — a extração precisa saber exatamente o que o
    // laço captura hoje para não herdar a suposição.
    h.registry.generate_report = { side_effect: 'read' };
    h.dispatchTool.mockResolvedValue({
      path: '/tmp/rel.pdf',
      fileName: 'rel.pdf',
      mimetype: 'application/pdf',
      tipo: 'extrato',
      extra: 'ignorado',
    });
    reasonerResponde(comTool('tu-1', 'generate_report'), llmRes({ content: 'Segue.' }));

    await run();

    const [ctx] = h.safeDispatchOutput.mock.calls[0] as [{ latestReportPdf: unknown }];
    expect(ctx.latestReportPdf).toEqual({
      path: '/tmp/rel.pdf',
      fileName: 'rel.pdf',
      mimetype: 'application/pdf',
      tipo: 'extrato',
    });
  });

  it.each([
    ['faltando mimetype', { path: '/tmp/r.pdf', fileName: 'r.pdf', tipo: 'extrato' }],
    [
      'resultado com erro',
      {
        error: 'pdf_failed',
        path: '/tmp/r.pdf',
        fileName: 'r.pdf',
        mimetype: 'application/pdf',
        tipo: 'extrato',
      },
    ],
  ])('generate_report %s deixa latestReportPdf null', async (_nome, resultado) => {
    h.registry.generate_report = { side_effect: 'read' };
    h.dispatchTool.mockResolvedValue(resultado);
    reasonerResponde(comTool('tu-1', 'generate_report'), llmRes({ content: 'Segue.' }));

    await run();

    const [ctx] = h.safeDispatchOutput.mock.calls[0] as [{ latestReportPdf: unknown }];
    expect(ctx.latestReportPdf).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.1 linha 11 — reação efêmera pela LineOutput
// ─────────────────────────────────────────────────────────────────────────────

describe('§5.1.1 — reação efêmera (exceção de egresso declarada)', () => {
  beforeEach(() => {
    h.registry.minha_tool = { side_effect: 'write' };
  });

  it.each([
    ['sucesso', '✅', { ok: true }],
    ['erro forbidden', '❌', { error: 'forbidden' }],
    ['erro requires_dual_approval', '❌', { error: 'requires_dual_approval' }],
  ])('tool com %s reage com %s', async (_nome, emoji, resultado) => {
    // CONGELA a tabela de emoji de `react-loop.ts:595-601`. Reação TAMBÉM é
    // saída: §5.1.1 manda mantê-la em hook Maia, e não reenviar reações
    // antigas no recovery — o que exige saber exatamente quando ela sai hoje.
    h.dispatchTool.mockResolvedValue(resultado);
    reasonerResponde(comTool('tu-1', 'minha_tool'));

    await run(mkParams({ inbound: mkInbound({ metadata: { whatsapp_id: 'WA-1' } }) }));

    expect(h.sendReaction).toHaveBeenCalledWith('5511999999999@s.whatsapp.net', 'WA-1', emoji);
  });

  it('erro fora da lista NÃO reage', async () => {
    // Contraprova: sem ela, "reage sempre" passaria nos três casos acima.
    h.dispatchTool.mockResolvedValue({ error: 'validation_failed' });
    reasonerResponde(comTool('tu-1'));

    await run(mkParams({ inbound: mkInbound({ metadata: { whatsapp_id: 'WA-1' } }) }));

    expect(h.sendReaction).not.toHaveBeenCalled();
  });

  it('sem whatsapp_id no inbound não há reação alguma', async () => {
    // CONGELA `typeof wid === 'string'` (`:591`): a reação é um sinal SOBRE a
    // mensagem de entrada; sem o id do provedor não há alvo.
    h.dispatchTool.mockResolvedValue({ ok: true });
    reasonerResponde(comTool('tu-1'));

    await run(mkParams({ inbound: mkInbound({ metadata: {} }) }));

    expect(h.forCurrentAgentChannel).not.toHaveBeenCalled();
    expect(h.sendReaction).not.toHaveBeenCalled();
  });

  it('a reação sai DENTRO da exceção de egresso `agent.react_loop_tool_reaction`', async () => {
    // CONGELA `react-loop.ts:608-611` com o guard REAL: a trava de
    // `egress-guard.ts` recusa qualquer `sendReaction` fora de um escopo
    // declarado, e `send-paths.ts:924` ratifica ESTE id. Se a extração mover a
    // reação sem carregar a declaração junto, a chamada passa a lançar.
    let autorizacao: unknown;
    h.sendReaction.mockImplementation(() => {
      autorizacao = currentEgressAuthorization();
    });
    h.dispatchTool.mockResolvedValue({ ok: true });
    reasonerResponde(comTool('tu-1'));

    await run(mkParams({ inbound: mkInbound({ metadata: { whatsapp_id: 'WA-1' } }) }));

    expect(autorizacao).toEqual({
      via: 'exception',
      path_id: 'agent.react_loop_tool_reaction',
    });
  });

  it('linha não resolvida só suprime a reação — o turno segue', async () => {
    // CONGELA o `.catch` de `:615-619`: best-effort de verdade. Uma reação
    // perdida não é uma resposta perdida (é o único item do inventário de
    // egresso do qual isso é literalmente verdade).
    h.forCurrentAgentChannel.mockRejectedValue(new Error('channel_ambiguous'));
    h.dispatchTool.mockResolvedValue({ ok: true });
    reasonerResponde(comTool('tu-1'), llmRes({ content: 'Pronto.' }));

    const r = await run(mkParams({ inbound: mkInbound({ metadata: { whatsapp_id: 'WA-1' } }) }));

    expect(r.delivery.dispatched).toBe(true);
    expect(h.logger.debug).toHaveBeenCalledWith(
      { err: 'channel_ambiguous' },
      'react_loop.reaction_line_unresolved',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.1 linha 12 — sumários, auditoria e flush `tipo:'evento'`
// ─────────────────────────────────────────────────────────────────────────────

describe('§5.1.1 — sumários de tool, auditoria e flush sem outbound', () => {
  it('sem outbound e com tools, o flush grava a row evento com o payload exato', async () => {
    // CONGELA `flushUnconfirmedToolSummaries` (`react-loop.ts:92-141,680-687`).
    // Esta row é o anchor anti-anchoring do turno SEGUINTE — §5.1.1 exige que
    // o resultado novo preserve o material do step-evaluator e do próximo
    // prompt "inclusive quando não há reply".
    h.registry.minha_tool = { side_effect: 'write' };
    h.dispatchTool.mockResolvedValue({ ok: true });
    reasonerResponde(comTool('tu-1'), llmRes({ content: '' }));

    await run();

    expect(h.mensagensCreate).toHaveBeenCalledTimes(1);
    expect(h.mensagensCreate).toHaveBeenCalledWith({
      conversa_id: 'conv-1',
      direcao: 'out',
      tipo: 'evento',
      conteudo: '',
      midia_url: null,
      metadata: {
        in_reply_to: 'msg-inbound',
        event_only: true,
        flush_reason: 'empty_final_text',
      },
      processada_em: expect.any(Date),
      ferramentas_chamadas: [
        {
          tool_call_id: 'tu-1',
          tool_name: 'minha_tool',
          status: 'success',
          side_effect: 'write',
          result_summary: 'minha_tool: ok',
          occurred_at: expect.any(String),
        },
      ],
      tokens_usados: null,
    });
    expect(h.logger.info).toHaveBeenCalledWith(
      { conversa_id: 'conv-1', inbound_id: 'msg-inbound', count: 1, reason: 'empty_final_text' },
      'agent.tool_summaries_flushed_no_outbound',
    );
  });

  it('o flush_reason acompanha o exitReason (iteration_cap)', async () => {
    // CONGELA que o motivo gravado é o `exitReason` do turno, não uma
    // constante — é o que deixa a row diagnosticável.
    reasonerResponde(...Array.from({ length: 5 }, (_, i) => comTool(`tu-${i}`)));

    await run();

    const [row] = h.mensagensCreate.mock.calls[0] as [{ metadata: { flush_reason: string } }];
    expect(row.metadata.flush_reason).toBe('iteration_cap');
  });

  it('COM outbound despachado o flush NÃO roda', async () => {
    // CONGELA a condição `!outboundDispatched` de `:680`. Sem esta
    // contraprova, um flush incondicional passaria no caso acima.
    h.dispatchTool.mockResolvedValue({ ok: true });
    reasonerResponde(comTool('tu-1'), llmRes({ content: 'Pronto.' }));

    const r = await run();

    expect(r.delivery.dispatched).toBe(true);
    expect(h.mensagensCreate).not.toHaveBeenCalled();
  });

  it('sem tool nenhuma, nada é gravado (toolSummaries vazio)', async () => {
    // CONGELA o `if (toolSummaries.length === 0) return` de `:98`.
    reasonerResponde(llmRes({ content: '' }));

    await run();

    expect(h.mensagensCreate).not.toHaveBeenCalled();
  });

  it('audit() é chamado uma vez por tool-use, com a ação derivada do erro', async () => {
    // CONGELA `react-loop.ts:647-653`. O invariante de auditoria da §4 do
    // AGENTS.md não depende da row do flush: o `audit_log` já foi escrito aqui.
    h.registry.tool_a = { side_effect: 'read' };
    h.registry.tool_b = { side_effect: 'read' };
    h.dispatchTool
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ error: 'forbidden' });
    reasonerResponde(
      llmRes({
        stop_reason: 'tool_use',
        tool_uses: [
          { id: 'tu-a', tool: 'tool_a', args: {} },
          { id: 'tu-b', tool: 'tool_b', args: {} },
        ],
      }),
    );

    await run();

    expect(h.audit).toHaveBeenNthCalledWith(1, {
      acao: 'classification_suggested',
      pessoa_id: 'pessoa-1',
      conversa_id: 'conv-1',
      mensagem_id: 'msg-inbound',
      metadata: { tool: 'tool_a' },
    });
    expect(h.audit).toHaveBeenNthCalledWith(2, {
      acao: 'unauthorized_access_attempt',
      pessoa_id: 'pessoa-1',
      conversa_id: 'conv-1',
      mensagem_id: 'msg-inbound',
      metadata: { tool: 'tool_b' },
    });
  });

  it('falha PERMANENTE do flush (SQLSTATE 23xxx) sai em error, e o laço NÃO rejeita', async () => {
    // CONGELA `classifyFlushFailure` (`:66-90`) e o `catch` best-effort de
    // `:119-139`. O modo de falha da #577 era um defeito PERMANENTE de esquema
    // indistinguível de um soluço de banco; a classificação por SQLSTATE é o
    // que impede a reincidência. E falhar o turno aqui seria ESTRITAMENTE pior
    // (reexecutaria tools já executadas).
    const err = Object.assign(new Error('insert falhou'), {
      code: '23514',
      constraint: 'mensagens_tipo_check',
    });
    h.mensagensCreate.mockRejectedValue(err);
    reasonerResponde(comTool('tu-1'), llmRes({ content: '' }));

    const r = await run();

    expect(r.delivery.exitReason).toBe('empty_final_text');
    expect(h.logger.error).toHaveBeenCalledWith(
      {
        conversa_id: 'conv-1',
        inbound_id: 'msg-inbound',
        reason: 'empty_final_text',
        count: 1,
        failure_kind: 'permanent',
        pg_code: '23514',
        pg_constraint: 'mensagens_tipo_check',
        err: 'Error',
      },
      'agent.tool_summaries_flush_rejected',
    );
  });

  it('falha TRANSITÓRIA do flush (erro de conexão) sai em warn', async () => {
    // Contraprova da classificação: sem ela, "tudo permanente" passaria acima.
    h.mensagensCreate.mockRejectedValue(
      Object.assign(new Error('conexão caiu'), { code: 'ECONNREFUSED' }),
    );
    reasonerResponde(comTool('tu-1'), llmRes({ content: '' }));

    await run();

    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        failure_kind: 'transient',
        pg_code: 'ECONNREFUSED',
        pg_constraint: null,
      }),
      'agent.tool_summaries_flush_failed',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DISCREPÂNCIA CONHECIDA — §5.1.1, "Discrepância concreta a tratar
// explicitamente"
// ─────────────────────────────────────────────────────────────────────────────

describe('§5.1.1 — DISCREPÂNCIA: toolSummaries não chega a safeDispatchOutput', () => {
  it('o objeto de dispatch NÃO carrega toolSummaries (comportamento ATUAL, defeituoso)', async () => {
    /**
     * ⚠️ ESTE CASO PINA UM DEFEITO, DE PROPÓSITO.
     *
     * `react-loop.ts:380-390` monta o ctx com exatamente nove campos —
     * `pessoa, conversa, inbound, jid, text, latestPending, latestReportPdf,
     * turnHasSensitive, sensitiveTools` — e NÃO inclui `toolSummaries`, embora
     * o acumulador exista desde `:243` e `DispatchOutputCtx.toolSummaries` seja
     * opcional (`output-dispatch.ts:116`) e lido em `dispatchOutput` por
     * `ctx.toolSummaries ?? []` (`output-dispatch.ts:628`), indo para
     * `ferramentas_chamadas` em TODOS os ramos.
     *
     * Consequência: no caminho normal do ReAct (rodou tools E respondeu), a row
     * de saída persiste `ferramentas_chamadas: []`, e o bloco "## Eventos
     * confirmados pelo backend" do turno seguinte fica hidratado só pela row do
     * flush — que, por definição, só existe quando NÃO houve resposta. Um turno
     * que roda tools e responde perde o anchor anti-anchoring.
     *
     * §5.1.1 é explícita: "Transmiti-lo na extração é uma correção observável,
     * a isolar em teste/nota de compatibilidade; não afirmar que já funciona."
     * Então a correção é INTENCIONAL na extração, e quando ela vier este caso
     * fica vermelho e vira um diff deliberado de uma linha — que é exatamente o
     * sinal que §5.10.3 pede ("Marcar correção de sumários como mudança
     * intencional").
     */
    h.registry.minha_tool = { side_effect: 'write' };
    h.dispatchTool.mockResolvedValue({ ok: true });
    reasonerResponde(comTool('tu-1'), llmRes({ content: 'Pronto.' }));

    const r = await run();

    const [ctx] = h.safeDispatchOutput.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(ctx).sort()).toEqual([
      'conversa',
      'inbound',
      'jid',
      'latestPending',
      'latestReportPdf',
      'pessoa',
      'sensitiveTools',
      'text',
      'turnHasSensitive',
    ]);
    expect(Object.keys(ctx)).not.toContain('toolSummaries');
    expect(ctx.toolSummaries).toBeUndefined();
    // E o outro sumidouro fica travado junto: como houve outbound, o flush não
    // roda, então NENHUM dos dois destinos recebeu os sumários deste turno.
    expect(r.delivery.dispatched).toBe(true);
    expect(h.mensagensCreate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.4 — o que o PRODUTOR consegue emitir (complementa turn-outcome.spec.ts,
// que já cobre o CONSUMIDOR exaustivamente)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `tests/unit/turn-outcome.spec.ts` varre as 32 combinações de `ReActDelivery`
 * e afirma o que `decideTurnAction` faz com cada uma. Este bloco NÃO duplica
 * aquilo: ele mede o outro lado da fronteira — QUAIS combinações
 * `runReActLoop` consegue produzir.
 *
 * §5.4.1 avisa que "o tipo permite combinações não produzidas normalmente" e
 * que não se deve "corrigir a função de compatibilidade com uma nova
 * precedência sem teste". Estas são as duas implicações estruturais do
 * produtor, hoje garantidas pela ORDEM do código:
 *
 *   (I1) dispatched === true  ⟹ exitReason === 'empty_final_text'
 *        Todo caminho que fixa `reasoner_failed`, `outbound_failure` ou
 *        `iteration_cap` devolve 'stop' sem chegar a `outboundDispatched = true`
 *        (`react-loop.ts:358, 396, 407, 658-660`).
 *   (I2) persistUnknown === true ⟹ dispatched === true
 *        `persistUnknown` só é escrito em `:405`, duas linhas antes de `:407`.
 *
 * Se a extração quebrar uma delas, `decideTurnAction` passa a receber entradas
 * que ninguém nunca produziu — e o consumidor as aceita em silêncio.
 */
describe('§5.4 — combinações de ReActDelivery produzíveis pelo laço', () => {
  type Cenario = {
    nome: string;
    preparar: () => void;
    esperado: { dispatched: boolean; exitReason: string; persistUnknown: boolean };
  };

  const CENARIOS: Cenario[] = [
    {
      nome: 'end_turn com texto, entregue',
      preparar: () => reasonerResponde(llmRes({ content: 'Pronto.' })),
      esperado: { dispatched: true, exitReason: 'empty_final_text', persistUnknown: false },
    },
    {
      nome: 'enviado mas persistência ambígua',
      preparar: () => {
        h.safeDispatchOutput.mockResolvedValue({ status: 'sent_no_persist', error: 'db' });
        reasonerResponde(llmRes({ content: 'Pronto.' }));
      },
      esperado: { dispatched: true, exitReason: 'empty_final_text', persistUnknown: true },
    },
    {
      nome: 'falha pre-send do outbound',
      preparar: () => {
        h.safeDispatchOutput.mockResolvedValue({ status: 'not_sent', error: 'desconectado' });
        reasonerResponde(llmRes({ content: 'Pronto.' }));
      },
      esperado: { dispatched: false, exitReason: 'outbound_failure', persistUnknown: false },
    },
    {
      nome: 'reasoner sem saída',
      preparar: () => {
        h.runCognitiveModule.mockResolvedValue({
          output: null,
          status: 'timeout',
          fallback_triggered: true,
          latency_ms: 1,
        });
      },
      esperado: { dispatched: false, exitReason: 'reasoner_failed', persistUnknown: false },
    },
    {
      nome: 'end_turn sem texto',
      preparar: () => reasonerResponde(llmRes({ content: null })),
      esperado: { dispatched: false, exitReason: 'empty_final_text', persistUnknown: false },
    },
    {
      nome: 'teto de iterações',
      preparar: () => reasonerResponde(...Array.from({ length: 5 }, (_, i) => comTool(`tu-${i}`))),
      esperado: { dispatched: false, exitReason: 'iteration_cap', persistUnknown: false },
    },
  ];

  it.each(CENARIOS)('$nome produz a combinação esperada e respeita I1/I2', async (cenario) => {
    cenario.preparar();

    const r = await run();

    expect({
      dispatched: r.delivery.dispatched,
      exitReason: r.delivery.exitReason,
      persistUnknown: r.delivery.persistUnknown,
    }).toEqual(cenario.esperado);

    // (I1) e (I2) — as duas implicações, verificadas em TODO cenário.
    if (r.delivery.dispatched) expect(r.delivery.exitReason).toBe('empty_final_text');
    if (r.delivery.persistUnknown) expect(r.delivery.dispatched).toBe(true);
  });

  it('o conjunto de combinações produzíveis é FECHADO nestas seis', async () => {
    // A forma agregada da invariante: nenhuma combinação com `dispatched=true`
    // e motivo de falha, e nenhuma com `persistUnknown=true` sem envio. Uma
    // sétima combinação (ou o sumiço de uma) aparece aqui como diff.
    const observadas: string[] = [];
    for (const cenario of CENARIOS) {
      vi.clearAllMocks();
      sinaisEntreguesAoFn = [];
      runnerPassaAdiante();
      h.callLLM.mockResolvedValue(llmRes());
      h.dispatchTool.mockResolvedValue({ ok: true });
      h.safeDispatchOutput.mockResolvedValue({ status: 'delivered' });
      h.mensagensCreate.mockResolvedValue(undefined);
      cenario.preparar();

      const r = await run();

      observadas.push(
        [
          String(r.delivery.dispatched),
          r.delivery.exitReason,
          String(r.delivery.persistUnknown),
        ].join('|'),
      );
    }

    expect([...new Set(observadas)].sort()).toEqual([
      'false|empty_final_text|false',
      'false|iteration_cap|false',
      'false|outbound_failure|false',
      'false|reasoner_failed|false',
      'true|empty_final_text|false',
      'true|empty_final_text|true',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T01 — caso comum (sem tools, um outbound)
// ─────────────────────────────────────────────────────────────────────────────

describe('T01 — turno comum: uma resposta, um envio, nenhuma gravação do laço', () => {
  it('uma iteração, um safeDispatchOutput, zero rows de mensagens', async () => {
    // CONGELA o caminho quente inteiro. A cobertura mais próxima disso hoje
    // (`agent-core-channel-resolution.spec.ts:457`) FABRICA o retorno do laço,
    // então ninguém afirmava este comportamento — só o assumia.
    reasonerResponde(llmRes({ content: 'Oi! Tudo certo.' }));

    const r = await run();

    expect(h.runCognitiveModule).toHaveBeenCalledTimes(1);
    expect(h.dispatchTool).not.toHaveBeenCalled();
    expect(h.safeDispatchOutput).toHaveBeenCalledTimes(1);
    expect(h.mensagensCreate).not.toHaveBeenCalled();
    expect(r).toEqual({
      totalTokens: 0,
      outboundText: 'Oi! Tudo certo.',
      toolsCalled: [],
      delivery: {
        dispatched: true,
        exitReason: 'empty_final_text',
        persistUnknown: false,
        sideEffectsCommitted: false,
      },
    });
  });
});
