/**
 * Issue #703 — as TRÊS JORNADAS DE NEGÓCIO que o arquivo vazio prometia.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * O que este arquivo é, e por que ele existe
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tests/e2e/smoke.spec.ts` viveu anos no repositório com `describe.skip`
 * HARDCODED e três corpos que eram comentários. O CI rodava `vitest run
 * tests/e2e` contra ele e saía 0 com `executados=0 falharam=0 pulados=3` — o
 * verde vazio que a #701 removeu e que esta issue existe para substituir por
 * conteúdo.
 *
 * Os três casos abaixo são os três nomes daquele arquivo, agora com asserção:
 *
 *   1. `register R$ 50 mercado returns confirmation`
 *   2. `register R$ 25k triggers dual approval workflow`
 *   3. `quarantined newcomer triggers owner confirmation`
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * O EIXO: jornada de negócio, não injeção de falha
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * O harness da #510 (`tests/reliability/`) pergunta "o que está ligado
 * sobrevive a um SIGKILL?". Estes três perguntam outra coisa: "uma mensagem
 * inbound percorre o pipeline INTEIRO e produz o efeito de negócio certo?".
 * São eixos diferentes e um não substitui o outro — por isso este arquivo NÃO
 * reusa o `TurnDriver`: ele injeta o ingresso e acompanha o TURNO até o estado
 * terminal, mas o que está sob prova aqui começa depois disso (identidade,
 * governança, dispatcher, outbound) e roda IN-PROCESS, onde o único dublê pago
 * — o LLM — é substituível.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * O que é REAL e o que é DUBLÊ (e o preço de cada dublê)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * REAL, sem exceção: `runAgentForMensagem` (o MESMO ponto de entrada que o
 * worker da BullMQ usa em `src/index.ts`), o resolvedor de identidade, a
 * quarentena, o pending-gate, o grafo cognitivo, o Decision Engine, o
 * ReAct loop, o `dispatchTool` inteiro (grant, permissão, regra
 * constitucional, avaliador financeiro, aprovação dupla, idempotência), o
 * handler de `register_transaction`, o commit transacional do outbox
 * (`outbound_messages`), a trilha de `audit_log` e o Postgres.
 *
 * DUBLÊ 1 — `callLLM` (`@/lib/claude.js`). É chamada paga a provedor externo:
 * nenhum CI a faz. É também o INSTRUMENTO: registra o `workload` de cada
 * chamada (revela quais reasoners foram alcançados) e recebe, na chamada
 * seguinte, o `tool_result` que a PRODUÇÃO montou.
 *
 *   O QUE ISTO CUSTA, dito explicitamente: o TEXTO da resposta ao usuário é
 *   autoria do modelo, não do backend. Afirmar que a saída contém a palavra
 *   "Lançado" seria afirmar sobre o roteiro deste arquivo, não sobre produção
 *   — o falso verde que a issue proíbe. O que estes casos afirmam é mais
 *   forte e é do backend: o roteiro ECOA de volta o identificador que a
 *   produção acabou de gerar (`transacao_id`, `AP-xxxxxxxx`), e a asserção é
 *   que ESSE identificador — desconhecido do roteiro antes da rodada — chegou
 *   à linha durável de `outbound_messages`. A cadeia inteira (tool executou →
 *   id nasceu → id voltou ao modelo → id saiu na resposta durável) é de
 *   produção; só a escolha de palavras é do dublê.
 *
 * DUBLÊ 2 — `forCurrentAgentChannel` (`@/gateway/line-output.js`), a fronteira
 * física de saída. Mesmo papel do `LineOutput` falso de
 * `tests/integration/outbound-auditoria-ciclo-real-db.spec.ts`.
 *
 *   POR QUE ELE, e não um `channels` semeado de verdade: `findPrimaryCatchAll
 *   Channel` (`src/db/repositories/channel-repos.ts:250`) trata a existência de
 *   QUALQUER canal ativo de tenant != `primary` como prova de deployment
 *   multi-tenant e desliga o catch-all single-tenant — para a rodada INTEIRA,
 *   não só para este arquivo. No CI o banco de integração é um só para todas as
 *   specs. Semear um canal ativo sob um tenant próprio quebraria suítes
 *   alheias; é o mesmo motivo já registrado em
 *   `tests/integration/turn-claim-core-barrier-real-db.spec.ts`.
 *   O preço: a validação de escopo do `LineOutput` real (triplete, canal ativo)
 *   não é exercida aqui. Ela já é coberta pelas suítes de #631/#632/#633.
 *
 * DUBLÊ 3 — `resolveChannel`, pelo mesmo motivo do dublê 2: sem canal semeado
 * não há o que resolver, e o roteamento não é o que estes casos medem.
 *
 * DUBLÊ 4 — `@/gateway/queue.js` e `@/gateway/baileys.js`: importar
 * `@/agent/core.js` abriria uma Queue da BullMQ e um socket do WhatsApp.
 * Precedente idêntico em `turn-claim-core-barrier-real-db.spec.ts`. O Redis
 * continua REAL (rate-limit e cache de identidade passam por ele).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ISOLAMENTO: tenant e agent PRÓPRIOS, semeados, nunca `default`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * O par (`e703-tenant`, `e703-agent`) é exclusivo desta suíte. Toda linha
 * semeada e toda linha inspecionada é escopada por ele — a contagem de
 * `audit_log`/`approval_requests` seria delta frágil sob `primary/primary`,
 * que roda em paralelo com dezenas de outras suítes no mesmo banco.
 * `entidades.id` é PK GLOBAL: nenhum UUID fixo aparece aqui, tudo é
 * `gen_random_uuid()` e é ligado por id devolvido.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CONTROLE em cada caso que prova uma RECUSA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Não executou" e "não respondeu" passariam também se o pipeline nunca
 * tivesse rodado — mensagem não encontrada, tenant errado, grant ausente,
 * import quebrado. Por isso os dois casos de recusa (aprovação dupla,
 * quarentena) carregam, no MESMO `it`, um controle que percorre o MESMO
 * caminho e EXIGE o efeito presente.
 *
 * Pulado sem `TEST_DB_URL` (ou com `DATABASE_URL` divergente) — e `pulado` NÃO
 * é `passou`. O piso de volume do CI (`scripts/check-vitest-summary.ts --min 3
 * --max-pulados 0`) transforma o skip desta lane em VERMELHO.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { LLMMessage, LLMResponse } from '@/lib/llm/types.js';

/**
 * `src/config/env.ts` congela o env no import, então as flags têm de estar de
 * pé ANTES de qualquer import — inclusive dos ESM içados. Mesmo motivo (e
 * mesmo remédio) de `turn-claim-core-barrier-real-db.spec.ts`.
 *
 * As duas são os DEFAULTS de produção (`src/config/contract.ts`); fixá-las aqui
 * impede que o env da máquina de quem roda mude a jornada sob teste.
 */
