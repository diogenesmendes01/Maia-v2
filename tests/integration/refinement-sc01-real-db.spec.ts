/**
 * SC01 — EXTRAÇÃO DO `MaiaEngine` NO SEAM PÓS-GATES, com core/loop/coordenador
 * REAIS.
 *
 * Spec: `/pilot/SPEC.md` §5.2 (seam principal), §5.4.2 (desfechos), §5.9.2
 * (coordenador), §5.10.3 (plano de validação — linhas "Paridade local",
 * "Fronteira reasoner" e "Histórico/pós-turno").
 *
 * ─── O que este arquivo prova, e o que ele NÃO substitui ────────────────────
 *
 * Ele exercita o caminho de PRODUÇÃO inteiro do turno local: `runReActLoop`
 * (máscara) → `runReasonerStage` (seam) → `AgentEnginePortV1` com o
 * `runReasoning` real → gateway de ferramentas da Maia → `EngineResultAssembler`
 * → `MaiaOutputCoordinator` → fachada de saída. Dois dublês, nos dois lugares
 * que a spec permite (`doubles só nos providers/canal`):
 *
 *   - `callLLM` — provedor pago, e o ÚNICO ponto em que se escolhe a resposta do
 *     modelo por caso;
 *   - `forCurrentAgentChannel` — o canal (WhatsApp) não existe neste sandbox.
 *     O duplê REGISTRA o que sairia e obedece ao fence de egresso REAL
 *     (`assertEgressAuthorized`), como em
 *     `tests/integration/hermes-core-admission-real-db.spec.ts`.
 *
 * Real: Postgres (fixtures próprias), o motor (`createMaiaEngine`), o
 * raciocínio, o dispatcher de ferramentas, o `REGISTRY`, a governança
 * (`audit`), o assembler, o coordenador, a máquina de estados do turno e o
 * `decideTurnAction`. O pulo do gato é justamente este: o laço NÃO é dublado —
 * é ele que está sob prova.
 *
 * Skipped sem `TEST_DB_URL` (não reporte "0 falhas" de uma rodada sem banco:
 * aqui as specs vão para `skipped`).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type { Pessoa, Conversa, Mensagem, PermissionProfile, Permissao } from '@/db/schema.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import { decideTurnAction } from '@/agent/turn-outcome.js';
import type { LLMResponse } from '@/lib/llm/types.js';
import type { ReActDelivery, ReActExitReason } from '@/agent/react-types.js';

// ─── Ambiente: as flags valem ANTES do import de `config/env.ts` ────────────

vi.hoisted(() => {
  for (const [k, v] of Object.entries({
    FEATURE_TURN_STATE_MACHINE: 'true',
    FEATURE_TURN_CLAIM: 'true',
    // O gate de pendência é um dos gates NOMEADOS do AC02: sem ele ligado o
    // bloco do caminho de produção não exercita a fronteira.
    FEATURE_PENDING_GATE: 'true',
    // A entrega inline é o caminho que o coordenador reusa (§5.9.2.3); a
    // deduplicação durável e a voz têm suites próprias e desviariam o foco.
    FEATURE_OUTBOUND_DEDUP: 'false',
    FEATURE_OUTBOUND_VOICE: 'false',
  })) {
    process.env[k] = v;
  }
});

// ─── Infra externa: fila e Redis não existem aqui ───────────────────────────

vi.mock('@/gateway/queue.js', () => ({
  agentQueue: { add: vi.fn(), getJob: vi.fn() },
  startAgentWorker: vi.fn(),
  enqueueAgent: vi.fn(),
  shutdownQueue: vi.fn(),
}));
vi.mock('@/lib/redis.js', () => ({
  redis: {},
  isRedisConnected: () => false,
  ensureRedisConnect: vi.fn(),
  isRedisOomError: () => false,
  recordRedisOomDegraded: () => {},
}));
vi.mock('@/gateway/baileys.js', () => ({
  isBaileysConnected: () => false,
  getSocket: () => null,
  startBaileys: vi.fn(),
  shutdownBaileys: vi.fn(),
  triggerPairingCode: vi.fn(),
  isReactionStub: () => false,
  REACTION_STUB_TYPE: 67,
  MEDIA_ROOT: '/tmp/media',
  getLastDisconnectAt: () => null,
}));

/** O CANAL. Registra o que sairia; o fence de egresso é o REAL. */
const canal = vi.hoisted(() => ({ enviados: [] as string[] }));
vi.mock('@/gateway/line-output.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  forCurrentAgentChannel: async (channel_id: string) => {
    const { getCurrentTenant, getCurrentAgent } = await import('@/db/tenant-context.js');
    return {
      scope: { tenant_id: getCurrentTenant(), agent_id: getCurrentAgent(), channel_id },
      sendText: async (_jid: string, text: string) => {
        const { assertEgressAuthorized } = await import('@/runtime/outbound/egress-guard.js');
        assertEgressAuthorized();
        canal.enviados.push(text);
        // Id ÚNICO por envio: um literal fixo (`FAKE-1`) colide com o que já
        // foi persistido numa rodada anterior e a persistência do outbound
        // falha — o que apareceria como `sent_no_persist` (`persistUnknown`),
        // um artefato do dublê, não do desenho.
        return `FAKE-${randomUUID()}`;
      },
      isConnected: () => true,
      sendDocument: async () => {
        throw new Error('FAKE: no documents');
      },
      sendVoice: async () => {
        throw new Error('FAKE: no voice');
      },
      sendPoll: async () => {
        throw new Error('FAKE: no polls');
      },
    };
  },
}));

/**
 * O PROVEDOR. Roteiro por `workload`, porque o turno tem mais de um reasoner
 * (o gate de pendência também chama LLM) — e é a série de workloads que prova
 * ONDE o turno parou.
 */
const llm = vi.hoisted(() => ({
  workloads: [] as string[],
  /** `texto` → resposta final do reasoner; `falha` → o provedor falha. */
  roteiro: { texto: 'ok', modo: 'texto' as 'texto' | 'falha' | 'tool_loop' },
  /**
   * Roteiro POR `workload` (bloco do caminho de produção). Quando há uma
   * entrada para o workload da chamada, ELA vence o `roteiro` acima — é assim
   * que o pending-gate (que classifica via `callLLM`), o classificador de
   * intenção e o reasoner recebem respostas DIFERENTES no mesmo turno sem que
   * nenhum deles seja substituído.
   */
  porWorkload: {} as Record<string, { content: string | null }>,
}));

