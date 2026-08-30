import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * Issue #535 — a ÁRVORE de spans de um turno REAL.
 *
 * ## Por que este arquivo existe, e por que ele é de integração
 *
 * A #535 abre dizendo que "quem ler `src/observability/taxonomy.ts` pode
 * concluir que a cobertura é maior do que é". A decisão do dono foi que um span
 * que só existe na declaração é dívida, então cada nome ou ganha emissor no
 * caminho de PRODUÇÃO ou sai com justificativa. "No caminho de produção" é a
 * parte que um teste tem que provar, e é a parte que um teste errado não prova.
 *
 * A lição está escrita em `context-load-span-hot-path.spec.ts`, e este arquivo
 * a herda inteira: um teste que CHAMA a função instrumentada não distingue
 * "instrumentado" de "alcançado". O gate 6 já tinha um verde para
 * `context.load` enquanto o wrapper estava sobre `buildContextPacket`, cujo hot
 * path a PR #406 havia removido — métrica dashboardada, alerta escrito, zero
 * série.
 *
 * Por isso aqui não há UMA menção a `buildPrompt`, `selectRole`,
 * `dispatchTool`, `concludeTurn` ou `commitOutboundIntent`. A entrada é
 * `runAgentForMensagem`, o entry point que o worker BullMQ chama
 * (`src/index.ts`), envelopado no MESMO span raiz que `src/gateway/queue.ts`
 * abre. Tudo entre uma ponta e outra é código de produção contra um Postgres
 * real, e cada span afirmado abaixo é um span que um turno de verdade abriu.
 *
 * O caso que fecha a prova é o de apagar: remover qualquer uma das chamadas
 * `instrument*(...)` do seu call site de produção derruba este arquivo, e
 * derruba com o nome do span na mensagem. Nenhum harness daqui reconstrói
 * nenhuma delas.
 *
 * ## O que é mockado, e por quê
 *
 * As mesmas duas fronteiras EXTERNAS do arquivo irmão: o provedor de LLM e a
 * saída física do canal. Nenhuma das duas fica entre o entry point e as etapas
 * medidas — a saída física, desde #316/#630, nem sequer acontece no turno (é o
 * delivery worker que a faz, e é por isso que `whatsapp.send` saiu da
 * taxonomia). Mockar qualquer coisa abaixo disso reabriria o buraco que este
 * arquivo fecha.
 *
 * Pulado sem `TEST_DB_URL`: sem banco o turno morre antes de resolver escopo, e
 * um verde nessas condições não afirma nada.
 */
const { cfg, callLLM, sendText, spanNoMomentoDoLLM } = vi.hoisted(() => ({
  cfg: {
    endpoint: 'http://collector:4318/v1/traces' as string | undefined,
    ratio: 1,
  },
  /**
   * O provedor, e mais uma coisa: ele ANOTA qual span estava aberto no instante
   * da chamada. É assim que este arquivo prova o aninhamento de `llm.request`
   * sem desmockar o gateway inteiro — ver o caso "a chamada ao modelo acontece
   * DENTRO de react.iteration".
   */
  spanNoMomentoDoLLM: [] as (string | null)[],
  callLLM: vi.fn(async () => ({
    content: 'ok',
    tool_uses: [] as unknown[],
    usage: { input_tokens: 1, output_tokens: 1 },
  })),
  sendText: vi.fn(async () => ({ whatsapp_id: 'wamid.535tree' })),
}));

vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env.js')>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop, receiver) => {
        // Tracing LIGADO — sem endpoint `withSpan` curto-circuita e não haveria
        // span nenhum para observar (`tracingEnabled()`). Ratio 1 porque a
        // amostragem é derivada do trace id: com o default de 0.05 o turno
        // deste caso seria descartado em ~95% das rodadas, o que é flake.
        if (prop === 'MAIA_OTLP_TRACES_ENDPOINT') return cfg.endpoint;
        if (prop === 'MAIA_OTLP_SAMPLE_RATIO') return cfg.ratio;
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