const envAnterior = vi.hoisted(() => {
  const prev = {
    FEATURE_TURN_STATE_MACHINE: process.env.FEATURE_TURN_STATE_MACHINE,
    FEATURE_TURN_CLAIM: process.env.FEATURE_TURN_CLAIM,
  };
  process.env.FEATURE_TURN_STATE_MACHINE = 'true';
  process.env.FEATURE_TURN_CLAIM = 'true';
  return prev;
});

const T = 'e703-tenant';
const A = 'e703-agent';

// ── DUBLÊ 4: a infraestrutura de transporte ────────────────────────────────
vi.mock('@/gateway/queue.js', () => ({
  agentQueue: { add: vi.fn(), getJob: vi.fn() },
  outboundDeliveryQueue: { add: vi.fn(), getJob: vi.fn() },
  startAgentWorker: vi.fn(),
  enqueueAgent: vi.fn(),
  shutdownQueue: vi.fn(),
}));
vi.mock('@/gateway/baileys.js', () => ({
  isBaileysConnected: () => true,
  getSocket: () => null,
  startBaileys: vi.fn(),
  shutdownBaileys: vi.fn(),
  triggerPairingCode: vi.fn(),
  isReactionStub: () => false,
  REACTION_STUB_TYPE: 67,
  MEDIA_ROOT: '/tmp/media',
  getLastDisconnectAt: () => null,
  sendOutboundText: vi.fn(async () => `wa-${randomUUID()}`),
  sendOutboundDocument: vi.fn(async () => null),
  sendOutboundVoice: vi.fn(async () => null),
}));