vi.mock('@/lib/claude.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/claude.js')>();
  return {
    ...actual,
    callLLM: async (params: { workload?: string }): Promise<LLMResponse> => {
      const workload = params.workload ?? 'sem_workload';
      llm.workloads.push(workload);
      if (llm.roteiro.modo === 'falha') throw new Error('provider indisponível (dublê)');
      const roteirizado = llm.porWorkload[workload];
      if (roteirizado) {
        return {
          content: roteirizado.content,
          tool_uses: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
          model: 'dublê',
        } satisfies LLMResponse;
      }
      if (llm.roteiro.modo === 'tool_loop') {
        return {
          content: null,
          tool_uses: [
            { id: `tu-${llm.workloads.length}`, tool: 'remember_safe_fact', args: { chave: 'sc01', valor: 'x' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
          model: 'dublê',
        } satisfies LLMResponse;
      }
      return {
        content: llm.roteiro.texto,
        tool_uses: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'dublê',
      } satisfies LLMResponse;
    },
  };
});

// ─── Fixtures em Postgres real ─────────────────────────────────────────────

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'primary';
const A = 'primary';

let pool: pg.Pool;
let pessoa: Pessoa;
let conversa: Conversa;
let entidade_id: string;
let resolvedPermission: ResolvedPermission;
const criadas: string[] = [];

const inT = <R>(fn: () => Promise<R>): Promise<R> =>
  runWithTenantContext({ tenant_id: T, agent_id: A }, fn);

async function mkInbound(over: Partial<Mensagem> = {}): Promise<Mensagem> {
  const r = await pool.query(
    `INSERT INTO mensagens (tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
     VALUES ($1,$2,$3,'in','texto','oi','{}'::jsonb) RETURNING *`,
    [T, A, conversa.id],
  );
  const row = r.rows[0] as Mensagem;
  criadas.push(row.id);
  return { ...row, ...over };
}

/** As linhas do flush (§5.9.2.8) — a única trilha do turno sem outbound. */
async function flushRows(mensagem_id: string): Promise<
  Array<{ metadata: Record<string, unknown>; ferramentas_chamadas: unknown[] }>
> {
  const r = await pool.query(
    `SELECT metadata, ferramentas_chamadas FROM mensagens
      WHERE tenant_id=$1 AND agent_id=$2 AND direcao='out' AND tipo='evento'
        AND metadata->>'in_reply_to'=$3 ORDER BY created_at`,
    [T, A, mensagem_id],
  );
  return r.rows as Array<{ metadata: Record<string, unknown>; ferramentas_chamadas: unknown[] }>;
}

/**
 * Outbounds TEXTO desta conversa — o que o usuário teria recebido.
 *
 * O POOL vem por PARÂMETRO. O `pool` do bloco anterior é encerrado no
 * `afterAll` dele (`pool.end()`), e o bloco do caminho de produção roda depois,
 * com o seu próprio `pool2`: usar aqui o pool de módulo estourava com
 * `Cannot use a pool after calling end on the pool` — ruído de harness que
 * escondia a asserção de verdade (a testemunha de `enviados` já passava).
 */
async function outboundsTexto(cliente: pg.Pool, conversa_id: string): Promise<number> {
  const r = await cliente.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM mensagens
      WHERE conversa_id=$1 AND direcao='out' AND conteudo <> ''`,
    [conversa_id],
  );
  return r.rows[0]!.n;
}

/** O contador do `start` do motor local (SC01 — a testemunha da fronteira). */
async function engineStarts(): Promise<number> {
  const { renderPrometheus } = await import('@/lib/metrics.js');
  const texto = await renderPrometheus();
  const linha = texto
    .split('\n')
    .find((l) => l.startsWith('maia_engine_start_total') && l.includes('engine="maia_react"'));
  return linha ? Number(linha.trim().split(/\s+/).pop()) : 0;
}

async function rodar(mensagem: Mensagem, outboundPrefix: string | null = null) {
  const { runReActLoop } = await import('@/agent/react-loop.js');
  return runReActLoop({
    pessoa,
    conversa,
    inbound: mensagem,
    scope: {
      entidades: [entidade_id],
      byEntity: new Map<string, ResolvedPermission>([[entidade_id, resolvedPermission]]),
    },
    jid: '5511000000000@s.whatsapp.net',
    system: 'sistema de teste SC01',
    messages: [{ role: 'user', content: 'oi' }],
    tools: [],
    outboundPrefix,
  });
}

d('SC01 — Extração do MaiaEngine no seam real pós-gates', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const p = await pool.query(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1,$2,'sc01',$3,'dono','ativa') RETURNING *`,
      [T, A, `+5511${Math.floor(Math.random() * 1e9)}`],
    );
    pessoa = p.rows[0] as Pessoa;
    const conv = await pool.query(
      `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, escopo_entidades)
       VALUES ($1,$2,$3,'{}') RETURNING *`,
      [T, A, pessoa.id],
    );
    conversa = conv.rows[0] as Conversa;
    const ent = await pool.query<{ id: string }>(
      `INSERT INTO entidades(tenant_id, agent_id, nome, tipo, status)
       VALUES ($1,$2,'PF-sc01','pf','ativa') RETURNING id`,
      [T, A],
    );
    entidade_id = ent.rows[0]!.id;
    const prof = await pool.query(
      `INSERT INTO permission_profiles(tenant_id, agent_id, id, nome, acoes, limite_default)
       VALUES ($1,$2,$3,'sc01 owner', ARRAY['*']::text[], 100000) RETURNING *`,
      [T, A, `prof-sc01-${randomUUID().slice(0, 8)}`],
    );
    const perm = await pool.query(
      `INSERT INTO permissoes(tenant_id, agent_id, pessoa_id, entidade_id, papel, profile_id, status)
       VALUES ($1,$2,$3,$4,'dono',$5,'ativa') RETURNING *`,
      [T, A, pessoa.id, entidade_id, (prof.rows[0] as PermissionProfile).id],
    );
    resolvedPermission = {
      permissao: perm.rows[0] as Permissao,
      profile: prof.rows[0] as PermissionProfile,
      effective_limits: { valor_max: 100000 },
    };
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    // Best-effort: as fixtures são descartáveis, mas `audit_log` referencia
    // `mensagens`/`conversas` e um DELETE em cascata por aqui só produziria
    // ruído de FK. O que importa é não deixar conexão aberta.
    try {
      await pool.query(`DELETE FROM mensagens WHERE conversa_id = $1 AND direcao='in'`, [
        conversa?.id ?? null,
      ]);
    } catch {
      /* FK de auditoria — irrelevante para o resultado da suíte */
    }
    await pool.end().catch(() => {});
  });

  /**
   * T01 · SC01-AC01 · SC01-AC04 · SC01-AC07 — o caminho comum.
   *
   * CONGELA quatro coisas de uma vez, e cada uma tem contraprova no zero da
   * outra: (a) o core/laço chega ao MOTOR (o contador de `start` sobe e o
   * raciocínio de verdade chama o provedor como `reasoner`); (b) UM reply
   * produz UM outbound — nem zero, nem dois; (c) o desfecho deliberativo
   * (`no_reply/empty_final_text`) atravessa assembler e coordenador sem virar
   * `reasoner_failed`; (d) nada de sumário de ferramenta é flushado quando NÃO
   * houve ferramenta.
   */
  it('T01/AC01/AC04/AC07 — um reply produz exatamente um outbound, e o motor local foi acionado', async () => {
    llm.roteiro = { texto: 'resposta de teste', modo: 'texto' };
    const inbound = await mkInbound();
    llm.workloads.length = 0;

    const antes = await engineStarts();
    const r = await inT(() => rodar(inbound));
    const depois = await engineStarts();

    expect(depois - antes, 'o seam tem de acionar a PORTA do motor').toBe(1);
    expect(llm.workloads.filter((w) => w === 'reasoner')).toHaveLength(1);
    expect(r.delivery).toEqual({
      dispatched: true,
      exitReason: 'empty_final_text',
      persistUnknown: false,
      sideEffectsCommitted: false,
    });
    expect(canal.enviados).toEqual(['resposta de teste']);
    expect(r.outboundText).toBe('resposta de teste');
    expect(r.toolsCalled).toEqual([]);
    expect(r.totalTokens).toBe(15);
    expect(await outboundsTexto(pool, conversa.id)).toBe(1);
    expect(await flushRows(inbound.id)).toHaveLength(0);
  });

  /** SC01-AC07 — o prefixo de role: `prefixo\n\ntexto`, uma vez só. */
  it('AC07 — prefixo de role entra no texto final e é o MESMO `outboundText` devolvido', async () => {
    llm.roteiro = { texto: 'conteúdo', modo: 'texto' };
    const inbound = await mkInbound();
    const antes = canal.enviados.length;

    const r = await inT(() => rodar(inbound, 'Assumindo o papel de suporte'));

    expect(canal.enviados.slice(antes)).toEqual(['Assumindo o papel de suporte\n\nconteúdo']);
    expect(r.outboundText).toBe('Assumindo o papel de suporte\n\nconteúdo');
    expect(r.delivery.dispatched).toBe(true);
  });

  /**
   * T03 · SC01-AC08 (metade "retry") — o reasoner morre.
   *
   * Nenhum envio, e o desfecho é RETRY: nada foi produzido e nenhum efeito
   * irreversível foi invocado. É a mesma regra do §5.4.1, agora atravessando a
   * porta e o assembler em vez de nascer dentro do laço.
   */
  it('T03 — reasoner falha: zero envio e desfecho retryável (sem efeito)', async () => {
    llm.roteiro = { texto: '', modo: 'falha' };
    const inbound = await mkInbound();
    const antesEnviados = canal.enviados.length;

    const r = await inT(() => rodar(inbound));

    expect(canal.enviados.slice(antesEnviados)).toEqual([]);
    expect(r.delivery.dispatched).toBe(false);
    expect(r.delivery.exitReason).toBe('reasoner_failed');
    expect(decideTurnAction(r.delivery)).toEqual({ kind: 'retry', code: 'reasoner_failed' });
    expect(await flushRows(inbound.id)).toHaveLength(0);
  });

  /**
   * SC01-AC05 · SC01-AC07 — teto de iterações com ferramentas executadas.
   *
   * Nada é enviado (o modelo nunca produziu texto final) e o rastro das
   * ferramentas tem de SOBREVIVER como linha de evento — é o anchor
   * anti-anchoring do turno SEGUINTE (§5.9.2.8). Os cinco sumários são a
   * prova de que o teto local continua 5 (§5.1.1).
   */
  it('AC05/AC07 — iteration_cap: zero envio, cinco sumários e UMA linha de evento', async () => {
    llm.roteiro = { texto: '', modo: 'tool_loop' };
    const inbound = await mkInbound();
    const antesEnviados = canal.enviados.length;
    llm.workloads.length = 0;

    const r = await inT(() => rodar(inbound));

    expect(canal.enviados.slice(antesEnviados)).toEqual([]);
    expect(r.delivery.exitReason).toBe('iteration_cap');
    expect(r.delivery.dispatched).toBe(false);
    expect(llm.workloads.filter((w) => w === 'reasoner')).toHaveLength(5);

    const rows = await flushRows(inbound.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata['flush_reason']).toBe('iteration_cap');
    expect(rows[0]!.ferramentas_chamadas).toHaveLength(5);
  });

  /**
   * SC01-AC02 · T02 (metade "barrado antes do seam") — um turno que morre num
   * gate determinístico NÃO aciona o motor.
   *
   * A conversa não tem canal resolvido, e `resolveRoleInputs` (core.ts:1254)
   * encerra o turno como `blocked_by_policy` ANTES da linha do seam. O par de
   * asserções é o que dá sentido ao zero: o turno FOI barrado de verdade (o
   * estado terminal existe) e o reasoner NUNCA foi chamado (nenhum workload
   * `reasoner`, contador de `start` parado, nenhum envio).
   *
   * Os gates nomeados de aprovação/pendência ficam no MESMO lado da fronteira —
   * `checkPendingFirst` está em `core.ts:1414` e o seam em `core.ts:2185` — e a
   * barreira de posse deles tem suíte própria
   * (`tests/integration/turn-lease-lost-turn-pipeline-real-db.spec.ts`), que
   * roda no mesmo comando de regressão.
   */
  it('T02/AC02 — turno barrado por política antes do seam: motor com start=0', async () => {
    const { runAgentForMensagem } = await import('@/agent/core.js');
    const inbound = await mkInbound();
    llm.workloads.length = 0;
    const antesStarts = await engineStarts();
    const antesEnviados = canal.enviados.length;

    await inT(() => runAgentForMensagem(inbound.id));

    expect(await engineStarts() - antesStarts, 'o motor não pode ser acionado').toBe(0);
    expect(llm.workloads.filter((w) => w === 'reasoner')).toEqual([]);
    expect(canal.enviados.slice(antesEnviados)).toEqual([]);

    const turno = await pool.query<{ status: string; outcome: string | null }>(
      `SELECT status, outcome FROM agent_turns WHERE representative_message_id = $1`,
      [inbound.id],
    );
    /**
     * O desfecho observável é "o turno MORREU num gate, antes do seam", e não
     * qual gate — a conversa desta fixture não tem canal, e a cadeia
     * (quarentena de primeiro contato, política de canal, bloqueio de
     * identidade) resolve em pontos diferentes conforme o estado do banco. O
     * que não pode variar é o par: turno TERMINAL (não abandonado em
     * `claimed`/`running`, não `retryable`) e NENHUM acionamento do motor.
     */
    const { isTerminalTurnStatus } = await import('@/runtime/turns/index.js');
    expect(
      isTerminalTurnStatus(turno.rows[0]?.status as never),
      `o turno tem de terminar num gate, não ser abandonado (status=${turno.rows[0]?.status})`,
    ).toBe(true);
    expect([
      'identity_unknown',
      'identity_blocked',
      'quarantined',
      'blocked_by_policy',
      'pending_action_resolved',
      'pending_race_lost',
    ]).toContain(turno.rows[0]?.outcome);
  }, 60_000);
});