vi.mock('@/lib/claude.js', async () => {
  const { currentSpan } = await import('@/observability/tracer.js');
  return {
    callLLM: vi.fn(async () => {
      spanNoMomentoDoLLM.push(currentSpan()?.name ?? null);
      return callLLM();
    }),
  };
});

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
import {
  setSpanSink,
  withSpan,
  isDeclaredAncestor,
  type EndedSpan,
} from '@/observability/tracer.js';
import {
  SPAN,
  SPAN_EMISSION,
  SPAN_NAMES,
  SPAN_PARENT,
  type SpanName,
} from '@/observability/taxonomy.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 'primary';
const AGENT = 'primary';
/** UUID canônico: o tracer só aceita esse formato como trace id derivado. */
const TRACE_ID = 'a1b2c3d4-e5f6-4708-9a1b-2c3d4e5f6071';

let pool: pg.Pool;
let pessoaId: string;
let conversaId: string;
let channelId: string;
let mensagemIds: string[] = [];
let captured: EndedSpan[] = [];

/**
 * @param comConversa quando `false`, o inbound entra SEM `conversa_id` — que é
 *   o único caminho em que `agent/core.ts` chama `resolveIdentity`. Um inbound
 *   já vinculado pula a resolução de identidade por construção, então provar o
 *   span `identity.resolve` exige o inbound de PRIMEIRO contato, e não uma
 *   chamada direta ao resolver.
 */
async function seedTurn(comConversa = true): Promise<string> {
  const c = await pool.connect();
  try {
    // `dono` pelo mesmo motivo do arquivo irmão: o rate limiter é fail-CLOSED
    // sem Redis conectado e silenciaria um não-owner antes das etapas medidas.
    // O owner é isento por design, então o turno depende de Postgres e de mais
    // nada.
    const telefone = `+55118${Date.now().toString().slice(-8)}`;
    const p = await c.query<{ id: string }>(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1, $2, 'Dono 535', $3, 'dono', 'ativa')
       RETURNING id`,
      [TENANT, AGENT, telefone],
    );
    pessoaId = p.rows[0]!.id;

    // Perfil de audiência ATIVO: `resolveIdentity` é fail-closed sem ele
    // (#407) e devolveria `quarantined` antes de qualquer coisa. É pré-condição
    // do caminho de produção, não conveniência do teste.
    await c.query(
      `INSERT INTO agent_audience_profiles(tenant_id, agent_id, pessoa_id, audience_type, trust_level, status)
       VALUES ($1, $2, $3, 'owner', 'trusted_internal', 'active')
       ON CONFLICT DO NOTHING`,
      [TENANT, AGENT, pessoaId],
    );

    const conv = await c.query<{ id: string }>(
      `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status)
       VALUES ($1, $2, $3, 'ativa') RETURNING id`,
      [TENANT, AGENT, pessoaId],
    );
    conversaId = conv.rows[0]!.id;

    // Um canal PRÓPRIO, casado por exact-match no `external_id` do remetente.
    //
    // A versão anterior deste seed dependia do canal catch-all semeado pela
    // migração, e isso era flake de ORDEM: `resolveChannel` só cai no catch-all
    // quando o deployment é comprovadamente single-tenant, e qualquer outra
    // spec de integração que deixe um canal de outro tenant no banco torna o
    // deployment multi-tenant — aí o resolver falha fechado ("channel not found
    // or inactive"), corretamente, e este arquivo ficava vermelho por causa de
    // um vizinho. Rodando sozinho passava; na suíte inteira, não.
    //
    // Com o canal abaixo o passo 2 do resolver legado (exact match ativo)
    // resolve antes de o discriminador de multi-tenancy ser consultado, então o
    // resultado independe do que mais exista no banco.
    const ch = await c.query<{ id: string }>(
      `INSERT INTO channels(tenant_id, agent_id, channel_type, external_id, display_name, active, is_synthetic)
       VALUES ($1, $2, 'whatsapp', $3, 'Linha 535', true, false) RETURNING id`,
      [TENANT, AGENT, telefone],
    );
    channelId = ch.rows[0]!.id;

    // A política do canal é a pré-condição de `buildRoleInputs` e, portanto, do
    // node `role-selector` — sem ela metade do pré-turno não roda e o span
    // `role.select` não teria como sair de um turno real. O papel default é um
    // dos ativos já semeados; qual deles é irrelevante para o que se mede.
    const role = await c.query<{ id: string }>(
      `SELECT id FROM roles WHERE tenant_id = $1 AND agent_id = $2 AND active LIMIT 1`,
      [TENANT, AGENT],
    );
    if (role.rows.length === 0) throw new Error('nenhum role ativo semeado — seed do banco mudou');
    await c.query(
      `INSERT INTO channel_policies(tenant_id, agent_id, channel_id, default_role_id, switch_behavior)
       VALUES ($1, $2, $3, $4, 'free_with_trigger')`,
      [TENANT, AGENT, channelId, role.rows[0]!.id],
    );

    // `metadata.telefone` é o que faz a sonda de canal devolver um probe (sem
    // ele o turno mantém a tupla catch-all e `channel_id` fica null).
    const m = await c.query<{ id: string }>(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
       VALUES ($1, $2, $3, 'in', 'texto', 'me da um resumo do mes', $4::jsonb)
       RETURNING id`,
      [
        TENANT,
        AGENT,
        comConversa ? conversaId : null,
        JSON.stringify({ telefone }),
      ],
    );
    mensagemIds.push(m.rows[0]!.id);
    return m.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Ordem de remoção = ordem das FKs. Ver o comentário longo no arquivo irmão. */