// ── DUBLÊ 3: o roteamento ──────────────────────────────────────────────────
vi.mock('@/gateway/channel-resolver.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveChannel: async () => ({ tenant_id: T, agent_id: A, channel_id: null }),
}));

/**
 * ── DUBLÊ 2: a fronteira física de saída ─────────────────────────────────
 *
 * Registra TUDO que produção mandou para a linha, com o JID de destino. É
 * assim que a jornada 3 observa as duas mensagens da quarentena (a de espera
 * para o desconhecido e a pergunta ao dono) — elas saem por
 * `sendViaLine`/`withDeclaredEgressException` e nunca passam pelo outbox.
 */
const linha = vi.hoisted(() => ({
  enviados: [] as Array<{ jid: string; texto: string }>,
}));
vi.mock('@/gateway/line-output.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    forCurrentAgentChannel: async () => ({
      scope: { tenant_id: T, agent_id: A, channel_id: 'e703-linha' },
      async sendText(jid: string, text: string) {
        linha.enviados.push({ jid, texto: text });
        return `wa-${randomUUID()}`;
      },
      sendDocument: async () => null,
      sendVoice: async () => null,
      sendPoll: async () => ({ ok: false as const, reason: 'unsupported' }),
      sendReaction: () => undefined,
      startTyping: () => ({ stop: () => undefined }),
      markRead: () => undefined,
      isConnected: () => true,
    }),
  };
});

/**
 * ── DUBLÊ 1: o LLM, que é também o INSTRUMENTO ───────────────────────────
 *
 * `reasoner` é o único workload roteirizado por caso; todos os outros
 * (procedure_selector, risk_classifier, …) recebem uma resposta neutra que os
 * deixa seguir sem alterar a jornada.
 *
 * `toolResults` guarda os textos que a PRODUÇÃO devolveu ao modelo — cada um é
 * `JSON.stringify(out)` do dispatcher, montado em `src/agent/react-loop.ts`.
 * É dele que os casos extraem o `transacao_id` e o `AP-xxxxxxxx` que depois
 * são exigidos na linha durável de saída.
 */
const llm = vi.hoisted(() => ({
  workloads: [] as string[],
  /** Roteiro do `reasoner`, consumido em ordem. */
  roteiro: [] as Array<(toolResults: string[]) => LLMResponse>,
  /** Todo `tool_result` que a produção devolveu, na ordem em que voltou. */
  toolResults: [] as string[],
}));

vi.mock('@/lib/claude.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/claude.js')>();
  const neutra = (content: string): LLMResponse => ({
    content,
    tool_uses: [],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'dublê-e703',
  });
  return {
    ...actual,
    callLLM: async (params: {
      workload?: string;
      messages?: LLMMessage[];
    }): Promise<LLMResponse> => {
      const workload = params.workload ?? 'sem_workload';
      llm.workloads.push(workload);
      if (workload !== 'reasoner') {
        // Confiança alta + JSON válido: o suficiente para selector e scorer
        // seguirem sem desviar a jornada.
        return neutra('{"matches": true, "confidence": 0.95, "reason": "ok"}');
      }
      // Colhe os `tool_result` que a produção acabou de anexar à conversa.
      for (const m of params.messages ?? []) {
        if (!Array.isArray(m.content)) continue;
        for (const bloco of m.content as Array<Record<string, unknown>>) {
          if (bloco['type'] === 'tool_result' && typeof bloco['content'] === 'string') {
            if (!llm.toolResults.includes(bloco['content'])) {
              llm.toolResults.push(bloco['content']);
            }
          }
        }
      }
      const proxima = llm.roteiro.shift();
      if (!proxima) {
        throw new Error(
          'o roteiro do reasoner acabou — a jornada chamou o LLM mais vezes do que o caso previu',
        );
      }
      return proxima(llm.toolResults);
    },
  };
});

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;
let owner_id: string;
let entidade_id: string;
let conta_id: string;

