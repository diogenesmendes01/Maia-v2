import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * Review da PR #554 — o span `context.load` sai num turno DE VERDADE.
 *
 * ## Por que este arquivo existe, e por que ele é de integração
 *
 * O gate 6 da #535 já tinha um spec verde para `context.load`. Ele instrumentava
 * `buildContextPacket` e chamava `buildContextPacket` — então provava que a
 * chamada existia no repositório, não que produção passava por ela. E não
 * passava: a PR #406 removeu o hot path `FEATURE_CONTEXT_PACKET_V1`, e o
 * orquestrador P8a ficou sem chamador. Métrica dashboardada, alerta escrito,
 * zero série.
 *
 * A lição é sobre o FORMATO do teste, não sobre aquele call site: um teste que
 * chama a função instrumentada não distingue "instrumentado" de "alcançado".
 * Por isso aqui não há nenhuma menção a `loadTurnContext` — a entrada é
 * `runAgentForMensagem`, o entry point que o worker BullMQ chama
 * (`src/index.ts:215`), envelopado no MESMO span raiz que
 * `src/gateway/queue.ts:186` abre. Tudo entre uma ponta e outra é código de
 * produção contra um Postgres real.
 *
 * O caso que fecha a prova é o de apagar: remover a linha
 * `instrumentContextLoad(...)` de `src/agent/turn-context/loader.ts` derruba
 * este arquivo. Nenhum harness daqui reconstrói aquela chamada.
 *
 * ## O que é mockado, e por quê
 *
 * Só as duas fronteiras EXTERNAS: o provedor de LLM e a saída física do canal.
 * Nenhuma das duas fica entre o entry point e a carga de contexto — a carga
 * acontece em `buildPrompt`, antes da primeira chamada ao modelo. Mockar
 * qualquer coisa abaixo disso reabriria o buraco que este arquivo fecha.
 *
 * Pulado sem `TEST_DB_URL`: sem banco o turno morre antes de hidratar contexto,
 * e um verde nessas condições não afirma nada.
 */
const { cfg, callLLM, sendText } = vi.hoisted(() => ({
  cfg: {
    endpoint: 'http://collector:4318/v1/traces' as string | undefined,
    ratio: 1,
  },
  callLLM: vi.fn(async () => ({
    content: 'ok',
    tool_uses: [] as unknown[],
    usage: { input_tokens: 1, output_tokens: 1 },
  })),
  sendText: vi.fn(async () => ({ whatsapp_id: 'wamid.pr554' })),
}));

vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env.js')>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop, receiver) => {
        // Tracing tem que estar LIGADO — sem endpoint `withSpan` curto-circuita
        // e nenhum span existiria para observar (`tracingEnabled()`).
        if (prop === 'MAIA_OTLP_TRACES_ENDPOINT') return cfg.endpoint;
        if (prop === 'MAIA_OTLP_SAMPLE_RATIO') return cfg.ratio;
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

// Fronteira externa 1: o provedor. Determinístico, sem rede, sem tools — o
// turno responde uma frase e termina.
vi.mock('@/lib/claude.js', () => ({ callLLM }));

// Fronteira externa 2: a saída física. `forCurrentAgentChannel` é a fronteira
// única de envio (spec roteamento v4 §1.6); um fake aqui evita WhatsApp sem
// tocar em nada do caminho de contexto.
vi.mock('@/gateway/line-output.js', () => ({
  forCurrentAgentChannel: vi.fn(async () => ({
    scope: { tenant_id: 'primary', agent_id: 'primary', channel_id: null },
    sendText,
    sendDocument: vi.fn(),
    sendVoice: vi.fn(),
    sendPoll: vi.fn(),
    sendReaction: vi.fn(),
    startTyping: vi.fn(() => ({ stop: vi.fn() })),
    markRead: vi.fn(),
    isConnected: () => true,
  })),
}));
vi.mock('@/gateway/baileys.js', () => ({
  sendOutboundText: sendText,
  sendOutboundDocument: vi.fn(),
  sendOutboundVoice: vi.fn(),
  isBaileysConnected: () => true,
}));

import pg from 'pg';
import { runAgentForMensagem } from '@/agent/core.js';
import { runWithSystemContext } from '@/db/tenant-context.js';
import { runWithCorrelation } from '@/observability/correlation.js';
import { setSpanSink, withSpan, type EndedSpan } from '@/observability/tracer.js';
import {
  CONTEXT_LOAD_STAGE,
  SPAN,
  SPAN_EMISSION,
  SPAN_PARENT,
} from '@/observability/taxonomy.js';
import { renderPrometheus, _resetForTests } from '@/lib/metrics.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

/**
 * O turno roda sob o tenant catch-all `primary/primary`, que é o que o
 * resolver devolve no runtime single-tenant. Não é um atalho do teste: é a
 * tupla que `runAgentForMensagem` resolve quando a sonda de canal não encontra
 * telefone no `metadata` (o inbound já chega com `conversa_id`, então a
 * identidade não precisa ser resolvida de novo).
 */