async function cleanup(): Promise<void> {
  if (!pessoaId) return;
  const c = await pool.connect();
  try {
    // A limpeza é por PESSOA, e não por conversa como no arquivo irmão: no caso
    // de primeiro contato o inbound entra sem `conversa_id` e o próprio turno
    // cria a conversa, então "a conversa que semeei" não é o conjunto que
    // precisa sair. `mensagemIds` cobre a janela em que a mensagem ainda não
    // pertence a conversa nenhuma.
    const doPessoa = `(SELECT id FROM conversas WHERE pessoa_id = $1)`;
    await c.query(
      `DELETE FROM audit_log
        WHERE pessoa_id = $1
           OR conversa_id IN ${doPessoa}
           OR mensagem_id = ANY($2::uuid[])`,
      [pessoaId, mensagemIds],
    );
    await c.query(
      `DELETE FROM agent_turn_inputs
        WHERE mensagem_id = ANY($2::uuid[])
           OR mensagem_id IN (SELECT id FROM mensagens WHERE conversa_id IN ${doPessoa})`,
      [pessoaId, mensagemIds],
    );
    await c.query(
      `DELETE FROM outbound_messages WHERE conversa_id IN ${doPessoa}`,
      [pessoaId],
    );
    await c.query(`DELETE FROM agent_turns WHERE conversa_id IN ${doPessoa}`, [pessoaId]);
    await c.query(
      `DELETE FROM mensagens WHERE id = ANY($2::uuid[]) OR conversa_id IN ${doPessoa}`,
      [pessoaId, mensagemIds],
    );
    await c.query(
      `DELETE FROM pending_questions WHERE conversa_id IN
         (SELECT id FROM conversas WHERE pessoa_id = $1)`,
      [pessoaId],
    );
    await c.query(`DELETE FROM conversas WHERE pessoa_id = $1`, [pessoaId]);
    await c.query(`DELETE FROM permissoes WHERE pessoa_id = $1`, [pessoaId]);
    await c.query(`DELETE FROM agent_audience_profiles WHERE pessoa_id = $1`, [pessoaId]);
    await c.query(`DELETE FROM pessoas WHERE id = $1`, [pessoaId]);
    // O canal sai POR ÚLTIMO e sempre: um canal ativo deixado para trás de um
    // tenant qualquer é o que torna o deployment "multi-tenant" para o próximo
    // arquivo — exatamente o vazamento de ordem que este seed passou a evitar.
    if (channelId) {
      // A decisão do role-selector aponta para a POLÍTICA por FK — o turno
      // grava uma por execução. Sai antes, senão o `DELETE` da política falha e
      // o erro de limpeza mascara o resultado do caso.
      await c.query(`DELETE FROM role_selector_decisions WHERE channel_id = $1`, [channelId]);
      await c.query(`DELETE FROM channel_policies WHERE channel_id = $1`, [channelId]);
      await c.query(`DELETE FROM channels WHERE id = $1`, [channelId]);
    }
  } finally {
    c.release();
  }
}

/**
 * Um turno como o worker o executa: correlação → span raiz `turn` → contexto
 * `system` sancionado → `runAgentForMensagem`. As três camadas são copiadas de
 * `src/gateway/queue.ts`; o que está DENTRO delas é produção intocada.
 */