/**
 * O telefone do dono desta suíte é DELIBERADAMENTE o `OWNER_TELEFONE_WHATSAPP`
 * da configuração de teste (`tests/setup.ts`), porque duas peças de PRODUÇÃO o
 * exigem para existir:
 *
 *   - `findOwner()` (`src/identity/quarantine.ts:174`) procura o dono por essa
 *     variável. Sem uma pessoa nesse número DENTRO deste tenant, a jornada 3
 *     sai por `quarantine.no_owner` e não haveria confirmação a observar;
 *   - `src/agent/core.ts` só chama `captureInboundForOutreach` quando
 *     `pessoasRepo.findByPhone(OWNER_…)` encontra alguém.
 *
 * `findByPhone` é escopada por tenant (ALS), então o número não colide com as
 * outras suítes que rodam contra o mesmo Postgres.
 */
const TEL_DONO = '+5511111111111';
/** O desconhecido da jornada 3. Nunca semeado como `ativa`. */
const TEL_DESCONHECIDO = '+5511970300703';

function neutra(content: string): LLMResponse {
  return {
    content,
    tool_uses: [],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'dublê-e703',
  };
}

function propoeRegistro(args: Record<string, unknown>): LLMResponse {
  return {
    content: '',
    tool_uses: [{ id: `tu-${randomUUID()}`, tool: 'register_transaction', args }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 20, output_tokens: 10 },
    model: 'dublê-e703',
  };
}

/**
 * Insere o inbound SEM `conversa_id`: é o formato que o gateway persiste e é o
 * que faz `runAgentForMensagem` percorrer a resolução de identidade — o
 * caminho que a jornada 3 mede e que as jornadas 1 e 2 atravessam.
 */
async function inbound(telefone: string, conteudo: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1,$2,$3,NULL,'in','texto',$4, jsonb_build_object('telefone', $5::text), NULL)`,
    [id, T, A, conteudo, telefone],
  );
  return id;
}

/** Roda o turno pelo ponto de entrada de produção. */
async function rodarTurno(mensagem_id: string): Promise<void> {
  const { runAgentForMensagem } = await import('@/agent/core.js');
  await runAgentForMensagem(mensagem_id);
}

/** As linhas DURÁVEIS de saída desta pessoa, com o texto commitado. */
async function saidasDuraveis(in_reply_to: string): Promise<Array<{ texto: string; status: string }>> {
  const r = await pool.query<{ texto: string; status: string }>(
    `SELECT coalesce(payload_json->>'text','') AS texto, status
       FROM outbound_messages
      WHERE tenant_id=$1 AND agent_id=$2 AND in_reply_to=$3
      ORDER BY sequence_in_turn`,
    [T, A, in_reply_to],
  );
  return r.rows;
}

async function acoesAuditadas(mensagem_id: string): Promise<string[]> {
  const r = await pool.query<{ acao: string }>(
    `SELECT acao FROM audit_log WHERE tenant_id=$1 AND agent_id=$2 AND mensagem_id=$3 ORDER BY created_at`,
    [T, A, mensagem_id],
  );
  return r.rows.map((x) => x.acao);
}

/**
 * Faxina GENÉRICA por tenant — mesmo padrão de
 * `tests/integration/turn-lease-lost-turn-pipeline-real-db.spec.ts`: enumerar
 * tabelas à mão envelhece mal, cada migration nova pode acrescentar uma. Varre
 * toda tabela com coluna `tenant_id` e repete até as dependências caírem em
 * ordem; a última passada apaga agente e tenant.
 *
 * Chamada nos DOIS lados (antes de semear e depois de rodar) de propósito: se
 * uma rodada anterior morreu antes do `afterAll` — `SIGKILL` no runner, prazo
 * estourado, banco derrubado —, o resíduo dela faria a semeadura desta violar
 * a unique de `agent_tool_grants` e o arquivo reprovaria no `beforeAll`, sem
 * executar caso nenhum. Um piso `--min 3` transformaria isso em vermelho
 * correto mas ILEGÍVEL ("nada carregou"), longe da causa.
 */
async function limparTenant(): Promise<void> {
  const tabelas = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='tenant_id'`,
  );
  const alvos = tabelas.rows
    .map((r) => r.table_name)
    .filter((t) => t !== 'tenants' && t !== 'agents');
  for (let passada = 0; passada < 6; passada++) {
    let restou = false;
    for (const t of alvos) {
      try {
        await pool.query(`DELETE FROM "${t}" WHERE tenant_id = $1`, [T]);
      } catch {
        restou = true;
      }
    }
    if (!restou) break;
  }
  await pool.query(`DELETE FROM agents WHERE tenant_id = $1`, [T]).catch(() => {});
  await pool.query(`DELETE FROM tenants WHERE id = $1`, [T]).catch(() => {});
}