/**
 * SC01-AC03 · SC01-AC08 — a MATRIZ de `decideTurnAction`.
 *
 * Pura, sem banco: cobre os quatro motivos de saída e os booleanos, inclusive
 * as combinações que o fluxo normal não produz (`dispatched=false` com
 * `persistUnknown=true`, teto de iterações com efeito irreversível, perda de
 * posse). O harness é o do §5.4.1 — e o valor dele é a CONTRAPROVA: cada linha
 * tem uma vizinha que exige desfecho diferente.
 */
describe('SC01-AC03/AC08 — matriz de desfechos', () => {
  const base: ReActDelivery = {
    dispatched: false,
    exitReason: 'empty_final_text',
    persistUnknown: false,
    sideEffectsCommitted: false,
  };
  const linha = (
    dispatched: boolean,
    persistUnknown: boolean,
    exitReason: ReActExitReason,
    sideEffectsCommitted: boolean,
  ): ReActDelivery => ({ dispatched, persistUnknown, exitReason, sideEffectsCommitted });

  const MOTIVOS: ReActExitReason[] = [
    'empty_final_text',
    'iteration_cap',
    'reasoner_failed',
    'outbound_failure',
  ];
  const BOOL = [false, true];

  it('dispatched=true conclui com reply_delivered / reply_delivery_unknown, e ignora o motivo', () => {
    for (const exitReason of MOTIVOS) {
      for (const sideEffectsCommitted of BOOL) {
        expect(decideTurnAction(linha(true, false, exitReason, sideEffectsCommitted))).toEqual({
          kind: 'complete',
          outcome: 'reply_delivered',
        });
        expect(decideTurnAction(linha(true, true, exitReason, sideEffectsCommitted))).toEqual({
          kind: 'complete',
          outcome: 'reply_delivery_unknown',
        });
      }
    }
  });

  it('COMBINAÇÃO INCOMUM — dispatched=false com persistUnknown=true segue a regra do MOTIVO', () => {
    // O flag só importa quando algo chegou ao usuário (§5.4.1). Aqui ele não
    // pode promover nem reter o turno.
    expect(decideTurnAction(linha(false, true, 'empty_final_text', false))).toEqual({
      kind: 'complete',
      outcome: 'no_reply_produced',
    });
    expect(decideTurnAction(linha(false, true, 'iteration_cap', true))).toEqual({
      kind: 'complete',
      outcome: 'no_reply_produced',
    });
  });

  it('motivos retryáveis só voltam à fila SEM efeito irreversível', () => {
    for (const exitReason of ['reasoner_failed', 'outbound_failure'] as const) {
      expect(decideTurnAction(linha(false, false, exitReason, false))).toEqual({
        kind: 'retry',
        code: exitReason,
      });
      expect(decideTurnAction(linha(false, false, exitReason, true))).toEqual({
        kind: 'dead_letter',
        code: exitReason,
        outcome: 'unsafe_to_retry',
      });
    }
  });

  it('empty_final_text e iteration_cap NUNCA retentam, com efeito ou sem', () => {
    for (const exitReason of ['empty_final_text', 'iteration_cap'] as const) {
      for (const sideEffectsCommitted of BOOL) {
        expect(decideTurnAction(linha(false, false, exitReason, sideEffectsCommitted))).toEqual({
          kind: 'complete',
          outcome: 'no_reply_produced',
        });
      }
    }
  });

  it('PRECEDÊNCIA NOVA — divergência de alegação e egresso revogado viram dead_letter', () => {
    // §5.4.2 itens 3 e 8: um motor que alega chamada sem receipt, e uma
    // resposta retida por revogação, exigem gente — nos dois casos o motivo
    // vence o "parece só um turno vazio".
    expect(decideTurnAction(linha(false, false, 'claim_divergence_blocked', false))).toEqual({
      kind: 'dead_letter',
      code: 'claim_divergence_blocked',
      outcome: 'unsafe_to_retry',
    });
    expect(decideTurnAction(linha(false, false, 'egress_revoked', true))).toEqual({
      kind: 'dead_letter',
      code: 'egress_revoked',
      outcome: 'unsafe_to_retry',
    });
  });

  it('tomada humana NÃO retenta nem vai para dead letter', () => {
    expect(decideTurnAction(linha(false, false, 'human_control_blocked', false))).toEqual({
      kind: 'complete',
      outcome: 'no_reply_produced',
    });
  });

  it('o objeto base do harness é o caso trivial documentado', () => {
    expect(decideTurnAction(base)).toEqual({ kind: 'complete', outcome: 'no_reply_produced' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SC01 — O ENTRY POINT DE PRODUÇÃO (`runAgentForMensagem`) E A FRONTEIRA
// ═════════════════════════════════════════════════════════════════════════════
/**
 * ─── Por que este bloco existe, separado do de cima ─────────────────────────
 *
 * O bloco anterior mede o SEAM pela máscara (`runReActLoop`) e prova o NEGATIVO
 * do T02 (turno barrado antes do seam ⇒ `engine.start=0`). Faltava o POSITIVO
 * pelo caminho que o worker da BullMQ usa de verdade: `runAgentForMensagem` →
 * pipeline inteiro (canal, identidade, audiência, grafo pré-turno, Decision
 * Engine always-on, gates determinísticos) → seam → coordenador → outbound.
 *
 * E faltavam os gates NOMEADOS do AC02 — pendência, aprovação, bloqueio,
 * escalação e skill — terminando cada um com o contador do motor em ZERO. O
 * que o bloco anterior provava era "algum gate do topo barra o turno"; aqui
 * cada gate tem o SEU fixture e a SUA testemunha.
 *
 * ─── Dublês: os dois que a spec permite, e só eles ──────────────────────────
 *
 *   - `callLLM` — o PROVEDOR (pago, externo). É por ele que o pending-gate
 *     classifica e por ele que o reasoner responde; o roteiro é por `workload`,
 *     então cada consumidor recebe a resposta DELE sem que nenhum seja
 *     substituído.
 *   - `forCurrentAgentChannel` — o CANAL (WhatsApp não existe no sandbox).
 *
 * REAL: resolver de canal, identidade, audiência, `agent_audience_profiles`,
 * `channel_policies`, role-selector, grafo pré-turno, Decision Engine (com os
 * PEPs lendo `policy_rules` de verdade), `pending-gate`, aprovação
 * (`approval_requests`), engine local (`createMaiaEngine` + `runReasoning`),
 * gateway de ferramentas, assembler, `MaiaOutputCoordinator`, máquina de
 * estados do turno e `decideTurnAction`.
 *
 * ─── Sobre o `digest` do pedido ─────────────────────────────────────────────
 *
 * `MaiaEngine.start` chama `canonicalDigest(request)` FORA do `try` que
 * classifica falha do raciocínio (`maia-engine.ts:160`): um pedido que o
 * digest não aceite não vira `reasoner_failed` — a chamada estoura e o turno
 * não entrega. Logo o positivo abaixo, que atravessa `buildPrompt` e entrega
 * um reply, é evidência de que o digest aceitou o pedido REAL (system prompt +
 * histórico + tools do turno), e não o `messages:[{role,content}]`/`tools:[]`
 * sintético do bloco de caracterização. Instrumentar `canonicalDigest` com
 * `vi.spyOn` foi deliberadamente evitado: um spy que não consiga redefinir a
 * export ESM reprova o arquivo por um motivo que não é o comportamento sob
 * prova.
 */
d('SC01 — runAgentForMensagem (caminho de produção) e a fronteira pós-gates', () => {
  let pool2: pg.Pool;
  let pessoa2: Pessoa;
  let conversa2: Conversa;
  /** O texto que o PEP de bloqueio/escalação devolve ao usuário (`core.ts`). */
  const TEXTO_DE_GATE = 'Esta ação requer aprovação adicional antes de prosseguir.';

  async function mkInbound2(conteudo: string): Promise<Mensagem> {
    const r = await pool2.query(
      `INSERT INTO mensagens (tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
       VALUES ($1,$2,$3,'in','texto',$4,'{}'::jsonb) RETURNING *`,
      [T, A, conversa2.id, conteudo],
    );
    return r.rows[0] as Mensagem;
  }

  /** Roda o turno pelo ENTRY POINT e mede a fronteira do motor. */
  async function rodarPeloCore(conteudo: string): Promise<{
    inbound: Mensagem;
    starts: number;
    reasoners: number;
    enviados: string[];
    turno: { status: string; outcome: string | null } | undefined;
  }> {
    const { runAgentForMensagem } = await import('@/agent/core.js');
    const inbound = await mkInbound2(conteudo);
    llm.workloads.length = 0;
    const antesStarts = await engineStarts();
    const antesEnviados = canal.enviados.length;

    await inT(() => runAgentForMensagem(inbound.id));

    const turno = await pool2.query<{ status: string; outcome: string | null }>(
      `SELECT status, outcome FROM agent_turns WHERE representative_message_id = $1`,
      [inbound.id],
    );
    return {
      inbound,
      starts: (await engineStarts()) - antesStarts,
      reasoners: llm.workloads.filter((w) => w === 'reasoner').length,
      enviados: canal.enviados.slice(antesEnviados),
      turno: turno.rows[0],
    };
  }

  /**
   * A trilha de auditoria DESTA mensagem.
   *
   * A tabela é `audit_log` (migrations/001_initial.sql:290) e a correlação é
   * `mensagem_id` (o `audit()` do core recebe o id do inbound). `audit_logs` —
   * plural em inglês — NÃO existe: a query estourava com
   * `relation "audit_logs" does not exist` e derrubava o caso por um erro de
   * digitação, não por comportamento do PEP.
   */
  async function auditDaMensagem(mensagem_id: string): Promise<Array<Record<string, unknown>>> {
    const r = await pool2.query<{ acao: string; metadata: Record<string, unknown> }>(
      `SELECT acao, metadata FROM audit_log WHERE mensagem_id = $1 ORDER BY created_at`,
      [mensagem_id],
    );
    return r.rows;
  }

  /**
   * O resolver de descritores tem CACHE de processo, positivo E negativo
   * (`policyResolverCache`, TTL 5min — `src/control-plane/policy/policy-cache.ts`).
   * Em produção, ativar/deprecar uma regra publica
   * `policy_rule_lifecycle:<tenant>` e o subscriber invalida a entrada. Um
   * fixture que escreve a linha DIRETO por SQL NÃO publica esse evento — sem o
   * flush abaixo o Mid PEP continua enxergando a resolução cacheada pelo turno
   * ANTERIOR (a `confirm_before_write_policy` tenant-wide do seed) e o caso
   * falha por NÃO ter exercitado policy nenhuma, não por defeito do produto.
   * O fixture reproduz o evento de ciclo de vida.
   */
  async function descartarCacheDePoliticas(): Promise<void> {
    const { policyResolverCache } = await import('@/control-plane/policy/policy-cache.js');
    policyResolverCache.invalidateAll();
  }

  /**
   * Testemunha do fixture: a policy recém-inserida é a que o RUNTIME resolve
   * para o descritor? Sem isto, um fixture invisível (cache velho, colisão de
   * índice, escopo) produzia o mesmo sintoma de um PEP que não bloqueou — e os
   * dois casos ficavam indistinguíveis no relatório.
   *
   * O descritor vai CONCRETO: quem expande o sentinela `'*'` é o adapter do
   * Decision Engine (`prod-env.ts`), não o resolver P8e — passar `'*'` aqui
   * casaria literalmente com nada e a testemunha mediria o próprio erro.
   */
  async function resolvidoParaOPolicy(policy_id: string, descriptor: string): Promise<boolean> {
    const { policyDescriptorResolver } = await import(
      '@/control-plane/policy/policy-descriptor-resolver.js'
    );
    const out = await inT(() =>
      policyDescriptorResolver.resolveDescriptors({
        tenant_id: T,
        agent_id: A,
        descriptors: [descriptor],
        scope: { channel: 'whatsapp' },
      }),
    );
    return out.resolved.some((p) => p.descriptor === descriptor && p.policy_id === policy_id);
  }

  /**
   * Insere uma `policy_rules` ATIVA que só casa com UMA pessoa (o predicado é
   * `actor.pessoa_id`, um dos campos que o Mid PEP expõe no fato DSL —
   * `src/runtime/decision/mid-pep.ts`). Escopar por pessoa é o que torna o
   * fixture invisível para as outras suítes que dividem este banco: nenhuma
   * delas usa a pessoa desta fixture.
   *
   * O descriptor tem de ser um dos que o resolvedor de produção expande a
   * partir de `'*'` (`RUNTIME_ENFORCED_WRITE_RISK_DESCRIPTORS` em
   * `src/control-plane/policy/boleto-write-policies.ts`): um descriptor
   * inventado nunca chegaria ao PEP e o caso passaria por NÃO ter rodado nada.
   *
   * ── Duas armadilhas do schema, e como o fixture as contorna ────────────────
   *
   * 1. **Uma única linha ATIVA por (tenant, agent_or_tenant_wide, descriptor)**
   *    (`idx_policy_rules_one_active_uq`, migrations/036). O seed de
   *    `migrations/078` deixa `confirm_before_write_policy` ativo TENANT-WIDE
   *    (`agent_id IS NULL`) e a 086 deixa `human_confirmation_policy` ativo em
   *    `(primary, primary)` com `scope={"roles":[…]}`. Por isso o fixture grava
   *    a regra como linha **agent-specific** de `confirm_before_write_policy`
   *    — a chave do índice (`COALESCE(agent_id,'tenant_wide')`) difere da linha
   *    do seed, e o resolver PREFERE a agent-specific
   *    (`findActiveCandidates` devolve agent-first). Um fixture de
   *    `human_confirmation_policy` em `(primary, primary)` seria impossível sem
   *    mutar o seed: colidiria em `version` E em `one_active`. O descriptor é o
   *    MESMO que o seed usa para `require_dual_approval`; o que varia por caso
   *    de aceite é o `effect`.
   *
   * 2. **Cache de resolução de descritores** — ver `descartarCacheDePoliticas()`.
   *    O flush roda aqui, depois do INSERT, para o Mid PEP ver a linha nova.
   */
  async function inserirPolicy(args: {
    descriptor: string;
    action: 'block' | 'require_dual_approval';
    regra: string;
    pessoa_id: string;
  }): Promise<string> {
    const body = {
      rule_id: args.regra,
      predicate: {
        kind: 'leaf',
        field: 'actor.pessoa_id',
        op: 'eq',
        value: args.pessoa_id,
      },
      effect: {
        action: args.action,
        metadata: { severity: 'high', applies_to_peps: ['mid', 'late'] },
      },
    };
    const r = await pool2.query<{ id: string }>(
      `INSERT INTO policy_rules
         (tenant_id, agent_id, rule_kind, rule_descriptor, rule_body, scope, source_of_truth,
          status, version, proposed_by, proposed_reason, approved_by, approved_at, activated_at)
       VALUES ($1,$2,'dual_approval',$3,$4::jsonb,'{}'::jsonb,'founder_explicit','active',1,
               'sc01_fixture','fixture do aceite SC01-AC02','sc01_fixture',now(),now())
       RETURNING id`,
      [T, A, args.descriptor, JSON.stringify(body)],
    );
    // Evento de ciclo de vida reproduzido: a linha nova tem de ser VISTA pelo
    // Mid PEP NESTE turno (ver `descartarCacheDePoliticas`).
    await descartarCacheDePoliticas();
    return r.rows[0]!.id;
  }

  /** Remove a policy do fixture e invalida o cache outra vez (pós-deprecação). */
  async function removerPolicy(policy_id: string): Promise<void> {
    await pool2.query(`DELETE FROM policy_rules WHERE id = $1`, [policy_id]);
    await descartarCacheDePoliticas();
  }

  beforeAll(async () => {
    pool2 = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 2 });
    // `tenants`/`agents`/`roles`: o turno só chega ao seam com papel default
    // ativo na política de canal (o role-selector falha fechado). Idempotente —
    // se o banco do CI já os semeia, isto é um no-op.
    await pool2.query(`INSERT INTO tenants(id, nome) VALUES($1,$1) ON CONFLICT DO NOTHING`, [T]);
    await pool2.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES($1,$2,$1) ON CONFLICT DO NOTHING`,
      [A, T],
    );
    await pool2.query(
      `INSERT INTO roles(tenant_id, agent_id, role_key, display_name, description, is_default, active)
       VALUES ($1,$2,'default','Default SC01','papel default do fixture SC01',true,true)
       ON CONFLICT (tenant_id, agent_id, role_key) DO NOTHING`,
      [T, A],
    );

    const telefone = `+55119${Date.now().toString().slice(-8)}`;
    const p = await pool2.query(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1,$2,'SC01 Gate',$3,'dono','ativa') RETURNING *`,
      [T, A, telefone],
    );
    pessoa2 = p.rows[0] as Pessoa;
    // `resolveAudience` é fail-closed: a pessoa existir não basta.
    await pool2.query(
      `INSERT INTO agent_audience_profiles(tenant_id, agent_id, pessoa_id, audience_type, trust_level, status)
       VALUES ($1,$2,$3,'owner','trusted_internal','active') ON CONFLICT DO NOTHING`,
      [T, A, pessoa2.id],
    );

    const conv = await pool2.query(
      `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status) VALUES ($1,$2,$3,'ativa') RETURNING *`,
      [T, A, pessoa2.id],
    );
    conversa2 = conv.rows[0] as Conversa;

    const ch = await pool2.query<{ id: string }>(
      `INSERT INTO channels(tenant_id, agent_id, channel_type, external_id, display_name, active, is_synthetic)
       VALUES ($1,$2,'whatsapp',$3,'Linha SC01',false,false) RETURNING id`,
      [T, A, telefone],
    );
    await pool2.query(`UPDATE conversas SET channel_id = $2 WHERE id = $1`, [
      conversa2.id,
      ch.rows[0]!.id,
    ]);

    const role = await pool2.query<{ id: string }>(
      `SELECT id FROM roles WHERE tenant_id=$1 AND agent_id=$2 AND active LIMIT 1`,
      [T, A],
    );
    if (role.rows.length === 0) throw new Error('nenhum role ativo em primary/primary — seed mudou');
    await pool2.query(
      `INSERT INTO channel_policies(tenant_id, agent_id, channel_id, default_role_id, switch_behavior)
       VALUES ($1,$2,$3,$4,'free_with_trigger')`,
      [T, A, ch.rows[0]!.id, role.rows[0]!.id],
    );
  }, 60_000);

  afterAll(async () => {
    await pool2?.end().catch(() => {});
  });

  /**
   * T01 · SC01-AC01 · SC01-AC04 — o POSITIVO pelo caminho de produção.
   *
   * O que este caso fecha, e que nenhum outro fechava: o turno NÃO é invocado
   * por dentro (a máscara/`runReActLoop`), e sim pelo ponto de entrada que o
   * worker usa. As três testemunhas são independentes:
   *   1. `engine.start` +1 — o core pós-gates ACIONOU a porta do motor;
   *   2. o reasoner do motor rodou UMA vez (workload `reasoner`);
   *   3. exatamente UM outbound saiu, e o turno fechou TERMINAL com
   *      `reply_delivered` — o caminho inteiro, do gate ao canal.
   */
  it('AC01/T01/AC04 — o entry point de produção atravessa o seam: 1 reply, 1 outbound, motor acionado', async () => {
    llm.roteiro = { texto: 'ok', modo: 'texto' };
    llm.porWorkload = { reasoner: { content: 'resposta do caminho de produção' } };
    try {
      const r = await rodarPeloCore('oi');

      expect(r.starts, 'o core pós-gates tem de ACIONAR a porta do motor').toBe(1);
      expect(r.reasoners, 'o raciocínio real do motor tem de rodar uma vez').toBe(1);
      expect(r.enviados).toEqual(['resposta do caminho de produção']);
      expect(r.turno?.status, 'o turno tem de existir e ter desfecho').toBeDefined();
      expect(r.turno?.outcome).toBe('reply_delivered');
      const { isTerminalTurnStatus } = await import('@/runtime/turns/index.js');
      expect(isTerminalTurnStatus(r.turno!.status as never)).toBe(true);
      expect(await outboundsTexto(pool2, conversa2.id)).toBe(1);
    } finally {
      llm.porWorkload = {};
    }
  });

  /**
   * SC01-AC02 (pendência) — o gate determinístico resolve a pendência e o
   * turno PARA ali: `engine.start=0`, nenhum workload `reasoner`, nenhum envio
   * inventado. A classificação é REAL (o gate chama o provedor com o workload
   * `pending_gate`; a resposta é do dublê do provedor, que é o dublê permitido)
   * e a resolução é real: a linha da pendência vira `respondida`.
   *
   * `acao_proposta` SEM `tool` é deliberado: `pending-resolver.ts` resolve sem
   * despachar efeito nenhum, então o caso mede a FRONTEIRA do gate, não uma
   * ferramenta.
   */
  it('AC02 — pendência: o gate resolve e o motor fica em start=0', async () => {
    llm.porWorkload = {
      pending_gate: {
        content: JSON.stringify({
          resolves_pending: true,
          option_chosen: 'sim',
          confidence: 0.95,
          is_topic_change: false,
          is_cancellation: false,
        }),
      },
    };
    try {
      const pq = await pool2.query<{ id: string }>(
        `INSERT INTO pending_questions(tenant_id, agent_id, conversa_id, pessoa_id, tipo, pergunta,
                                       opcoes_validas, acao_proposta, expira_em, status, metadata)
         VALUES ($1,$2,$3,$4,'gate','Confirma?',$5::jsonb,'{}'::jsonb,
                 now() + interval '10 min','aberta','{}'::jsonb) RETURNING id`,
        [
          T,
          A,
          conversa2.id,
          pessoa2.id,
          JSON.stringify([
            { key: 'sim', label: 'Sim' },
            { key: 'nao', label: 'Não' },
          ]),
        ],
      );

      const r = await rodarPeloCore('sim');

      expect(r.starts, 'um turno resolvido por pendência não aciona o motor').toBe(0);
      expect(r.reasoners).toBe(0);
      expect(r.enviados).toEqual([]);
      expect(r.turno?.outcome).toBe('pending_action_resolved');

      const st = await pool2.query<{ status: string }>(
        `SELECT status FROM pending_questions WHERE id = $1`,
        [pq.rows[0]!.id],
      );
      expect(st.rows[0]?.status).toBe('respondida');
    } finally {
      llm.porWorkload = {};
    }
  });

  /**
   * SC01-AC02 (aprovação) — uma resposta de aprovação (`aprova AP-<8 hex>`)
   * é governança DETERMINÍSTICA: `parseApprovalReply` casa antes do LLM, a
   * decisão vai ao store de `approval_requests` e o turno encerra. Nada de
   * motor: `engine.start=0`, nenhum envio pelo coordenador (a resposta desta
   * ramificação sai direto pelo `sendOutbound` do core).
   */
  it('AC02 — aprovação ("aprova AP-…"): decisão determinística, motor em start=0', async () => {
    /**
     * O prefixo é o `request_id` que o texto da resposta carrega
     * (`parseApprovalReply` casa `aprova AP-<8 hex>`) e entra também no `id` da
     * linha — que é chave primária. Prefixo FIXO passa na primeira execução e
     * estoura com `duplicate key … approval_requests_pkey` na segunda (a linha
     * `pending` do turno anterior fica no banco). Prefixo por execução ⇒ caso
     * re-executável, que é o que o comando de aceite exige.
     */
    const prefixo = randomUUID().replace(/-/g, '').slice(0, 8);
    await pool2.query(
      `INSERT INTO approval_requests
         (id, tenant_id, agent_id, requester_pessoa_id, conversa_id, request_id, tool, operation_type,
          intent_payload, intent_hash, approval_class, required_approvals, fingerprint, expires_at, status)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,'boleto_cancel','write','{}'::jsonb,'sc01-hash',
               'single_confirmation',1,$7, now() + interval '10 min','pending')`,
      [
        `${prefixo}-0000-4000-8000-000000000000`,
        T,
        A,
        pessoa2.id,
        conversa2.id,
        prefixo,
        `sc01-fingerprint-${randomUUID()}`,
      ],
    );

    const r = await rodarPeloCore(`aprova AP-${prefixo}`);

    expect(r.starts, 'resposta de aprovação não aciona o motor').toBe(0);
    expect(r.reasoners).toBe(0);
    expect(r.turno?.outcome).toBe('pending_action_resolved');
    expect(r.enviados, 'a decisão é respondida ao humano, uma vez').toHaveLength(1);
  });

  /**
   * SC01-AC02 (bloqueio) — um PEP REAL (Mid) bloqueia o turno lendo
   * `policy_rules`. O turno termina ANTES da linha do seam: `start=0`, nenhum
   * reasoner, e o usuário recebe o texto fixo do ramo `block` do core (o texto
   * da política NUNCA é exposto). A trilha é própria e verificável:
   * `decision_engine_policy_refused` com `metadata.decision='block'`.
   */
  it('AC02 — bloqueio por política: motor em start=0 e auditoria do ramo block', async () => {
    const policy_id = await inserirPolicy({
      descriptor: 'confirm_before_write_policy',
      action: 'block',
      regra: 'sc01_block_fixture',
      pessoa_id: pessoa2.id,
    });
    try {
      // Testemunha de FIXTURE (não de produto): prova que o PEP tem o que ler.
      // Sem ela, "o turno não foi bloqueado" e "o fixture era invisível"
      // produziam exatamente o mesmo relatório.
      expect(
        await resolvidoParaOPolicy(policy_id, 'confirm_before_write_policy'),
        'a policy do fixture tem de ser a RESOLVIDA pelo runtime (cache/escopo/índice)',
      ).toBe(true);

      const r = await rodarPeloCore('preciso de ajuda com um boleto');

      expect(r.starts, 'turno bloqueado antes do seam não aciona o motor').toBe(0);
      expect(r.reasoners).toBe(0);
      expect(r.enviados).toEqual([TEXTO_DE_GATE]);
      expect(
        ['fallback_delivered', 'no_reply_produced', 'reply_delivered'],
        `desfecho terminal esperado, veio ${String(r.turno?.outcome)}`,
      ).toContain(r.turno?.outcome);

      const audit = await auditDaMensagem(r.inbound.id);
      const recusa = audit.find((a) => a['acao'] === 'decision_engine_policy_refused');
      expect(recusa, 'o bloqueio tem de deixar rastro de auditoria').toBeDefined();
      expect((recusa!['metadata'] as Record<string, unknown>)['decision']).toBe('block');
    } finally {
      await removerPolicy(policy_id);
    }
  });

  /**
   * SC01-AC02 (escalação) — o OUTRO ramo do core
   * (`packet.action_mode === 'escalate'`). Mesma fronteira, trilha distinta:
   * `metadata.decision='escalate'`.
   *
   * O fixture usa `confirm_before_write_policy` — o ÚNICO dos dois descritores
   * que o Decision Engine consegue resolver aqui com linha própria — com
   * `effect.action='require_dual_approval'` e SEM `metadata.intent`:
   *
   *   - `MidPepImpl` converte `require_dual_approval` sem
   *     `intent='escalate_to_human'` numa `RequireDualApprovalDecision`
   *     (`mid-pep.ts:104-137`), e o `DecisionEngine` monta o pacote com
   *     `action_mode='escalate'` e SEM `block` (`decision-engine.ts:381-393`);
   *   - sem `block`, o core cai no ramo de escalação (`core.ts:1977`), audita
   *     `decision='escalate'` e responde o mesmo texto — sem passar pelo seam.
   *
   * `human_confirmation_policy` não serve como fixture aditivo: a 086 já deixa
   * uma linha ATIVA agent-specific desse descritor em `(primary, primary)`, e
   * `idx_policy_rules_one_active_uq` proíbe uma segunda ativa para a mesma
   * chave (era a colisão que o QA reportou). O ramo exercitado é o mesmo; o que
   * muda em relação ao seed é só de qual descritor o `require_dual_approval`
   * vem.
   */
  it('AC02 — escalação por política: motor em start=0 e auditoria do ramo escalate', async () => {
    const policy_id = await inserirPolicy({
      descriptor: 'confirm_before_write_policy',
      action: 'require_dual_approval',
      regra: 'sc01_escalate_fixture',
      pessoa_id: pessoa2.id,
    });
    try {
      expect(
        await resolvidoParaOPolicy(policy_id, 'confirm_before_write_policy'),
        'a policy do fixture tem de ser a RESOLVIDA pelo runtime (cache/escopo/índice)',
      ).toBe(true);

      const r = await rodarPeloCore('quero cancelar um boleto agora');

      expect(r.starts, 'turno escalado antes do seam não aciona o motor').toBe(0);
      expect(r.reasoners).toBe(0);
      expect(r.enviados).toEqual([TEXTO_DE_GATE]);

      const audit = await auditDaMensagem(r.inbound.id);
      const recusa = audit.find((a) => a['acao'] === 'decision_engine_policy_refused');
      expect(recusa).toBeDefined();
      expect((recusa!['metadata'] as Record<string, unknown>)['decision']).toBe('escalate');
    } finally {
      await removerPolicy(policy_id);
    }
  });

  /**
   * SC01-AC02 (execute_skill) — o Decision Engine seleciona uma skill
   * `prompt_only` e o core a executa (`executeSelectedSkill` → `runSkill` →
   * entrega), SEM passar pelo motor: `engine.start=0` e nenhum workload
   * `reasoner`.
   *
   * A seleção é REAL: o intent vem dos heurísticos do classificador
   * (`^/ajuda|^ajuda$` → `help_request`, sem LLM) e o `skill_descriptor`
   * `help_request` casa por igualdade exata com ele
   * (`deriveIntentLabels` + `scoreSkillMatch`).
   *
   * ── Duas causas do vermelho anterior, e as duas eram do FIXTURE ────────────
   *
   * 1. `usage_policy` INVÁLIDA. `SkillUsagePolicySchema` é `.strict()` e exige
   *    `allowed_audience` (≥1) + `data_scope` (≥1) + `exposure_policy` +
   *    `requires_auth_level` + `requires_confirmation`; o fixture escrevia
   *    `allowed_audiences`/`allowed_trust_levels`/`max_risk_level` — chaves
   *    desconhecidas e campos obrigatórios ausentes. O parser falha, e o
   *    filtro do `SkillSelector` remove o candidato (fail-closed,
   *    `skill-selector.ts` step 6). Sem candidato, o ActionDecider devolve
   *    `respond` e o turno cai no seam (`starts=1`) — foi exatamente o que o
   *    QA mediu (`agent_turns completed`, outbound `ok`). A política abaixo
   *    espelha o par (audience `owner`, `trusted_internal`) que o
   *    `resolveAudience` desta fixture realmente resolve, e passa as 7 regras
   *    de `evaluateUsagePolicy` (inclusive a contenção de `data_scope`).
   *
   * 2. O provedor devolvia `'ok'`, que NÃO é JSON. `prompt_only` faz
   *    `parseJsonResponse(text)` e lança `invalid_json_in_llm_response`; o
   *    SkillRunner converte em `executor_error`, o core trata como skill não
   *    entregue e cai no seam. O dublê do provedor responde o que a skill
   *    espera: um objeto com `output.reply` (o texto que vai ao usuário —
   *    `execute-skill.ts:184`).
   */
  it('AC02 — execute_skill: a skill executa e o motor fica em start=0', async () => {
    const RESPOSTA_DA_SKILL = 'Resposta da skill de ajuda (AC02).';
    const skill = await pool2.query<{ id: string }>(
      `INSERT INTO skills(tenant_id, agent_id, skill_descriptor, category, execution_mode, goal,
                          when_to_use, procedure, input_schema, output_schema, usage_policy,
                          status, version, proposed_by, approved_by, approved_at, activated_at,
                          applicable_to_role)
       VALUES ($1,$2,'help_request','compose','prompt_only','responder um pedido de ajuda',
               'Quando o usuário pede ajuda pelo WhatsApp.',
               $3::jsonb,'{}'::jsonb,'{}'::jsonb,$4::jsonb,
               'active',1,'sc01_fixture','sc01_fixture',now(),now(),'{}')
       RETURNING id`,
      [
        T,
        A,
        JSON.stringify({ system_prompt: 'Você é a Maia. Responda o pedido de ajuda.' }),
        JSON.stringify({
          allowed_audience: ['owner'],
          allowed_channels: ['whatsapp'],
          data_scope: ['public_info'],
          exposure_policy: 'internal_only',
          requires_auth_level: 'trusted_internal',
          requires_confirmation: false,
        }),
      ],
    );
    llm.porWorkload = { skill: { content: JSON.stringify({ reply: RESPOSTA_DA_SKILL }) } };
    try {
      const r = await rodarPeloCore('ajuda');

      expect(r.starts, 'uma skill terminal não pode acionar o motor').toBe(0);
      expect(r.reasoners, 'nenhuma deliberação do motor nesta ramificação').toBe(0);
      expect(r.enviados, 'a skill entrega a própria resposta').toEqual([RESPOSTA_DA_SKILL]);
    } finally {
      llm.porWorkload = {};
      await pool2.query(`DELETE FROM skills WHERE id = $1`, [skill.rows[0]!.id]);
    }
  }, 60_000);
});