async function runTurnLikeTheWorker(mensagemId: string): Promise<void> {
  await runWithCorrelation({ trace_id: TRACE_ID }, () =>
    withSpan(SPAN.TURN, () => runWithSystemContext(() => runAgentForMensagem(mensagemId)), {
      attributes: { queue: 'agent', phase: 'first' },
    }),
  );
}

function spansNamed(name: SpanName): EndedSpan[] {
  return captured.filter((s) => s.name === name);
}

/**
 * Os spans que ESTE turno tem que abrir.
 *
 * Não é a taxonomia inteira de propósito, e a diferença é declarada em vez de
 * conveniente. Três ausências, com o motivo de cada:
 *
 *  - `tool.dispatch` e os quatro portões abaixo dele (`constitutional.check`,
 *    `permission.check`, `idempotency.claim`, `handler.execute`) — este turno
 *    responde em texto e não chama tool nenhuma. A prova de fiação deles entra
 *    pelo `dispatchTool` real em
 *    `tests/unit/observability/dispatcher-gate-spans.spec.ts`.
 *  - `queue.wait` — só existe quando o job veio pela fila BullMQ; aqui o turno é
 *    aberto direto, como no arquivo irmão. Coberto em `tracer.spec.ts`.
 *  - `llm.request` — o emissor é `emitUsage` (`src/lib/llm/telemetry.ts`), e
 *    este arquivo mocka `@/lib/claude.js`, que fica ACIMA dele. Desmockar
 *    exigiria trazer o SDK, o resolver de modelo, o ledger de custo e o
 *    disjuntor para dentro de um teste de turno, e
 *    `tests/unit/observability/llm-request-span.spec.ts` já dirige o
 *    `executeLLM` REAL para isso. O que ESTE arquivo prova sobre ele é a outra
 *    metade, a que aquele não pode provar: que a chamada ao modelo acontece
 *    dentro de `react.iteration` — ver o caso próprio abaixo.
 *
 * Todo o RESTO da árvore é obrigatório aqui — é o caminho que qualquer turno de
 * texto percorre.
 */
const ESPERADOS_NESTE_TURNO: readonly SpanName[] = [
  SPAN.TURN,
  SPAN.AUDIENCE_RESOLVE,
  SPAN.PRETURN_GRAPH,
  SPAN.PROCEDURE_SELECT,
  SPAN.ROLE_SELECT,
  SPAN.DECISION_EVALUATE,
  SPAN.RISK_CLASSIFY,
  SPAN.PROMPT_RENDER,
  SPAN.CONTEXT_LOAD,
  SPAN.REACT_ITERATION,
  SPAN.OUTBOUND_COMMIT,
  SPAN.TURN_COMPLETE,
];

