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
}));

vi.mock('@/lib/claude.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/claude.js')>();
  return {
    ...actual,
    callLLM: async (params: { workload?: string }): Promise<LLMResponse> => {
      const workload = params.workload ?? 'sem_workload';
      llm.workloads.push(workload);
      if (llm.roteiro.modo === 'falha') throw new Error('provider indisponível (dublê)');
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

/** Outbounds TEXTO desta conversa — o que o usuário teria recebido. */
async function outboundsTexto(conversa_id: string): Promise<number> {
  const r = await pool.query<{ n: number }>(
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
    expect(await outboundsTexto(conversa.id)).toBe(1);
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