const TENANT = 'primary';
const AGENT = 'primary';
/** UUID canônico: o tracer só aceita esse formato como trace id derivado. */
const TRACE_ID = '9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f';

let pool: pg.Pool;
let pessoaId: string;
let conversaId: string;
let captured: EndedSpan[] = [];

async function seedTurn(): Promise<string> {
  const c = await pool.connect();
  try {
    // `dono`: o rate limiter é fail-CLOSED quando o Redis não está conectado
    // (`src/gateway/rate-limit.ts:162`) e silenciaria um não-owner antes da
    // carga de contexto. O owner é isento por design, então o turno depende de
    // Postgres e de mais nada — sem isso o caso ficaria verde ou vermelho
    // conforme o estado do Redis da máquina, que é ruído, não sinal.
    const p = await c.query<{ id: string }>(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1, $2, 'PR554 Dono', $3, 'dono', 'ativa')
       RETURNING id`,
      [TENANT, AGENT, `+55119${Date.now().toString().slice(-8)}`],
    );
    pessoaId = p.rows[0]!.id;

    const conv = await c.query<{ id: string }>(
      `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status)
       VALUES ($1, $2, $3, 'ativa') RETURNING id`,
      [TENANT, AGENT, pessoaId],
    );
    conversaId = conv.rows[0]!.id;

    // `metadata` deliberadamente SEM `telefone`: a sonda de canal devolve null,
    // a tupla catch-all é mantida e o inner segue pelo `conversa_id` já
    // resolvido. É o caminho de produção para um inbound já vinculado.
    const m = await c.query<{ id: string }>(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
       VALUES ($1, $2, $3, 'in', 'texto', 'quanto eu gastei esse mês?', '{}'::jsonb)
       RETURNING id`,
      [TENANT, AGENT, conversaId],
    );
    return m.rows[0]!.id;
  } finally {
    c.release();
  }
}

/**
 * Ordem de remoção = ordem das FKs (`audit_log` e `agent_turn_inputs` apontam
 * para `mensagens`, e o turno escreve nas duas). Um `DELETE` na ordem errada
 * falha no `afterEach` e mascara o resultado do caso com um erro de limpeza.
 *
 * Desde #631 (fatia B da #506) um turno REAL também deixa uma row em
 * `outbound_messages`: a resposta é commitada no outbox durável antes de ir ao
 * canal. A migração 121 liga essa row ao turno por FK composta com
 * `ON DELETE RESTRICT` — de propósito, porque apagar um turno que tem outbound
 * pendente é exatamente o que não pode acontecer em silêncio. Logo o outbox sai
 * ANTES do turno, e o `RESTRICT` faz este arquivo reprovar caso alguém inverta.
 */
async function cleanup(): Promise<void> {
  if (!conversaId) return;
  const c = await pool.connect();
  try {
    await c.query(
      `DELETE FROM audit_log WHERE conversa_id = $1
          OR mensagem_id IN (SELECT id FROM mensagens WHERE conversa_id = $1)`,
      [conversaId],
    );
    await c.query(
      `DELETE FROM agent_turn_inputs
        WHERE mensagem_id IN (SELECT id FROM mensagens WHERE conversa_id = $1)`,
      [conversaId],
    );
    await c.query(`DELETE FROM outbound_messages WHERE conversa_id = $1`, [conversaId]);
    await c.query(`DELETE FROM agent_turns WHERE conversa_id = $1`, [conversaId]);
    await c.query(`DELETE FROM mensagens WHERE conversa_id = $1`, [conversaId]);
    await c.query(`DELETE FROM pending_questions WHERE conversa_id = $1`, [conversaId]);
    await c.query(`DELETE FROM conversas WHERE id = $1`, [conversaId]);
    await c.query(`DELETE FROM permissoes WHERE pessoa_id = $1`, [pessoaId]);
    await c.query(`DELETE FROM agent_audience_profiles WHERE pessoa_id = $1`, [pessoaId]);
    await c.query(`DELETE FROM pessoas WHERE id = $1`, [pessoaId]);
  } finally {
    c.release();
  }
}

/**
 * Um turno como o worker o executa: correlação → span raiz `turn` → contexto
 * `system` sancionado → `runAgentForMensagem`. As três camadas são copiadas de
 * `src/gateway/queue.ts:186`; o que está DENTRO delas é produção intocada.
 */
async function runTurnLikeTheWorker(mensagemId: string): Promise<void> {
  await runWithCorrelation({ trace_id: TRACE_ID }, () =>
    withSpan(SPAN.TURN, () => runWithSystemContext(() => runAgentForMensagem(mensagemId)), {
      attributes: { queue: 'agent', phase: 'first' },
    }),
  );
}