d('#703 — as três jornadas de backend, ponta a ponta', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await limparTenant();
    await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1,'e703') ON CONFLICT DO NOTHING`, [T]);
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,'e703 agent') ON CONFLICT DO NOTHING`,
      [A, T],
    );

    // O DONO.
    const p = await pool.query<{ id: string }>(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1,$2,'Dono e703',$3,'dono','ativa') RETURNING id`,
      [T, A, TEL_DONO],
    );
    owner_id = p.rows[0]!.id;
    await pool.query(
      `INSERT INTO agent_audience_profiles(tenant_id, agent_id, pessoa_id, audience_type, trust_level, status)
       VALUES ($1,$2,$3,'owner','trusted_internal','active')`,
      [T, A, owner_id],
    );

    // A ENTIDADE e a CONTA.
    const e = await pool.query<{ id: string }>(
      `INSERT INTO entidades(tenant_id, agent_id, nome, tipo) VALUES ($1,$2,'Casa e703','pf') RETURNING id`,
      [T, A],
    );
    entidade_id = e.rows[0]!.id;
    const c = await pool.query<{ id: string }>(
      `INSERT INTO contas_bancarias(tenant_id, agent_id, entidade_id, banco, apelido, tipo, saldo_atual)
       VALUES ($1,$2,$3,'BancoE703','corrente','cc',100000) RETURNING id`,
      [T, A, entidade_id],
    );
    conta_id = c.rows[0]!.id;

    // A PERMISSÃO.
    //
    // `limite_default` é NOT NULL e o DEFAULT da coluna é `0` — e zero
    // significa "limite individual zero", o que faria TODO valor cair em
    // `above_individual_limit` (`src/governance/financial-authorization.ts:231`)
    // ANTES do avaliador de threshold. A jornada 2 mediria a negação ERRADA e
    // passaria pelo motivo errado. `50000` é o mesmo valor do teto global
    // (`VALOR_LIMITE_DURO`, default do contrato), então o limite individual não
    // decide nada nestes casos e quem classifica é o threshold — que é o que
    // está sob prova.
    const profile_id = `e703-profile-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO permission_profiles(id, tenant_id, agent_id, nome, acoes, limite_default)
       VALUES ($1,$2,$3,'dono e703', ARRAY['*'], 50000)`,
      [profile_id, T, A],
    );
    await pool.query(
      `INSERT INTO permissoes(tenant_id, agent_id, pessoa_id, entidade_id, papel, acoes_permitidas, profile_id, status)
       VALUES ($1,$2,$3,$4,'dono', ARRAY['*'], $5, 'ativa')`,
      [T, A, owner_id, entidade_id, profile_id],
    );

    // O GRANT: `register_transaction` mora em `domain.finance`, que NÃO está
    // no piso (`BASE_AGENT_PACKS`). Sem esta linha o dispatcher recusa
    // `tool_not_granted` e as jornadas 1 e 2 mediriam a recusa de grant.
    await pool.query(
      `INSERT INTO agent_tool_grants(tenant_id, agent_id, granted_packs)
       VALUES ($1,$2, ARRAY['baseline.core','domain.calendar','domain.finance'])`,
      [T, A],
    );
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await limparTenant();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await pool.end();
  }, 60_000);

  beforeEach(() => {
    llm.workloads = [];
    llm.roteiro = [];
    llm.toolResults = [];
    linha.enviados = [];
  });

  it('jornada 1: "R$ 50 mercado" vira lançamento e a confirmação chega ao dono', async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    llm.roteiro = [
      () =>
        propoeRegistro({
          entidade_id,
          conta_id,
          natureza: 'despesa',
          valor: 50,
          data_competencia: hoje,
          status: 'paga',
          descricao: 'mercado (jornada 1)',
        }),
      (results) => neutra(`Lançado. ${results.join(' ')}`),
    ];

    const mensagem_id = await inbound(TEL_DONO, 'gastei 50 no mercado');
    await rodarTurno(mensagem_id);

    // O EFEITO DE NEGÓCIO: a transação existe, com o valor certo, na conta
    // certa, registrada pelo dono.
    const tx = await pool.query<{ id: string; valor: string; natureza: string }>(
      `SELECT id::text AS id, valor::text AS valor, natureza FROM transacoes
        WHERE tenant_id=$1 AND agent_id=$2 AND conta_id=$3 AND descricao='mercado (jornada 1)'`,
      [T, A, conta_id],
    );
    expect(tx.rowCount, 'o lançamento de R$ 50 tem de existir').toBe(1);
    expect(Number(tx.rows[0]!.valor)).toBe(50);
    expect(tx.rows[0]!.natureza).toBe('despesa');

    // A CONFIRMAÇÃO, e por que ela prova a cadeia inteira: `transacao_id` é
    // gerado pelo Postgres DENTRO do handler de produção, o roteiro só ecoa o
    // `tool_result` que a produção lhe devolveu, e a asserção exige esse id na
    // linha DURÁVEL de saída.
    const saidas = await saidasDuraveis(mensagem_id);
    expect(saidas.length, 'uma resposta durável tem de ter sido commitada').toBe(1);
    expect(saidas[0]!.texto).toContain(tx.rows[0]!.id);
    expect(linha.enviados.map((x) => x.texto).join('\n')).toContain(tx.rows[0]!.id);

    // A TRILHA.
    expect(await acoesAuditadas(mensagem_id)).toContain('transaction_created');
  }, 120_000);

  it('jornada 2: "R$ 25k" abre aprovação dupla e NÃO lança — com controle que lança', async () => {
    const hoje = new Date().toISOString().slice(0, 10);

    // ── A RECUSA ───────────────────────────────────────────────────────────
    // R$ 25.000 > `VALOR_DUAL_APPROVAL` (20.000, default do contrato) e
    // <= `VALOR_LIMITE_DURO` (50.000).
    //
    // ═══ O QUE ESTE CASO NÃO CONSEGUE DISTINGUIR, medido com sonda ═══════
    //
    // DUAS regras de produção INDEPENDENTES classificam este valor como dual,
    // e a primeira curto-circuita a segunda em `src/tools/_dispatcher.ts:524`:
    //
    //   1. o catálogo de operações críticas — `requiresDualApproval`
    //      (`src/governance/dual-approval.ts:11`: `register_transaction` com
    //      `valor > VALOR_DUAL_APPROVAL`);
    //   2. o avaliador financeiro — `evaluateFinancialAuthorization`
    //      (`src/governance/financial-authorization.ts:252`), que só é
    //      consultado quando (1) NÃO exigiu dual.
    //
    // Sonda rodada nesta entrega: rebaixar (2) de `require_dual_approval` para
    // `require_single_confirmation` deixou este caso VERDE, porque (1) já
    // tinha decidido. Ou seja: este caso prova que a exigência de aprovação
    // dupla EXISTE e é OBEDECIDA, mas não isola QUAL das duas regras a
    // produziu — uma regressão em só uma delas não aparece aqui. A sonda que
    // o deixa vermelho é a que quebra a CONSEQUÊNCIA (o `if
    // (approvalRequirement !== 'none')` do dispatcher), e é ela que está no
    // corpo da PR. Isolar as duas regras é trabalho de teste unitário de
    // governança, não desta jornada.
    llm.roteiro = [
      () =>
        propoeRegistro({
          entidade_id,
          conta_id,
          natureza: 'despesa',
          valor: 25000,
          data_competencia: hoje,
          status: 'pendente',
          descricao: 'reforma (jornada 2, acima do teto)',
        }),
      (results) => neutra(`Preciso de aprovação. ${results.join(' ')}`),
    ];
    const msgAlto = await inbound(TEL_DONO, 'paga 25 mil da reforma');
    await rodarTurno(msgAlto);

    // O WORKFLOW abriu, com a classe que o backend decidiu (o requisitante é
    // `dono`, então `dualClassFor` devolve `requester_plus_one_owner`).
    const req = await pool.query<{
      id: string;
      status: string;
      approval_class: string;
      required_approvals: number;
      tool: string;
    }>(
      `SELECT id::text AS id, status, approval_class, required_approvals::int AS required_approvals, tool
         FROM approval_requests WHERE tenant_id=$1 AND agent_id=$2`,
      [T, A],
    );
    expect(req.rowCount, 'a aprovação dupla tem de ter aberto exatamente um request').toBe(1);
    expect(req.rows[0]!.tool).toBe('register_transaction');
    expect(req.rows[0]!.status).toBe('pending');
    expect(req.rows[0]!.approval_class).toBe('requester_plus_one_owner');
    expect(req.rows[0]!.required_approvals).toBe(2);

    // E o LANÇAMENTO NÃO aconteceu — é isto que "aprovação dupla" significa.
    const naoLancado = await pool.query(
      `SELECT 1 FROM transacoes WHERE tenant_id=$1 AND agent_id=$2 AND descricao LIKE 'reforma (jornada 2%'`,
      [T, A],
    );
    expect(naoLancado.rowCount, 'nada pode ter sido lançado sem a segunda assinatura').toBe(0);

    // A RESPOSTA AO USUÁRIO reflete o pedido: o `AP-xxxxxxxx` que chega à linha
    // durável é derivado do `approval_requests.id` que a produção acabou de
    // criar — o roteiro não podia conhecê-lo antes da rodada.
    const ref = `AP-${req.rows[0]!.id.slice(0, 8)}`;
    const saidasAlto = await saidasDuraveis(msgAlto);
    expect(saidasAlto.length, 'a recusa também tem de virar resposta durável').toBe(1);
    expect(saidasAlto[0]!.texto).toContain(ref);

    expect(await acoesAuditadas(msgAlto)).toContain('approval_requested');

    // ── O CONTROLE, no MESMO caso ──────────────────────────────────────────
    // Sem ele, "nada foi lançado" passaria também se o pipeline nunca tivesse
    // chegado ao dispatcher (grant ausente, mensagem não encontrada, tenant
    // errado). O controle percorre o MESMO caminho, com a MESMA tool e a MESMA
    // pessoa, mudando SÓ o valor — e exige o lançamento presente.
    llm.roteiro = [
      () =>
        propoeRegistro({
          entidade_id,
          conta_id,
          natureza: 'despesa',
          valor: 50,
          data_competencia: hoje,
          status: 'paga',
          descricao: 'controle (jornada 2, abaixo do teto)',
        }),
      (results) => neutra(`Lançado. ${results.join(' ')}`),
    ];
    const msgBaixo = await inbound(TEL_DONO, 'gastei 50 na padaria');
    await rodarTurno(msgBaixo);

    const lancado = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM transacoes
        WHERE tenant_id=$1 AND agent_id=$2 AND descricao='controle (jornada 2, abaixo do teto)'`,
      [T, A],
    );
    expect(lancado.rowCount, 'CONTROLE: abaixo do teto o MESMO caminho tem de lançar').toBe(1);
    const aindaUm = await pool.query(
      `SELECT 1 FROM approval_requests WHERE tenant_id=$1 AND agent_id=$2`,
      [T, A],
    );
    expect(aindaUm.rowCount, 'CONTROLE: abaixo do teto nenhum request novo pode abrir').toBe(1);
    const saidasBaixo = await saidasDuraveis(msgBaixo);
    expect(saidasBaixo[0]!.texto).toContain(lancado.rows[0]!.id);
  }, 180_000);

  it('jornada 3: desconhecido em quarentena dispara confirmação ao dono — com controle atendido', async () => {
    // ── A RECUSA ───────────────────────────────────────────────────────────
    const nc = await pool.query<{ id: string }>(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1,$2,'Desconhecida e703',$3,'funcionario','quarentena') RETURNING id`,
      [T, A, TEL_DESCONHECIDO],
    );
    const desconhecido_id = nc.rows[0]!.id;

    const msgDesconhecido = await inbound(TEL_DESCONHECIDO, 'oi, tudo bem?');
    await rodarTurno(msgDesconhecido);

    // O DONO foi consultado. Os dois textos abaixo são de PRODUÇÃO
    // (`src/identity/quarantine.ts`), não do roteiro — a quarentena roda antes
    // de qualquer LLM.
    const paraDono = linha.enviados.filter((x) => x.jid.startsWith(TEL_DONO.replace('+', '')));
    const paraDesconhecido = linha.enviados.filter((x) =>
      x.jid.startsWith(TEL_DESCONHECIDO.replace('+', '')),
    );
    expect(paraDono.length, 'o dono tem de receber exatamente uma pergunta').toBe(1);
    expect(paraDono[0]!.texto).toContain('mandou primeira mensagem');
    expect(paraDono[0]!.texto).toContain('Desconhecida e703');
    expect(paraDesconhecido.length, 'o desconhecido tem de receber a mensagem de espera').toBe(1);
    expect(paraDesconhecido[0]!.texto).toContain('preciso confirmar com Test Owner');

    // A PENDÊNCIA durável, ligada ao DONO e apontando para o desconhecido — é
    // ela que a resposta "sim"/"bloqueia" do dono vai resolver depois.
    const pq = await pool.query<{ tipo: string; pessoa_id: string; alvo: string | null }>(
      `SELECT tipo, pessoa_id::text AS pessoa_id, acao_proposta->>'target_pessoa_id' AS alvo
         FROM pending_questions
        WHERE tenant_id=$1 AND agent_id=$2 AND status='aberta'`,
      [T, A],
    );
    expect(pq.rowCount, 'uma confirmação de identidade tem de ficar aberta').toBe(1);
    expect(pq.rows[0]!.tipo).toBe('identity_confirmation');
    expect(pq.rows[0]!.pessoa_id).toBe(owner_id);
    expect(pq.rows[0]!.alvo).toBe(desconhecido_id);

    expect(await acoesAuditadas(msgDesconhecido)).toContain('first_contact_received');

    // O desconhecido NUNCA chegou ao agente: nenhum reasoner rodou e nenhuma
    // resposta durável nasceu para ele.
    expect(llm.workloads, 'a quarentena roda ANTES de qualquer chamada de LLM').toEqual([]);
    expect((await saidasDuraveis(msgDesconhecido)).length).toBe(0);

    // ── O CONTROLE, no MESMO caso ──────────────────────────────────────────
    // "Ninguém foi atendido" passaria também se o pipeline estivesse quebrado
    // para TODO mundo. O controle manda uma mensagem de uma pessoa ATIVA, com
    // perfil de audiência ativo, pela MESMA linha e no MESMO turno de teste — e
    // exige que ela SEJA atendida.
    llm.roteiro = [() => neutra('claro, tudo certo por aqui.')];
    const msgAtiva = await inbound(TEL_DONO, 'me dá um oi');
    await rodarTurno(msgAtiva);

    expect(
      llm.workloads,
      'CONTROLE: a pessoa ativa tem de alcançar o reasoner do ReAct',
    ).toContain('reasoner');
    const saidasAtiva = await saidasDuraveis(msgAtiva);
    expect(saidasAtiva.length, 'CONTROLE: a pessoa ativa tem de receber resposta durável').toBe(1);
    expect(saidasAtiva[0]!.texto).toContain('claro, tudo certo por aqui.');
  }, 180_000);
});
