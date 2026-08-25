/**
 * #636 (fatia A da épica #471) — o pedido de ferramenta, contra o banco real.
 *
 * As quatro sondas que a issue exige, sem harness paralelo: cada caso chama o
 * CALL SITE DE PRODUÇÃO (`proposeToolRequestForGap`, o mesmo que
 * `src/workers/gap-escalation-monitor.ts` dispara) e verifica o efeito nas
 * tabelas reais.
 *
 *  1. gap recorrente SEM tool disponível → proposta `tool_request` persistida,
 *     com intenção, situações (link de trace resolvido), janela de frequência e
 *     rascunho de contrato Zod marcado como proposta;
 *  2. gap com tool DISPONÍVEL → nenhuma proposta, e o motivo é nomeado;
 *  3. escopo: a proposta de um tenant não aparece para outro, e um
 *     `root_trace_id` que aponta para o envelope de OUTRO tenant não vira link;
 *  4. a marcação de rascunho é imposta pelo BANCO — um INSERT que a remova é
 *     recusado, mesmo vindo de SQL cru (que não passa por Zod nenhum).
 *
 * Limpeza: cada caso rastreia os ids que criou e apaga em `finally`, em ordem
 * segura de FK — o padrão de `repos-leak.spec.ts`. Transação não serve aqui
 * porque os repos usam o pool global do Drizzle e não enxergariam linhas não
 * commitadas do cliente de teste.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T_A = 'wt636_tenant_a';
const AG_A = 'wt636_agent_a';
const T_B = 'wt636_tenant_b';
const AG_B = 'wt636_agent_b';

let pool: pg.Pool;

const proposer = moduloDeProducao(() => import('@/cognition/tool-request/proposer.js'));
const repos = moduloDeProducao(() => import('@/db/repositories.js'));

async function ensureTenantAgent(c: pg.PoolClient, tenant: string, agent: string) {
  await c.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [
    tenant,
  ]);
  await c.query(
    'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING',
    [agent, tenant],
  );
}

type Lixo = { propostas: string[]; observacoes: string[]; gaps: string[]; envelopes: string[] };
const novoLixo = (): Lixo => ({ propostas: [], observacoes: [], gaps: [], envelopes: [] });

async function limpar(c: pg.PoolClient, l: Lixo) {
  const ops: Array<[string, string, string[]]> = [
    ['capability_proposals', 'id', l.propostas],
    ['agent_capability_gap_observations', 'id', l.observacoes],
    ['agent_capability_gaps', 'id', l.gaps],
    ['runtime_trace_envelopes', 'trace_id', l.envelopes],
  ];
  for (const [tabela, coluna, ids] of ops) {
    if (ids.length === 0) continue;
    await c
      .query(`DELETE FROM ${tabela} WHERE ${coluna} = ANY($1::uuid[])`, [ids])
      .catch(() => undefined);
  }
  // #637 — o agregado referencia a proposta representante (sem ON DELETE
  // CASCADE, de propósito: agrupamento não deve poder ser apagado de carona).
  // Então ele sai ANTES, ou o DELETE das propostas falha por FK e a faxina
  // deixa rastro que a rodada seguinte herdaria como linha de base.
  if (l.gaps.length > 0) {
    await c
      .query('DELETE FROM tool_request_aggregate_members WHERE gap_id = ANY($1::uuid[])', [
        l.gaps,
      ])
      .catch(() => undefined);
    await c
      .query(
        'DELETE FROM tool_request_aggregates WHERE representative_gap_id = ANY($1::uuid[])',
        [l.gaps],
      )
      .catch(() => undefined);
  }
  // A proposta pode ter sido criada pelo código de produção com um id que o
  // teste não viu; o gap é o eixo confiável de faxina.
  if (l.gaps.length > 0) {
    await c
      .query('DELETE FROM capability_proposals WHERE gap_id = ANY($1::uuid[])', [l.gaps])
      .catch(() => undefined);
    await c
      .query('DELETE FROM agent_capability_gap_observations WHERE gap_id = ANY($1::uuid[])', [
        l.gaps,
      ])
      .catch(() => undefined);
    await c
      .query('DELETE FROM agent_capability_gaps WHERE id = ANY($1::uuid[])', [l.gaps])
      .catch(() => undefined);
  }
}

async function mkGap(
  c: pg.PoolClient,
  args: { tenant: string; agent: string; descricao: string; tipo?: string; nivel?: string },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO agent_capability_gaps
       (tenant_id, agent_id, capability_description, tipo, contexto,
        frequency_score, severity_score, current_level)
     VALUES ($1, $2, $3, $4, 'atendimento', 6, 5, $5) RETURNING id`,
    [args.tenant, args.agent, args.descricao, args.tipo ?? 'tool', args.nivel ?? 'proposed'],
  );
  return r.rows[0]!.id;
}

async function mkEnvelope(
  c: pg.PoolClient,
  args: { tenant: string; agent: string; rootTraceId: string },
): Promise<string> {
  await c.query(
    `INSERT INTO runtime_trace_envelopes
       (trace_id, tenant_id, agent_id, root_trace_id, attempt, decision,
        side_effect_level, envelope_hmac, hmac_key_version)
     VALUES ($1, $2, $3, $1, 1, 'allow', 'low', 'hmac-de-teste', 1)`,
    [args.rootTraceId, args.tenant, args.agent],
  );
  return args.rootTraceId;
}

async function mkObservacao(
  c: pg.PoolClient,
  args: {
    tenant: string;
    agent: string;
    gapId: string;
    rootTraceId?: string | null;
    intent: string;
    args_tentados?: Record<string, unknown>;
    saida_esperada?: Record<string, unknown>;
    observed_at?: string;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO agent_capability_gap_observations
       (tenant_id, agent_id, gap_id, intent, detail, root_trace_id,
        attempted_args, expected_output, observed_at)
     VALUES ($1, $2, $3, $4, 'cliente pediu no whatsapp', $5, $6, $7, COALESCE($8::timestamptz, now()))
     RETURNING id`,
    [
      args.tenant,
      args.agent,
      args.gapId,
      args.intent,
      args.rootTraceId ?? null,
      JSON.stringify(args.args_tentados ?? {}),
      JSON.stringify(args.saida_esperada ?? {}),
      args.observed_at ?? null,
    ],
  );
  return r.rows[0]!.id;
}

d('#636 — o pedido de ferramenta contra o banco real', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await ensureTenantAgent(c, T_A, AG_A);
      await ensureTenantAgent(c, T_B, AG_B);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  // ─── SONDA 1 ──────────────────────────────────────────────────────────────
  it('gap recorrente SEM tool disponível gera a proposta estruturada', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const gapId = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'consultar estoque do produto no ERP',
      });
      lixo.gaps.push(gapId);

      const traceReal = randomUUID();
      lixo.envelopes.push(
        await mkEnvelope(c, { tenant: T_A, agent: AG_A, rootTraceId: traceReal }),
      );

      lixo.observacoes.push(
        await mkObservacao(c, {
          tenant: T_A,
          agent: AG_A,
          gapId,
          rootTraceId: traceReal,
          intent: 'consultar estoque do produto no ERP',
          args_tentados: { produto_id: 'SKU-1', deposito: 'sp' },
          saida_esperada: { quantidade: 4 },
          observed_at: '2026-08-01T00:00:00Z',
        }),
        await mkObservacao(c, {
          tenant: T_A,
          agent: AG_A,
          gapId,
          // Sem trace: o call site não estava sob escopo de correlação.
          rootTraceId: null,
          intent: 'consultar estoque do produto no ERP',
          args_tentados: { produto_id: 'SKU-2' },
          observed_at: '2026-08-05T00:00:00Z',
        }),
      );

      const gap = (
        await c.query('SELECT * FROM agent_capability_gaps WHERE id = $1', [gapId])
      ).rows[0];

      const r = await runWithTenantContext({ tenant_id: T_A, agent_id: AG_A }, () =>
        proposer().proposeToolRequestForGap({ gap: gap as never }),
      );

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      lixo.propostas.push(r.proposal_id);

      // 1 · a linha existe, com o tipo novo e o escopo obrigatório.
      const linha = (
        await c.query(
          `SELECT tenant_id, agent_id, capability_type, gap_id, status, proposed_spec
             FROM capability_proposals WHERE id = $1`,
          [r.proposal_id],
        )
      ).rows[0] as {
        tenant_id: string;
        agent_id: string;
        capability_type: string;
        gap_id: string;
        status: string;
        proposed_spec: Record<string, unknown>;
      };
      expect(linha.capability_type).toBe('tool_request');
      expect(linha.tenant_id).toBe(T_A);
      expect(linha.agent_id).toBe(AG_A);
      expect(linha.gap_id).toBe(gapId);
      expect(linha.status).toBe('draft');

      // 2 · a marcação de rascunho, como o banco a vê.
      expect(linha.proposed_spec.spec_kind).toBe('tool_request');
      expect(linha.proposed_spec.contract_status).toBe('draft_proposal_not_in_force');

      // 3 · intenção, situações, frequência, rascunho.
      const spec = r.spec;
      expect(spec.intent).toBe('consultar estoque do produto no ERP');
      expect(spec.situations).toHaveLength(2);
      const comTrace = spec.situations.filter((s) => s.trace_resolved);
      expect(comTrace).toHaveLength(1);
      expect(comTrace[0]!.root_trace_id).toBe(traceReal);
      // A observação sem trace vira situação SEM link, nunca link inventado.
      expect(spec.situations.filter((s) => !s.trace_resolved)[0]!.root_trace_id).toBeNull();

      expect(spec.frequency.occurrences).toBe(2);
      expect(spec.frequency.window_days).toBeCloseTo(4, 1);

      expect(spec.contract_draft.proposed_tool_name).toBe('consultar_estoque_produto_erp');
      expect(spec.contract_draft.completeness).toBe('inputs_and_outputs_observed');
      expect(spec.contract_draft.inputs.map((i) => i.name).sort()).toEqual([
        'deposito',
        'produto_id',
      ]);
      expect(
        spec.contract_draft.inputs.find((i) => i.name === 'produto_id')!.required,
      ).toBe(true);
      expect(spec.contract_draft.inputs.find((i) => i.name === 'deposito')!.required).toBe(
        false,
      );
      expect(spec.contract_draft.zod_source).toContain('PROPOSTA — NÃO É CONTRATO VIGENTE');
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  // ─── SONDA 2 ──────────────────────────────────────────────────────────────
  it('gap cuja tool JÁ EXISTE não gera proposta nenhuma', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      // `query_balance` é uma tool REAL do registro de produção.
      const gapId = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'usar query_balance para o saldo consolidado',
      });
      lixo.gaps.push(gapId);
      lixo.observacoes.push(
        await mkObservacao(c, {
          tenant: T_A,
          agent: AG_A,
          gapId,
          intent: 'ver saldo',
          args_tentados: { conta_id: 'c1' },
        }),
      );

      const gap = (
        await c.query('SELECT * FROM agent_capability_gaps WHERE id = $1', [gapId])
      ).rows[0];

      const r = await runWithTenantContext({ tenant_id: T_A, agent_id: AG_A }, () =>
        proposer().proposeToolRequestForGap({ gap: gap as never }),
      );

      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('tool_ja_existe');
      expect(r.detail).toBe('query_balance');

      const n = await c.query('SELECT count(*)::int AS n FROM capability_proposals WHERE gap_id = $1', [
        gapId,
      ]);
      expect(n.rows[0]!.n).toBe(0);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('gap que não é de tool (knowledge) não gera pedido de ferramenta', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const gapId = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'saber a politica de devolucao do cliente',
        tipo: 'knowledge',
      });
      lixo.gaps.push(gapId);
      const gap = (
        await c.query('SELECT * FROM agent_capability_gaps WHERE id = $1', [gapId])
      ).rows[0];

      const r = await runWithTenantContext({ tenant_id: T_A, agent_id: AG_A }, () =>
        proposer().proposeToolRequestForGap({ gap: gap as never }),
      );
      expect(r).toMatchObject({ ok: false, reason: 'gap_nao_e_de_tool' });
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('gap sem ocorrência registrada não vira pedido — a evidência é o pedido', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const gapId = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'emitir nota fiscal de servico',
      });
      lixo.gaps.push(gapId);
      const gap = (
        await c.query('SELECT * FROM agent_capability_gaps WHERE id = $1', [gapId])
      ).rows[0];

      const r = await runWithTenantContext({ tenant_id: T_A, agent_id: AG_A }, () =>
        proposer().proposeToolRequestForGap({ gap: gap as never }),
      );
      expect(r).toMatchObject({ ok: false, reason: 'sem_ocorrencias' });
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  // ─── SONDA 3 ──────────────────────────────────────────────────────────────
  it('escopo: a proposta de um tenant NÃO aparece para outro', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const gapId = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'agendar visita tecnica no sistema do parceiro',
      });
      lixo.gaps.push(gapId);
      lixo.observacoes.push(
        await mkObservacao(c, {
          tenant: T_A,
          agent: AG_A,
          gapId,
          intent: 'agendar visita tecnica',
          args_tentados: { data: '2026-09-01' },
        }),
      );
      const gap = (
        await c.query('SELECT * FROM agent_capability_gaps WHERE id = $1', [gapId])
      ).rows[0];

      const r = await runWithTenantContext({ tenant_id: T_A, agent_id: AG_A }, () =>
        proposer().proposeToolRequestForGap({ gap: gap as never }),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      lixo.propostas.push(r.proposal_id);

      const { capabilityProposalsRepo, capabilityGapObservationsRepo } = repos();

      // O dono enxerga.
      const doDono = await runWithTenantContext({ tenant_id: T_A, agent_id: AG_A }, () =>
        capabilityProposalsRepo.listByGap(gapId),
      );
      expect(doDono.map((p) => p.id)).toContain(r.proposal_id);

      // O vizinho NÃO enxerga — nem por listagem, nem por id vazado.
      const doVizinho = await runWithTenantContext({ tenant_id: T_B, agent_id: AG_B }, () =>
        capabilityProposalsRepo.listByGap(gapId),
      );
      expect(doVizinho).toEqual([]);
      const porId = await runWithTenantContext({ tenant_id: T_B, agent_id: AG_B }, () =>
        capabilityProposalsRepo.getById(r.proposal_id),
      );
      expect(porId).toBeNull();

      // E as ocorrências que sustentam a proposta também não vazam.
      const obsVizinho = await runWithTenantContext({ tenant_id: T_B, agent_id: AG_B }, () =>
        capabilityGapObservationsRepo.listForGap(gapId),
      );
      expect(obsVizinho).toEqual([]);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('escopo: trace de OUTRO tenant não vira link — a situação sai sem link', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      // Envelope que existe, mas pertence ao tenant B.
      const traceDoVizinho = randomUUID();
      lixo.envelopes.push(
        await mkEnvelope(c, { tenant: T_B, agent: AG_B, rootTraceId: traceDoVizinho }),
      );

      const gapId = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'reservar sala na agenda corporativa',
      });
      lixo.gaps.push(gapId);
      lixo.observacoes.push(
        await mkObservacao(c, {
          tenant: T_A,
          agent: AG_A,
          gapId,
          rootTraceId: traceDoVizinho,
          intent: 'reservar sala',
        }),
      );

      const gap = (
        await c.query('SELECT * FROM agent_capability_gaps WHERE id = $1', [gapId])
      ).rows[0];
      const r = await runWithTenantContext({ tenant_id: T_A, agent_id: AG_A }, () =>
        proposer().proposeToolRequestForGap({ gap: gap as never }),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      lixo.propostas.push(r.proposal_id);

      expect(r.spec.situations).toHaveLength(1);
      // O id foi PRESERVADO (é evidência do que a observação registrou), mas
      // NÃO foi promovido a link: `trace_resolved` é false porque o envelope
      // vive fora do escopo.
      expect(r.spec.situations[0]!.root_trace_id).toBe(traceDoVizinho);
      expect(r.spec.situations[0]!.trace_resolved).toBe(false);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  // ─── SONDA 4 ──────────────────────────────────────────────────────────────
  it('o BANCO recusa uma proposta tool_request sem a marcação de rascunho', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const gapId = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'exportar relatorio para o contador',
      });
      lixo.gaps.push(gapId);

      const inserir = (spec: Record<string, unknown>) =>
        c.query(
          `INSERT INTO capability_proposals
             (tenant_id, agent_id, gap_id, capability_type, title, description,
              proposed_spec, motivation)
           VALUES ($1, $2, $3, 'tool_request', 't', 'd', $4::jsonb, 'm') RETURNING id`,
          [T_A, AG_A, gapId, JSON.stringify(spec)],
        );

      // Sem `contract_status` de rascunho → recusado.
      await expect(
        inserir({ spec_kind: 'tool_request', contract_status: 'active' }),
      ).rejects.toThrow(/capability_proposals_tool_request_marking_check/);

      // Sem `spec_kind` → recusado. Este é o caso que a lógica de três valores
      // do SQL deixaria passar com `=` em vez de `IS NOT DISTINCT FROM`: chave
      // ausente vira NULL, `NULL = '...'` vira NULL, e um CHECK que dá NULL
      // ACEITA a linha. Ver o comentário na migração 125.
      await expect(
        inserir({ contract_status: 'draft_proposal_not_in_force' }),
      ).rejects.toThrow(/capability_proposals_tool_request_marking_check/);

      // Spec vazio (o DEFAULT da coluna) → recusado pelo mesmo motivo.
      await expect(inserir({})).rejects.toThrow(
        /capability_proposals_tool_request_marking_check/,
      );

      // Com a marcação completa → aceito. (Prova que o CHECK recusa a AUSÊNCIA
      // da marcação, e não o INSERT em si.)
      const ok = await inserir({
        spec_kind: 'tool_request',
        contract_status: 'draft_proposal_not_in_force',
      });
      lixo.propostas.push(ok.rows[0]!.id as string);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('a tabela de ocorrências recusa o literal proibido `default`', async () => {
    const c = await pool.connect();
    try {
      await expect(
        c.query(
          `INSERT INTO agent_capability_gap_observations (tenant_id, agent_id, gap_id, intent)
           VALUES ('default', 'default', gen_random_uuid(), 'x')`,
        ),
      ).rejects.toThrow(/agent_capability_gap_observations_no_default_literal|violates/);
    } finally {
      c.release();
    }
  });
});