d('review da PR #554 — um turno real abre o span context.load', () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(() => {
    captured = [];
    _resetForTests();
    cfg.endpoint = 'http://collector:4318/v1/traces';
    cfg.ratio = 1;
    setSpanSink((s) => captured.push(s));
    callLLM.mockClear();
  });
  afterEach(async () => {
    setSpanSink(null);
    await cleanup();
  });

  it('emite EXATAMENTE um context.load, filho do turn, com stage=turn_context', async () => {
    const mensagemId = await seedTurn();
    await runTurnLikeTheWorker(mensagemId);

    // Guarda contra o modo de falha caro: um turno que morreu antes de hidratar
    // o contexto (rate limit, gate, conversa sumida) não abre span nenhum, e um
    // `toHaveLength(0)` silencioso leria como "instrumentação quebrada" quando o
    // problema é que o turno não chegou lá. O LLM chamado prova que chegou.
    expect(callLLM, 'o turno não alcançou a chamada ao LLM').toHaveBeenCalled();

    const loads = captured.filter((s) => s.name === SPAN.CONTEXT_LOAD);
    expect(loads).toHaveLength(1);
    expect(loads[0]!.attributes.stage).toBe(CONTEXT_LOAD_STAGE.TURN_CONTEXT);
    expect(loads[0]!.status).toBe('ok');

    // O span carrega a tupla do turno — um span que ninguém consegue filtrar
    // por tenant é o defeito que a rodada 2 da review da PR #541 abriu.
    expect(loads[0]!.attributes.tenant_id).toBe(TENANT);
    expect(loads[0]!.attributes.agent_id).toBe(AGENT);

    // E ele se encaixa no lugar declarado da árvore. A waterfall exportada tem
    // que concordar com `SPAN_PARENT`, senão "o turno foi lento AQUI" aponta
    // para lugar nenhum.
    //
    // Desde a #535 esse lugar é `prompt.render`, e a correção é o que este
    // arquivo mede: o pai declarado ERA `turn`, mas quem chama `loadTurnContext`
    // é `buildPrompt` — então na waterfall real a carga sempre esteve dentro da
    // montagem do prompt, e a árvore é que estava errada. O par é o que separa
    // "gastamos o tempo LENDO estado" de "gastamos MONTANDO o prompt".
    const turn = captured.find((s) => s.name === SPAN.TURN);
    const render = captured.find((s) => s.name === SPAN.PROMPT_RENDER);
    expect(render, 'o turno não abriu prompt.render').toBeDefined();
    expect(SPAN_PARENT[SPAN.CONTEXT_LOAD]).toBe(SPAN.PROMPT_RENDER);
    expect(loads[0]!.parent_span_id).toBe(render!.span_id);
    expect(render!.parent_span_id).toBe(turn!.span_id);
    expect(loads[0]!.trace_id).toBe(turn!.trace_id);
  });

  it('a taxonomia diz `emitted` e o turno acabou de provar', async () => {
    const mensagemId = await seedTurn();
    await runTurnLikeTheWorker(mensagemId);

    // As duas metades da afirmação, no mesmo caso. `SPAN_EMISSION` significa
    // "produção alcança" desde a review da PR #554; asserir só a tabela seria
    // asserir a própria alegação.
    expect(SPAN_EMISSION[SPAN.CONTEXT_LOAD]).toBe('emitted');
    expect(captured.some((s) => s.name === SPAN.CONTEXT_LOAD)).toBe(true);
  });

  it('mede a carga inteira — o span não fecha antes das leituras', async () => {
    const mensagemId = await seedTurn();
    await runTurnLikeTheWorker(mensagemId);

    const load = captured.find((s) => s.name === SPAN.CONTEXT_LOAD)!;
    const turn = captured.find((s) => s.name === SPAN.TURN)!;
    // Um wrapper posto em volta de um sub-passo (uma fatia, um repositório)
    // fecharia em ~0ns e ficaria fora da janela do turno. Estas duas asserções
    // são baratas e pegam exatamente esse deslocamento.
    expect(load.end_unix_nano).toBeGreaterThan(load.start_unix_nano);
    expect(load.start_unix_nano).toBeGreaterThanOrEqual(turn.start_unix_nano);
    expect(load.end_unix_nano).toBeLessThanOrEqual(turn.end_unix_nano);
  });

  it('a carga do turno não ressuscita a família aposentada de métricas', async () => {
    const mensagemId = await seedTurn();
    await runTurnLikeTheWorker(mensagemId);

    const metrics = await renderPrometheus();
    // A decisão do dono: reusar EXCLUSIVAMENTE `maia_turn_context_*`. Um turno
    // real é o único lugar onde "não duplicou" pode ser verificado de fato —
    // no unitário do wrapper, a ausência é trivial.
    expect(metrics).not.toContain('maia_context_load_ms');
    expect(metrics).not.toContain('maia_context_slices_total');
    // E a família reusada continua sendo emitida pelo mesmo turno: aposentar as
    // órfãs não podia deixar a carga de contexto sem sinal nenhum.
    expect(metrics).toContain('maia_turn_context_load_duration_ms');
    expect(metrics).toMatch(/maia_turn_context_load_duration_ms_count\{[^}]*phase="loader"/);
  });
});