d('issue #535 — um turno real abre a árvore de spans declarada', () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(() => {
    captured = [];
    mensagemIds = [];
    spanNoMomentoDoLLM.length = 0;
    cfg.endpoint = 'http://collector:4318/v1/traces';
    cfg.ratio = 1;
    setSpanSink((s) => captured.push(s));
    callLLM.mockClear();
  });
  afterEach(async () => {
    setSpanSink(null);
    await cleanup();
  });

  it('abre cada span do caminho do turno — um por um, nomeado na falha', async () => {
    const mensagemId = await seedTurn();
    await runTurnLikeTheWorker(mensagemId);

    // Guarda contra o modo de falha caro: um turno que morreu cedo (rate limit,
    // gate, conversa sumida) não abre span nenhum, e uma bateria de
    // `toHaveLength(0)` leria como "instrumentação quebrada" quando o problema é
    // que o turno não chegou lá. O LLM chamado prova que chegou até o reasoner.
    expect(callLLM, 'o turno não alcançou a chamada ao LLM').toHaveBeenCalled();

    // Uma asserção POR SPAN, e não um `toEqual` de conjunto, porque a mensagem
    // de falha é o produto: apagar `instrumentPromptRender` de
    // `src/agent/prompt-builder.ts` tem que dizer "prompt.render" e não
    // "arrays diferem".
    for (const name of ESPERADOS_NESTE_TURNO) {
      expect(
        spansNamed(name).length,
        `o turno não abriu o span \`${name}\` — o emissor sumiu do call site de produção?`,
      ).toBeGreaterThan(0);
    }
  });

  it('o primeiro contato abre `identity.resolve` — o único caminho que o alcança', async () => {
    // `agent/core.ts` só chama `resolveIdentity` quando o inbound chega SEM
    // `conversa_id`; um inbound já vinculado pula a resolução por construção.
    // Então o caso não é "chame o resolver", é "entre pelo turno de primeiro
    // contato" — que é a diferença entre provar instrumentação e provar
    // alcance, e é a lição que este arquivo herda da review da PR #554.
    const mensagemId = await seedTurn(false);
    await runTurnLikeTheWorker(mensagemId);

    const spans = spansNamed(SPAN.IDENTITY_RESOLVE);
    expect(
      spans.length,
      'o turno de primeiro contato não abriu `identity.resolve`',
    ).toBeGreaterThan(0);
    // `resolved`, não `quarantined`: a pessoa tem perfil de audiência ativo, e
    // um `quarantined` aqui significaria que o turno morreu no fail-closed
    // antes do que este arquivo mede.
    expect(spans[0]!.attributes.kind).toBe('resolved');
    // E o telefone NÃO viaja no span. É o valor mais sensível deste caminho e a
    // única razão pela qual o wrapper vive em `observability/instrumentation.ts`
    // em vez do call site.
    for (const v of Object.values(spans[0]!.attributes)) {
      expect(String(v)).not.toContain('+5511');
    }
  });

  it('a árvore exportada bate com a árvore declarada', async () => {
    const mensagemId = await seedTurn();
    await runTurnLikeTheWorker(mensagemId);
    expect(callLLM).toHaveBeenCalled();

    const byId = new Map(captured.map((s) => [s.span_id, s]));
    const raiz = spansNamed(SPAN.TURN)[0]!;

    for (const span of captured) {
      if (span.span_id === raiz.span_id) {
        expect(span.parent_span_id, 'a raiz `turn` não pode ter pai').toBeNull();
        continue;
      }
      // Todo span do turno mora no MESMO trace. Um trace partido é pior que
      // nenhum — a metade ausente se lê como "aquela etapa não rodou".
      expect(span.trace_id, `${span.name} saiu de outro trace`).toBe(raiz.trace_id);
      const pai = span.parent_span_id ? byId.get(span.parent_span_id) : undefined;
      expect(pai, `${span.name} aponta para um pai que não foi exportado`).toBeDefined();
      // E o pai de runtime tem que ser um ANCESTRAL DECLARADO. É esta asserção
      // que pega instrumentação aninhada no lugar errado — e é ela que obrigou a
      // corrigir três entradas de `SPAN_PARENT` nesta issue, porque a árvore
      // declarada descrevia um aninhamento que o código não tem.
      expect(
        pai!.name === SPAN_PARENT[span.name] || isDeclaredAncestor(span.name, pai!.name),
        `${span.name} saiu sob \`${pai!.name}\`, que não é ancestral declarado dele`,
      ).toBe(true);
    }
  });

  it('as três correções de parentesco valem na waterfall, não só na tabela', async () => {
    const mensagemId = await seedTurn();
    await runTurnLikeTheWorker(mensagemId);
    expect(callLLM).toHaveBeenCalled();

    // `context.load` DENTRO de `prompt.render` — a correção que separa "lendo
    // estado" de "montando o prompt".
    const render = spansNamed(SPAN.PROMPT_RENDER)[0]!;
    expect(spansNamed(SPAN.CONTEXT_LOAD)[0]!.parent_span_id).toBe(render.span_id);

    // `risk.classify` DENTRO de `decision.evaluate` — o pai declarado era
    // `preturn.graph`, que tem exatamente dois nodes e nenhum deles é risco.
    const decision = spansNamed(SPAN.DECISION_EVALUATE)[0]!;
    expect(spansNamed(SPAN.RISK_CLASSIFY)[0]!.parent_span_id).toBe(decision.span_id);

    // `role.select` e `procedure.select` DENTRO de `preturn.graph` — sem esse
    // escopo os dois se penduravam em `turn` e a waterfall não mostrava que
    // rodam em paralelo.
    const preturn = spansNamed(SPAN.PRETURN_GRAPH)[0]!;
    expect(spansNamed(SPAN.PROCEDURE_SELECT)[0]!.parent_span_id).toBe(preturn.span_id);
    expect(spansNamed(SPAN.ROLE_SELECT)[0]!.parent_span_id).toBe(preturn.span_id);

  });

  it('a chamada ao modelo acontece DENTRO de react.iteration', async () => {
    const mensagemId = await seedTurn();
    await runTurnLikeTheWorker(mensagemId);
    expect(callLLM).toHaveBeenCalled();

    // A metade do aninhamento de `llm.request` que só um turno real prova.
    //
    // O span sai de `emitUsage`, que este arquivo mocka acima; mas o PAI que
    // ele receberá é o span aberto no instante da chamada, e isso é observável
    // aqui: o mock de `callLLM` anota `currentSpan()`. Se `react.iteration`
    // fosse removido do laço, o reasoner passaria a rodar sob `turn` e este
    // caso ficaria vermelho — que é exatamente a regressão que interessa,
    // porque era esse o estado ANTES desta issue.
    expect(spanNoMomentoDoLLM).toContain(SPAN.REACT_ITERATION);

    // E, de brinde, a mesma técnica confirma que o reasoner do role-selector
    // roda dentro do SEU span, sem vazar para o pai. (O procedure-selector não
    // aparece aqui e isso está certo: sem procedimento atribuído ele decide
    // `none` sem chamar o modelo — o span dele sai mesmo assim, e é o caso
    // "abre cada span do caminho do turno" que o cobre.)
    expect(spanNoMomentoDoLLM).toContain(SPAN.ROLE_SELECT);
    // Nenhuma chamada ao modelo pode ter acontecido direto sob a raiz: se
    // acontecesse, o span dela ficaria órfão de etapa e a waterfall não diria
    // QUAL parte do turno pagou o round-trip.
    expect(spanNoMomentoDoLLM).not.toContain(SPAN.TURN);
  });

  it('todo span do turno é atribuível ao tenant que o turno resolveu', async () => {
    const mensagemId = await seedTurn();
    await runTurnLikeTheWorker(mensagemId);
    expect(callLLM).toHaveBeenCalled();

    // Um span que ninguém consegue filtrar por tenant é o defeito que a rodada 2
    // da review da PR #541 abriu, e ele reaparece a cada emissor novo: um
    // wrapper posto fora do escopo resolvido exporta `system` e some da
    // investigação do tenant. Vale para TODOS, não só para os do arquivo irmão.
    for (const span of captured) {
      expect(span.attributes.tenant_id, `${span.name} sem tenant`).toBe(TENANT);
      expect(span.attributes.agent_id, `${span.name} sem agent`).toBe(AGENT);
    }
  });

  it('nenhum span carrega atributo fora da lista permitida', async () => {
    const mensagemId = await seedTurn();
    await runTurnLikeTheWorker(mensagemId);
    expect(callLLM).toHaveBeenCalled();

    // `sanitizeSpanAttributes` já é o portão, e `MAIA_STRICT_METRIC_LABELS` o
    // transforma em throw na suíte unitária. Aqui a verificação é sobre o que
    // SOBROU: nenhum valor sanitizado, porque um `__sanitized__` num span de
    // turno real significa que um emissor novo tentou exportar dado de pessoa e
    // o portão o pegou — o portão funcionando não é motivo para deixar a
    // tentativa no código.
    for (const span of captured) {
      for (const [k, v] of Object.entries(span.attributes)) {
        expect(v, `${span.name}.${k} foi sanitizado — o emissor tentou exportar PII`).not.toBe(
          '__sanitized__',
        );
      }
    }
  });

  it('a taxonomia não tem mais nenhum span apenas `declared`', async () => {
    const mensagemId = await seedTurn();
    await runTurnLikeTheWorker(mensagemId);
    expect(callLLM).toHaveBeenCalled();

    // As duas metades da afirmação, no mesmo caso. Asserir só a tabela seria
    // asserir a própria alegação — que é exatamente como `context.load` passou
    // meses marcado como coberto sobre um call site que a PR #406 tinha
    // apagado. A metade de baixo é o turno que acabou de rodar.
    for (const name of SPAN_NAMES) {
      expect(SPAN_EMISSION[name], `${name} continua só declarado`).toBe('emitted');
    }
    for (const name of ESPERADOS_NESTE_TURNO) {
      expect(spansNamed(name).length, `${name} marcado emitted sem sair no turno`).toBeGreaterThan(
        0,
      );
    }
  });
});
