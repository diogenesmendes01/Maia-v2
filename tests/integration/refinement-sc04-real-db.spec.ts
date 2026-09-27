/**
 * SC04 (§5.3.2, §5.6.2–5.6.4, §5.7.4) — o CAMINHO DURÁVEL do despacho de tool
 * call, contra Postgres REAL.
 *
 * ─── O que é real aqui, e o que é double ────────────────────────────────────
 *
 * REAL: o banco (journal de runs/turns, `engine_tool_calls`, ledger de
 * idempotência, `approval_requests`), o CORPO do dispatcher (`_dispatcher.ts`,
 * o mesmo do caminho legado), os repositórios de engine e as transições de
 * fence (`row_version` + `dispatch_token` + claim do turno).
 *
 * DOUBLE (um só, declarado): o REGISTRY, com uma tool fixture `sc04_fixture`
 * cujo handler só conta chamadas. É o que permite medir "quantas vezes o efeito
 * foi emitido" sem depender de um efeito externo de verdade — e é a mesma
 * técnica das suítes de dispatcher já existentes. O ledger e o journal NÃO são
 * dublados: é neles que os tokens são conferidos.
 *
 * ─── As perguntas que cada caso prende ──────────────────────────────────────
 *
 *  1. O receipt é ÍNTEGRO e os tokens são os REAIS: `reservation_token` do
 *     ledger (não `res-<call_id>`), chave de idempotência congelada, hash do
 *     receipt gravado ao lado do JSON (AC01/AC03/AC04/AC07).
 *  2. A MESMA intenção repetida não emite efeito duas vezes: o cache
 *     autoritativo é adotado (T26), e a segunda chamada nem chega ao handler.
 *  3. Args divergentes na MESMA call são `payload_conflict`, sem handler (T27).
 *  4. Retry depois da virada de BUCKET adota a identidade congelada em vez de
 *     recalculá-la (AC02) — e a recusa real (`identity_conflict`) continua
 *     valendo para intenção que mudou.
 *  5. A recusa de governança ANTES do handler é liquidável como `denied` com
 *     evidência `none`, e `completed` a partir de `dispatching` é recusado
 *     (AC08) — a vaga sequencial não fica presa.
 *  6. Falha do marcador impede o handler e devolve `journal_unavailable` com
 *     `handler_may_have_started: false` (AC05); posse perdida não produz
 *     receipt (AC05); a evidência de efeito nunca regride (AC07).
 *
 * Skipped sem `TEST_DB_URL`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { engineRunsRepo } from '@/db/repositories/engine-repos.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';

/**
 * Só roda apontado para o banco LOCAL do card, e RECUSA qualquer coisa que
 * cheire a produção. O gate do spec irmão exige `DATABASE_URL === TEST_DB_URL`;
 * aqui a exigência é mais direta, porque `harness-project-env` nem sempre expõe
 * as duas iguais — e um `describe.skip` silencioso é pior que um gate explícito:
 * o teste parecia verde (9 skipped) sem ter tocado o banco uma única vez.
 */
const DB_URL = process.env.TEST_DB_URL ?? '';
const SHOULD_RUN =
  DB_URL.length > 0 && /(^|\/\/|@)(127\.0\.0\.1|localhost):\d+\//.test(DB_URL) && !/prod/i.test(DB_URL);
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 'hermes-sc04-tenant';
const AGENT = 'hermes-sc04-agent';
const SHA = 'b'.repeat(64);

const { fixture } = vi.hoisted(() => ({
  fixture: {
    chamadas: 0,
    resultado: { ok: true, eco: 'oi' } as unknown,
    deveLancar: false,
  },
}));

/**
 * ─── DOIS doubles de AUTORIZAÇÃO, declarados ────────────────────────────────
 *
 * `canAct` e `constitutionalCheck` tocam a base de autorização (pessoas,
 * vínculos, regras). Aqui o sujeito é o JOURNAL do despacho durável — fence,
 * identidade, marcador e settlement —, e a autorização precisa apenas ATRAVESSAR
 * para que o efeito seja alcançado. As duas checagens têm suítes próprias
 * (`tests/unit/governance/*`, `tests/integration/permissions-real-db.spec.ts`);
 * deixá-las reais aqui só faria o teste medir a ausência de vínculos da fixture.
 * O caminho de RECUSA por autorização continua medido de verdade no caso 8, que
 * liquida `denied` sobre a call e confere a evidência `none` no journal.
 */
vi.mock('@/governance/permissions.js', async () => {
  const actual = await vi.importActual<typeof import('@/governance/permissions.js')>(
    '@/governance/permissions.js',
  );
  return { ...actual, canAct: vi.fn(() => ({ allowed: true as const })) };
});
vi.mock('@/governance/rules.js', () => ({ constitutionalCheck: vi.fn(() => null) }));

vi.mock('@/tools/_registry.js', () => {
  const passthrough = { safeParse: (v: unknown) => ({ success: true as const, data: v }) };
  return {
    REGISTRY: {
      sc04_fixture: {
        name: 'sc04_fixture',
        description: 'fixture SC04 — contador de execuções',
        input_schema: passthrough,
        output_schema: passthrough,
        required_actions: [],
        side_effect: 'write',
        effect_class: 'non_interruptible',
        sensitive: false,
        redis_required: false,
        operation_type: 'create',
        audit_action: 'fact_saved',
        feature_flag: undefined,
        handler: async () => {
          fixture.chamadas += 1;
          if (fixture.deveLancar) throw new Error('handler fixture explodiu');
          return fixture.resultado;
        },
      },
    },
    isToolEnabled: () => true,
  };
});

import { dispatchToolDurable, BeforeHandlerError } from '@/tools/_dispatcher.js';
import { createEngineToolGateway } from '@/integrations/hermes/tool-gateway.js';
import { runWithTurnExecution } from '@/runtime/turns/execution-context.js';
import type { TurnExecutionContext } from '@/runtime/turns/claim.js';
import type {
  DurableDispatchResultV1,
  EngineToolCallV1,
  EngineToolReplyV1,
} from '@/runtime/engines/contracts.js';
import type { ToolGatewayDepsV1 } from '@/integrations/hermes/tool-gateway.js';
import type { Pessoa, Conversa } from '@/db/schema.js';

let pool: pg.Pool;

const noEscopo = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, fn);

type Turno = { turn_id: string; claim_token: string; attempt: number };

const CLASSIFICACAO = {
  side_effect: 'write' as const,
  effect_class: 'non_interruptible' as const,
  sensitive: false,
  legacy_irreversible_invoked: false,
};

/**
 * Ids FIXOS, e não `randomUUID()` por execução.
 *
 * `pessoas` tem UNIQUE `(tenant_id, agent_id, telefone_whatsapp)`: com id
 * aleatório, a SEGUNDA execução da suíte tentava inserir a mesma pessoa com
 * outro id e morria no `beforeAll` ("duplicate key ... pessoas_tenant_agent_
 * telefone_key"). Ids estáveis fazem o `ON CONFLICT (id) DO NOTHING` ser
 * exatamente o no-op que se quer — e deixam o ledger de uma execução
 * reconhecível na seguinte.
 */
const PESSOA_ID = '11111111-1111-4111-8111-111111111111';
const ENTIDADE_ID = '22222222-2222-4222-8222-222222222222';

const ctx = {
  pessoa: { id: PESSOA_ID, nome: 'Fulana', status: 'ativa' } as unknown as Pessoa,
  scope: { entidades: [ENTIDADE_ID], byEntity: new Map() },
  conversa: { id: randomUUID() } as unknown as Conversa,
  mensagem_id: randomUUID(),
  request_id: randomUUID(),
};

/**
 * O despacho SEMPRE dentro do contexto de tenant + de tentativa: o dispatcher
 * lê o grant do agente, o bucket de idempotência e a posse do turno desses dois
 * ALS. Fora deles, o que se mede é outra coisa (e o `tool_not_granted` aparece
 * por falta de contexto, não por falta de grant).
 */
const despachar = (
  signal: AbortSignal,
  tool: string,
  args: Record<string, unknown>,
  control: unknown,
): Promise<DurableDispatchResultV1> =>
  noEscopo(() =>
    runWithTurnExecution(turnContext(signal, 60_000), () =>
      dispatchToolDurable({ tool, args, ctx }, control as never),
    ),
  ) as Promise<DurableDispatchResultV1>;

async function seedTenant(): Promise<void> {
  await pool.query('INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING', [
    TENANT,
  ]);
  await pool.query(
    'INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING',
    [AGENT, TENANT],
  );
  // `pessoas` e `entidades` são FKs REAIS do ledger de idempotência
  // (`idempotency_keys_pessoa_id_fkey` quebrou a primeira versão desta suíte):
  // não dá para medir o caminho durável com ids inventados, e é bom que não dê —
  // é o banco provando que a chave de idempotência está amarrada a um agente e a
  // uma entidade que existem.
  await pool.query(
    `INSERT INTO pessoas (id, tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
     VALUES ($1, $2, $3, 'Fulana SC04', '+5511900000777', 'dono', 'ativa')
     ON CONFLICT (id) DO NOTHING`,
    [PESSOA_ID, TENANT, AGENT],
  );
  await pool.query(
    `INSERT INTO entidades (id, tenant_id, agent_id, nome, tipo, status)
     VALUES ($1, $2, $3, 'Entidade SC04', 'pj', 'ativa')
     ON CONFLICT (id) DO NOTHING`,
    [ENTIDADE_ID, TENANT, AGENT],
  );
}

async function mkTurnoVivo(): Promise<Turno> {
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, created_at)
     VALUES ($1,$2,$3,NULL,'in','texto','oi','{}'::jsonb, now())`,
    [mensagem_id, TENANT, AGENT],
  );
  const turn_id = randomUUID();
  const claim_token = randomUUID();
  await pool.query(
    `INSERT INTO agent_turns (id, tenant_id, agent_id, representative_message_id, status,
        claim_token, claimed_by, attempt_count, lease_expires_at)
     VALUES ($1,$2,$3,$4,'running',$5,'worker-1',1, now() + interval '10 minutes')`,
    [turn_id, TENANT, AGENT, mensagem_id, claim_token],
  );
  return { turn_id, claim_token, attempt: 1 };
}

async function mkControle(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO conversation_controls (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id)
     VALUES ($1,$2,$3,$4,1,$5)`,
    [id, TENANT, AGENT, `stream-${id}`, randomUUID()],
  );
  return id;
}

function pedido(run_id: string, turno: Turno, control_id: string) {
  return {
    run_id,
    turn_id: turno.turn_id,
    origin_claim_token: turno.claim_token,
    origin_turn_attempt: turno.attempt,
    origin_worker_id: 'worker-1',
    control_id,
    control_epoch: '0',
    mode: 'live' as const,
    manifest_digest: SHA,
    engine: 'hermes' as const,
    adapter_revision: 'adapter-0.1.0',
    configuration_digest: SHA,
    max_generations: 3,
    request_key: randomUUID(),
    remote_instance_id: 'inst-sc04',
    request_json: { version: 1 },
    request_hash: SHA,
    host_context_json: { version: 1 },
    host_context_hash: SHA,
    deadline_ms: 300_000,
    reconcile_deadline_ms: 900_000,
  };
}

/** Run em `running` — o único estado que libera o dispatcher. */
async function runRodando(turno: Turno, control_id: string): Promise<string> {
  const run_id = randomUUID();
  await noEscopo(() =>
    engineRunsRepo.pinEngineAndPrepareRun(pedido(run_id, turno, control_id)),
  );
  await noEscopo(() =>
    engineRunsRepo.markSubmitting({
      run_id,
      turn_id: turno.turn_id,
      origin_claim_token: turno.claim_token,
      expected_row_version: 0,
    }),
  );
  await noEscopo(() =>
    engineRunsRepo.recordStartObservation({
      run_id,
      turn_id: turno.turn_id,
      origin_claim_token: turno.claim_token,
      observation: { kind: 'accepted', remote_run_id: `w-${randomUUID()}` },
    }),
  );
  return run_id;
}

/** Admite a call e a leva a `dispatching`, devolvendo o token e a versão. */
async function callDispatching(
  turno: Turno,
  run_id: string,
  ordinal: number,
  args: Record<string, unknown>,
): Promise<{ call_id: string; dispatch_token: string; row_version: number }> {
  const call_id = `sc04:${ordinal}:${randomUUID().slice(0, 8)}`;
  const admissao = await noEscopo(() =>
    engineRunsRepo.admitToolCall({
      run_id,
      turn_id: turno.turn_id,
      origin_claim_token: turno.claim_token,
      request_id: randomUUID(),
      call: { call_id, ordinal, iteration: 1, name: 'sc04_fixture', args },
    }),
  );
  expect(admissao.ok).toBe(true);

  const congelou = await noEscopo(() =>
    engineRunsRepo.markToolDispatching({
      run_id,
      turn_id: turno.turn_id,
      origin_claim_token: turno.claim_token,
      call_id,
      expected_row_version: 0,
      classification: CLASSIFICACAO,
    }),
  );
  if (!congelou.ok) throw new Error(`markToolDispatching recusou: ${congelou.reason}`);
  return { call_id, dispatch_token: congelou.dispatch_token, row_version: congelou.row_version };
}

/**
 * O CONTROLE REAL do caminho durável: cada hook chama a operação de banco
 * correspondente. É esta ligação que os testes exercem — e o fence da linha é
 * encadeado (`row_version` devolvida por uma transição é a exigida pela
 * seguinte), como no gateway de produção.
 */
function controleReal(
  turno: Turno,
  run_id: string,
  chamada: { call_id: string; dispatch_token: string; row_version: number },
  over: Partial<{
    call_ordinal: number;
    forcarVersaoDoMarcador: number;
    exigirAprovacao: boolean;
  }> = {},
) {
  let rowVersion = chamada.row_version;
  const estado = { rowVersion: () => rowVersion };
  const base = {
    run_id,
    turn_id: turno.turn_id,
    origin_claim_token: turno.claim_token,
    call_id: chamada.call_id,
  };

  const control = {
    call_id: chamada.call_id,
    call_ordinal: over.call_ordinal ?? 0,
    dispatch_token: chamada.dispatch_token,
    classification: CLASSIFICACAO,
    freezeIdentity: async (candidate: { key: string; payload_hash: string; normalized_args: unknown }) => {
      const r = await noEscopo(() =>
        engineRunsRepo.freezeToolIdentity({
          ...base,
          idempotency_key: candidate.key,
          idempotency_payload_hash: candidate.payload_hash,
          normalized_args: candidate.normalized_args as never,
        }),
      );
      if (!r.ok) throw new Error(`freeze_identity:${r.reason}`);
      if (r.key === undefined || r.payload_hash === undefined) {
        throw new Error('freeze_identity:identidade_persistida_ausente');
      }
      if (r.row_version !== undefined) rowVersion = r.row_version;
      return { key: r.key, payload_hash: r.payload_hash };
    },
    recordApproval: async (input: {
      approval: { request_id: string; ref: string; intent_hash: string; approval_class: string };
      state: 'pending' | 'claimed';
      claim_token: string | null;
    }) => {
      const r = await noEscopo(() =>
        engineRunsRepo.recordToolCallApproval({
          ...base,
          expected_row_version: rowVersion,
          dispatch_token: chamada.dispatch_token,
          approval_request_id: input.approval.request_id,
          approval_claim_token: input.claim_token,
          state: input.state,
        }),
      );
      if (!r.ok) throw new Error(`record_approval:${r.reason}`);
      rowVersion = r.row_version;
    },
    beforeHandler: async (input: {
      reservation_token: string;
      approval_request_id: string | null;
      approval_claim_token: string | null;
    }) => {
      const r = await noEscopo(() =>
        engineRunsRepo.markToolHandlerStarted({
          ...base,
          expected_row_version: over.forcarVersaoDoMarcador ?? rowVersion,
          dispatch_token: chamada.dispatch_token,
          reservation_token: input.reservation_token,
          approval_claim_token: input.approval_claim_token,
          approval_request_id: input.approval_request_id,
        }),
      );
      if (!r.ok) throw new BeforeHandlerError(r.reason === 'already_started');
      rowVersion = r.row_version;
    },
  };
  return { control, estado };
}

function turnContext(signal: AbortSignal, deadlineMs: number): TurnExecutionContext {
  return {
    tenant_id: TENANT,
    agent_id: AGENT,
    turn_id: 'turno-sc04',
    attempt: 1,
    claim_token: 'claim-sc04',
    worker_id: 'worker-1',
    deadline: new Date(Date.now() + deadlineMs),
    signal,
  };
}

async function concederTool(nomes: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO agent_tool_grants (tenant_id, agent_id, granted_packs, granted_tools, granted_by, reason)
     VALUES ($1,$2,'{baseline.core}'::text[], $3::text[], 'test', 'SC04')
     ON CONFLICT ON CONSTRAINT agent_tool_grants_tenant_agent_key
       DO UPDATE SET granted_tools = EXCLUDED.granted_tools, granted_packs = EXCLUDED.granted_packs`,
    [TENANT, AGENT, nomes],
  );
}

type CallRow = {
  state: string;
  effect_evidence: string;
  effect_class: string | null;
  side_effect: string | null;
  idempotency_key: string | null;
  reservation_token: string | null;
  approval_request_id: string | null;
  approval_claim_token: string | null;
  receipt_json: unknown;
  receipt_hash: string | null;
  result_json: unknown;
  handler_started_at: Date | null;
  finished_at: Date | null;
  row_version: number;
};

async function lerCall(run_id: string, call_id: string): Promise<CallRow> {
  const r = await pool.query<CallRow>(
    `SELECT state, effect_evidence, effect_class, side_effect, idempotency_key,
            reservation_token, approval_request_id::text AS approval_request_id,
            approval_claim_token, receipt_json, receipt_hash, result_json,
            handler_started_at, finished_at, row_version
       FROM engine_tool_calls WHERE run_id = $1 AND call_id = $2`,
    [run_id, call_id],
  );
  if (!r.rows[0]) throw new Error(`call não encontrada: ${call_id}`);
  return r.rows[0];
}

async function lerReserva(key: string): Promise<{ state: string; reservation_token: string | null } | undefined> {
  const r = await pool.query<{ state: string; reservation_token: string | null }>(
    'SELECT state, reservation_token FROM idempotency_keys WHERE key = $1',
    [key],
  );
  return r.rows[0];
}

/**
 * A liquidação que o GATEWAY faz em produção, feita aqui pelo teste.
 *
 * A chamada direta ao dispatcher termina em `handler_started`: quem grava o
 * desfecho é o gateway, com o receipt que recebeu (`settleToolCall`). Repetir
 * esse trecho no teste é o que permite afirmar o desfecho NO JOURNAL — sem ele
 * só se mede o receipt em memória, que é justamente o que um crash levaria
 * embora.
 */
async function liquidar(
  turno: Turno,
  run_id: string,
  chamada: { call_id: string; dispatch_token: string },
  estado: { rowVersion: () => number },
  desfecho: DurableDispatchResultV1,
): Promise<void> {
  if (desfecho.kind !== 'settled') return;
  const receipt = desfecho.receipt;
  const l = await noEscopo(() =>
    engineRunsRepo.settleToolCall({
      run_id,
      turn_id: turno.turn_id,
      origin_claim_token: turno.claim_token,
      call_id: chamada.call_id,
      expected_row_version: estado.rowVersion(),
      dispatch_token: chamada.dispatch_token,
      outcome:
        receipt.effect_evidence === 'unknown'
          ? { kind: 'effect_unknown', result: receipt.result }
          : receipt.status === 'error'
            ? { kind: 'denied', result: receipt.result }
            : {
                kind: 'completed',
                result: receipt.result,
                receipt: { json: receipt as never, hash: canonicalDigest(receipt) },
              },
    }),
  );
  expect(l, JSON.stringify(l)).toMatchObject({ ok: true });
}

d('SC04 — despacho durável contra Postgres real', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await seedTenant();
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    fixture.chamadas = 0;
    fixture.resultado = { ok: true, eco: 'oi' };
    fixture.deveLancar = false;
    await concederTool(['sc04_fixture']);
  });

  it('1. positivo: uma execução, receipt íntegro e tokens conferidos com o ledger', async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    // SEM `valor`: um campo `valor` nos args liga o portão financeiro
    // (`evaluateFinancialAuthorization`), que exige vínculo e perfil REAIS — e o
    // sujeito aqui é o journal do despacho, não a autorização financeira.
    const args = { texto: 'oi', nonce: randomUUID() };
    const chamada = await callDispatching(turno, run_id, 0, args);
    const { control, estado } = controleReal(turno, run_id, chamada);

    const out = await despachar(new AbortController().signal, 'sc04_fixture', args, control);

    expect(out.kind).toBe('settled');
    if (out.kind !== 'settled') throw new Error(`esperado settled, veio ${out.kind}`);
    const receipt = out.receipt;
    await liquidar(turno, run_id, chamada, estado, out);

    // ── o receipt ────────────────────────────────────────────────────────
    // O JSON vai como mensagem de propósito: uma falha aqui quase sempre é uma
    // RECUSA, e o código dela (`result.error`) é o que diz qual gate atuou.
    expect(receipt, JSON.stringify(receipt)).toMatchObject({
      call_id: chamada.call_id,
      ordinal: 0,
      name: 'sc04_fixture',
      status: 'success',
      side_effect: 'write',
      effect_class: 'non_interruptible',
      legacy_irreversible_invoked: false,
      effect_evidence: 'committed',
      sensitive: false,
      approval: null,
      pending_question_id: null,
      report: null,
    });
    expect(receipt.started_at).not.toBeNull();
    expect(receipt.finished_at).toMatch(/T/);
    expect(receipt.summary.tool_call_id).toBe(chamada.call_id);

    // ── o journal (a prova durável) ──────────────────────────────────────
    const row = await lerCall(run_id, chamada.call_id);
    expect(row.state).toBe('completed');
    expect(row.effect_evidence).toBe('committed');
    expect(row.effect_class).toBe('non_interruptible');
    expect(row.side_effect).toBe('write');
    expect(row.handler_started_at).not.toBeNull();
    expect(row.finished_at).not.toBeNull();
    expect(row.result_json).toEqual(fixture.resultado);
    // O receipt vai para o journal como PAR json+hash — e o hash é o do
    // conteúdo gravado, não um literal qualquer.
    expect(row.receipt_json).toEqual(receipt);
    expect(row.receipt_hash).toBe(canonicalDigest(receipt));

    // ── tokens REAIS, conferidos contra o ledger ─────────────────────────
    expect(row.idempotency_key).not.toBeNull();
    expect(row.reservation_token).not.toBeNull();
    expect(row.reservation_token).not.toMatch(/^res-/);
    const reserva = await lerReserva(row.idempotency_key!);
    expect(reserva?.state).toBe('completed');
    // O MESMO token: o marcador do journal, o completion do ledger e o que o
    // receipt publicou apontam para a mesma reserva.
    expect(reserva?.reservation_token).toBe(row.reservation_token);
    expect(fixture.chamadas).toBe(1);
  });

  it('2. T26 — a mesma intenção repetida adota o cache e NÃO emite efeito de novo', async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    const args = { texto: 'repetido', nonce: randomUUID() };

    const primeira = await callDispatching(turno, run_id, 0, args);
    const controle1 = controleReal(turno, run_id, primeira);
    const out1 = await despachar(new AbortController().signal, 'sc04_fixture', args, controle1.control);
    expect(out1.kind).toBe('settled');
    expect(fixture.chamadas).toBe(1);
    // A call #0 precisa FECHAR antes de o run admitir a #1: o journal é
    // sequencial por design (`ordinal`), e sem a liquidação a segunda admissão
    // seria recusada — o teste mediria a sequência, não o cache.
    await liquidar(turno, run_id, primeira, controle1.estado, out1);

    const row1 = await lerCall(run_id, primeira.call_id);
    const keyFrozen = row1.idempotency_key!;

    // Segunda chamada do run (outro `call_id`, MESMA intenção): o ledger já tem
    // a reserva `completed` com o mesmo payload — o handler não roda de novo.
    const segunda = await callDispatching(turno, run_id, 1, args);
    const controle2 = controleReal(turno, run_id, segunda, { call_ordinal: 1 });
    const out2 = await despachar(new AbortController().signal, 'sc04_fixture', args, controle2.control);

    expect(fixture.chamadas).toBe(1);
    if (out2.kind !== 'settled') throw new Error(`esperado settled, veio ${out2.kind}`);
    expect(out2.receipt.status).toBe('success');
    expect(out2.receipt.result).toEqual(fixture.resultado);
    await liquidar(turno, run_id, segunda, controle2.estado, out2);

    const row2 = await lerCall(run_id, segunda.call_id);
    expect(row2.idempotency_key).toBe(keyFrozen);
    expect(row2.state).toBe('completed');
    // A adoção de um resultado JÁ PROVADO pelo ledger mantém a evidência no
    // topo: a prova existe, e `none` não volta a ser afirmável (§5.6.2).
    expect(row2.effect_evidence).toBe('committed');

    const n = await pool.query<{ c: string }>(
      'SELECT count(*) AS c FROM idempotency_keys WHERE key = $1',
      [keyFrozen],
    );
    expect(Number(n.rows[0]?.c)).toBe(1);
  });

  it('3. T27 — mesmo `call_id` com args DIFERENTES é `payload_conflict`, e nenhum handler roda', async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    const args = { texto: 'original', nonce: randomUUID() };

    const admissao = await noEscopo(() =>
      engineRunsRepo.admitToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        request_id: randomUUID(),
        call: { call_id: 'sc04:t27', ordinal: 0, iteration: 1, name: 'sc04_fixture', args },
      }),
    );
    expect(admissao.ok).toBe(true);

    const conflito = await noEscopo(() =>
      engineRunsRepo.admitToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        request_id: randomUUID(),
        call: {
          call_id: 'sc04:t27',
          ordinal: 0,
          iteration: 1,
          name: 'sc04_fixture',
          args: { texto: 'OUTRA COISA' },
        },
      }),
    );
    expect(conflito.ok).toBe(false);
    if (!conflito.ok) expect(conflito.reason).toBe('payload_conflict');
    expect(fixture.chamadas).toBe(0);
  });

  it('4. AC02 — retry depois da virada de BUCKET usa a identidade congelada', async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    const args = { texto: 'bucket', nonce: randomUUID() };
    const chamada = await callDispatching(turno, run_id, 0, args);
    const { control } = controleReal(turno, run_id, chamada);

    const k1 = 'k-' + '1'.repeat(60);
    const k2 = 'k-' + '2'.repeat(60); // a chave RECALCULADA depois do bucket
    const hash = 'v2:' + 'd'.repeat(64);
    const primeiro = await control.freezeIdentity({ key: k1, payload_hash: hash, normalized_args: args });
    expect(primeiro.key).toBe(k1);

    // O retry passa a chave recalculada (K2) com o MESMO payload. O repo recusa
    // a troca de identidade — e devolve o payload persistido, que é o que
    // permite ao gateway distinguir "relógio andou" de "intenção mudou".
    const recusado = await noEscopo(() =>
      engineRunsRepo.freezeToolIdentity({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id: chamada.call_id,
        idempotency_key: k2,
        idempotency_payload_hash: hash,
        normalized_args: args as never,
      }),
    );
    expect(recusado.ok).toBe(false);
    if (!recusado.ok && recusado.reason === 'identity_conflict') {
      expect(recusado.current_idempotency_key).toBe(k1);
      expect(recusado.current_idempotency_payload_hash).toBe(hash);
    } else {
      throw new Error('esperado identity_conflict');
    }

    // E a identidade gravada continua sendo a PRIMEIRA: o conflito não escreve.
    const row = await lerCall(run_id, chamada.call_id);
    expect(row.idempotency_key).toBe(k1);

    // Retry com a MESMA identidade é no-op (replay), e não uma segunda escrita.
    const replay = await control.freezeIdentity({ key: k1, payload_hash: hash, normalized_args: args });
    expect(replay.key).toBe(k1);
    const row2 = await lerCall(run_id, chamada.call_id);
    expect(row2.row_version).toBe(row.row_version);
  });

  it('5. AC03 — `recordToolCallApproval` grava o UUID/claim REAIS, e o fence recusa o resto', async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    const args = { texto: 'aprovacao', nonce: randomUUID() };

    // ── pedido PENDENTE: a call termina em `approval_required` ───────────
    const pendente = await callDispatching(turno, run_id, 0, args);
    const request_id = randomUUID();
    await pool.query(
      `INSERT INTO approval_requests
         (id, tenant_id, agent_id, requester_pessoa_id, entidade_id, conversa_id, mensagem_id,
          request_id, tool, operation_type, intent_payload, intent_hash, intent_hash_version,
          approval_class, required_approvals, status, fingerprint, expires_at)
       VALUES ($1,$2,$3,$4,NULL,$5,NULL,$6,'sc04_fixture','create','{}'::jsonb,$7,1,
               'single_confirmation',1,'pending',$8, now() + interval '1 hour')`,
      [request_id, TENANT, AGENT, ctx.pessoa.id, ctx.conversa.id, ctx.request_id, randomUUID(), randomUUID()],
    );

    const r1 = await noEscopo(() =>
      engineRunsRepo.recordToolCallApproval({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id: pendente.call_id,
        expected_row_version: pendente.row_version,
        dispatch_token: pendente.dispatch_token,
        approval_request_id: request_id,
        approval_claim_token: null,
        state: 'pending',
      }),
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.state).toBe('approval_required');

    const linhaPendente = await lerCall(run_id, pendente.call_id);
    // O UUID COMPLETO (não o `ref` truncado) é o que fica no journal — é ele
    // que a FK e a auditoria usam.
    expect(linhaPendente.approval_request_id).toBe(request_id);
    expect(linhaPendente.state).toBe('approval_required');
    expect(linhaPendente.finished_at).not.toBeNull();
    expect(linhaPendente.result_json).toMatchObject({ error: 'approval_required' });
    expect(linhaPendente.effect_evidence).toBe('none');

    // ── pedido CONSUMIDO (claimed): a call CONTINUA em `dispatching` ─────
    const reclamada = await callDispatching(turno, run_id, 1, { ...args, texto: 'claimed' });
    const request_id2 = randomUUID();
    // `claim_token` é NOT NULL para `status='claimed'` (CHECK da 095): a linha
    // tem de nascer no estado que ela afirma.
    const claim_token = randomUUID();
    await pool.query(
      `INSERT INTO approval_requests
         (id, tenant_id, agent_id, requester_pessoa_id, entidade_id, conversa_id, mensagem_id,
          request_id, tool, operation_type, intent_payload, intent_hash, intent_hash_version,
          approval_class, required_approvals, status, claim_token, fingerprint, expires_at)
       VALUES ($1,$2,$3,$4,NULL,$5,NULL,$6,'sc04_fixture','create','{}'::jsonb,$7,1,
               'single_confirmation',1,'claimed',$8,$9, now() + interval '1 hour')`,
      [
        request_id2,
        TENANT,
        AGENT,
        ctx.pessoa.id,
        ctx.conversa.id,
        ctx.request_id,
        randomUUID(),
        claim_token,
        randomUUID(),
      ],
    );
    const r2 = await noEscopo(() =>
      engineRunsRepo.recordToolCallApproval({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id: reclamada.call_id,
        expected_row_version: reclamada.row_version,
        dispatch_token: reclamada.dispatch_token,
        approval_request_id: request_id2,
        approval_claim_token: claim_token,
        state: 'claimed',
      }),
    );
    expect(r2.ok).toBe(true);
    const linhaClaimed = await lerCall(run_id, reclamada.call_id);
    expect(linhaClaimed.state).toBe('dispatching');
    expect(linhaClaimed.approval_request_id).toBe(request_id2);
    expect(linhaClaimed.approval_claim_token).toBe(claim_token);

    // ── o fence: token errado, versão velha e estado terminal ────────────
    const tokenErrado = await noEscopo(() =>
      engineRunsRepo.recordToolCallApproval({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id: reclamada.call_id,
        expected_row_version: linhaClaimed.row_version,
        dispatch_token: randomUUID(),
        approval_request_id: request_id2,
        approval_claim_token: claim_token,
        state: 'claimed',
      }),
    );
    expect(tokenErrado.ok).toBe(false);
    if (!tokenErrado.ok) expect(tokenErrado.reason).toBe('dispatch_token_mismatch');

    const versaoVelha = await noEscopo(() =>
      engineRunsRepo.recordToolCallApproval({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id: reclamada.call_id,
        expected_row_version: linhaClaimed.row_version + 99,
        dispatch_token: reclamada.dispatch_token,
        approval_request_id: request_id2,
        approval_claim_token: claim_token,
        state: 'claimed',
      }),
    );
    expect(versaoVelha.ok).toBe(false);
    if (!versaoVelha.ok) expect(versaoVelha.reason).toBe('version_conflict');

    const jaTerminal = await noEscopo(() =>
      engineRunsRepo.recordToolCallApproval({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id: pendente.call_id,
        expected_row_version: 99,
        dispatch_token: pendente.dispatch_token,
        approval_request_id: request_id,
        approval_claim_token: null,
        state: 'pending',
      }),
    );
    expect(jaTerminal.ok).toBe(false);
    if (!jaTerminal.ok) expect(jaTerminal.reason).toBe('state_conflict');
  });

  it('6. AC05 — marcador recusado impede o handler e devolve `journal_unavailable`', async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    const args = { texto: 'marcador-recusado', nonce: randomUUID() };
    const chamada = await callDispatching(turno, run_id, 0, args);

    // O marcador é recusado com uma versão STALE — o mesmo `version_conflict`
    // que um fence perdido produz no banco.
    const { control } = controleReal(turno, run_id, chamada, {
      forcarVersaoDoMarcador: chamada.row_version + 41,
    });

    const out = await despachar(new AbortController().signal, 'sc04_fixture', args, control);

    expect(out).toEqual({ kind: 'journal_unavailable', handler_may_have_started: false });
    expect(fixture.chamadas).toBe(0);

    // O handler não começou: a reserva foi ABANDONADA (não 'failed', que é
    // terminal e negaria serviço ao dono legítimo).
    const row = await lerCall(run_id, chamada.call_id);
    expect(row.handler_started_at).toBeNull();
    expect(row.receipt_json).toBeNull();
    const reserva = await lerReserva(row.idempotency_key!);
    expect(reserva).toBeUndefined();
  });

  it('7. AC05 — posse perdida não produz receipt nem efeito', async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    const args = { texto: 'posse-perdida', nonce: randomUUID() };
    const chamada = await callDispatching(turno, run_id, 0, args);
    const { control } = controleReal(turno, run_id, chamada);

    const controller = new AbortController();
    controller.abort(new Error('turn.lease_lost:token_mismatch'));

    const out = await despachar(controller.signal, 'sc04_fixture', args, control);

    expect(out).toEqual({ kind: 'ownership_lost' });
    expect(fixture.chamadas).toBe(0);
    const row = await lerCall(run_id, chamada.call_id);
    expect(row.handler_started_at).toBeNull();
    expect(row.state).toBe('dispatching');
    // Nenhuma reserva foi criada: a identidade não foi congelada, e nenhum
    // recurso ficou preso contra quem TEM a lease.
    expect(row.idempotency_key).toBeNull();
  });

  it('8. AC08 — recusa antes do handler liquida como `denied`, e `completed` a partir de `dispatching` é recusado', async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    const args = { texto: 'governanca', nonce: randomUUID() };
    const negada = await callDispatching(turno, run_id, 0, args);

    const l1 = await noEscopo(() =>
      engineRunsRepo.settleToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id: negada.call_id,
        expected_row_version: negada.row_version,
        dispatch_token: negada.dispatch_token,
        outcome: { kind: 'denied', result: { error: 'tool_not_granted' } },
      }),
    );
    expect(l1.ok).toBe(true);
    const rowNegada = await lerCall(run_id, negada.call_id);
    expect(rowNegada.state).toBe('denied');
    // Sem carimbo de início, `none` vem do ESTADO — nada rodou, então nenhuma
    // classe pode afirmar `possible`.
    expect(rowNegada.effect_evidence).toBe('none');
    expect(rowNegada.result_json).toEqual({ error: 'tool_not_granted' });

    // A MESMA situação com `completed` seria afirmar algo sobre um handler que
    // não rodou: recusado.
    const outra = await callDispatching(turno, run_id, 1, { ...args, texto: 'outra' });
    const l2 = await noEscopo(() =>
      engineRunsRepo.settleToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id: outra.call_id,
        expected_row_version: outra.row_version,
        dispatch_token: outra.dispatch_token,
        outcome: { kind: 'completed', result: { ok: true }, receipt: null },
      }),
    );
    expect(l2.ok).toBe(false);
    if (!l2.ok) expect(l2.reason).toBe('state_conflict');
    const rowOutra = await lerCall(run_id, outra.call_id);
    expect(rowOutra.state).toBe('dispatching');
    expect(rowOutra.effect_evidence).toBe('none');
  });

  it('9. AC07 — crash DEPOIS do marcador mantém `unknown`: sem retry cego, com reconciliação', async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    const args = { texto: 'efeito-desconhecido', nonce: randomUUID() };
    const chamada = await callDispatching(turno, run_id, 0, args);
    const { control } = controleReal(turno, run_id, chamada);

    // O handler lança DEPOIS de o marcador existir: é o T13 (worker morre
    // durante uma tool de escrita). O desfecho tem de ser `effect_unknown`.
    fixture.deveLancar = true;
    const out = await despachar(new AbortController().signal, 'sc04_fixture', args, control);
    expect(fixture.chamadas).toBe(1);

    if (out.kind !== 'settled') throw new Error(`esperado settled, veio ${out.kind}`);
    expect(out.receipt.effect_evidence).toBe('unknown');
    expect(out.receipt.status).toBe('error');

    const antesDoSettle = await lerCall(run_id, chamada.call_id);
    const l = await noEscopo(() =>
      engineRunsRepo.settleToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id: chamada.call_id,
        expected_row_version: antesDoSettle.row_version,
        dispatch_token: chamada.dispatch_token,
        outcome: { kind: 'effect_unknown', result: { error: 'effect_unknown' } },
      }),
    );
    expect(l.ok).toBe(true);
    const row = await lerCall(run_id, chamada.call_id);
    expect(row.state).toBe('effect_unknown');
    expect(row.effect_evidence).toBe('unknown');

    // A evidência NUNCA regride: liquidar `denied` por cima seria afirmar
    // ausência de efeito sobre algo que pode ter acontecido (a 140 tem trigger
    // para isso; aqui a afirmação é recusada antes do banco).
    const regressao = await noEscopo(() =>
      engineRunsRepo.settleToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id: chamada.call_id,
        expected_row_version: row.row_version,
        dispatch_token: chamada.dispatch_token,
        outcome: { kind: 'denied', result: { error: 'nada' } },
      }),
    );
    expect(regressao.ok).toBe(false);
  });
});

/**
 * ─── O CAMINHO OBSERVÁVEL DO CARD, ponta a ponta ────────────────────────────
 *
 * O bloco acima exercita o CORPO do despacho com um controle montado pelo
 * teste. O contrato do card (SC04, "interface observável") nomeia uma fronteira
 * mais larga: EngineToolGateway → dispatchToolDurable → corpo único →
 * repos. Sem atravessá-la, um defeito de COSTURA — o gateway congelar a
 * identidade de idempotência ANTES do corpo e o corpo congelar de novo com a
 * chave real — fica invisível: cada lado passa o próprio teste enquanto o
 * caminho real não despacha nada (a segunda trava responde `identity_conflict`
 * e a chamada morre em `dispatching`, com zero handlers).
 *
 * Aqui não há dublê de costura: o gateway é o de PRODUÇÃO
 * (`createEngineToolGateway`), os repositórios são os reais e `dispatchDurable`
 * é o `dispatchToolDurable` real. O único double continua sendo o REGISTRY com
 * a tool contadora, como no bloco anterior.
 */
type EventosGateway = {
  freezes: Array<{ idempotency_key: string; idempotency_payload_hash: string }>;
  marcadores: Array<{ reservation_token: string; dispatch_token: string }>;
  settles: Array<{ kind: string; receipt?: unknown }>;
};

/**
 * O gateway de produção ligado aos repos reais.
 *
 * `over` existe para os cenários de FALHA de hook (o gateway continua sendo o
 * real; quem é substituído é o `dispatchDurable`/a dep sob sabotagem), nunca
 * para atalhar a costura que este bloco mede.
 */
function gatewayReal(
  turno: Turno,
  run_id: string,
  over: Partial<ToolGatewayDepsV1> = {},
): { invoke: (call: EngineToolCallV1) => Promise<EngineToolReplyV1>; eventos: EventosGateway } {
  const eventos: EventosGateway = { freezes: [], marcadores: [], settles: [] };

  const deps: ToolGatewayDepsV1 = {
    decide: () => ({ kind: 'admit', tool: {} as never }),
    classify: () => CLASSIFICACAO,
    admit: (i) => noEscopo(() => engineRunsRepo.admitToolCall(i)),
    markDispatching: (i) => noEscopo(() => engineRunsRepo.markToolDispatching(i)) as never,
    freezeToolIdentity: async (i) => {
      eventos.freezes.push({
        idempotency_key: i.idempotency_key,
        idempotency_payload_hash: i.idempotency_payload_hash,
      });
      return noEscopo(() => engineRunsRepo.freezeToolIdentity(i));
    },
    markToolHandlerStarted: async (i) => {
      eventos.marcadores.push({
        reservation_token: i.reservation_token,
        dispatch_token: i.dispatch_token,
      });
      return noEscopo(() => engineRunsRepo.markToolHandlerStarted(i));
    },
    settle: async (i) => {
      eventos.settles.push(i.outcome as { kind: string; receipt?: unknown });
      return noEscopo(() => engineRunsRepo.settleToolCall(i)) as never;
    },
    dispatch: async () => ({ error: 'caminho_legado_nao_esperado' }),
    buildToolContext: async () => ctx as never,
    recordToolApproval: (i) => noEscopo(() => engineRunsRepo.recordToolCallApproval(i)) as never,
    dispatchDurable: (input, control) =>
      noEscopo(() =>
        runWithTurnExecution(turnContext(new AbortController().signal, 60_000), () =>
          dispatchToolDurable(input, control),
        ),
      ),
    ...over,
  };

  const invoke = createEngineToolGateway(
    {
      run_id,
      turn_id: turno.turn_id,
      origin_claim_token: turno.claim_token,
      request_id: randomUUID(),
    },
    deps,
  );

  return { invoke, eventos };
}

function chamadaGw(run_id: string, call_id: string, args: Record<string, unknown>): EngineToolCallV1 {
  return { version: 1, run_id, call_id, ordinal: 0, iteration: 1, name: 'sc04_fixture', args } as EngineToolCallV1;
}

d('SC04 — o gateway de produção ponta a ponta (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await seedTenant();
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    fixture.chamadas = 0;
    fixture.resultado = { ok: true, eco: 'oi' };
    fixture.deveLancar = false;
    await concederTool(['sc04_fixture']);
  });

  it('AC01/AC03/AC04/AC07 — o corpo despacha pelo gateway: 1 handler, receipt e tokens reais', async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    // Resultado com material INTERNO (`path`/`fileName`): é o que separa o
    // `result` protegido do `result_for_engine` projetado.
    fixture.resultado = { ok: true, path: '/interno/boleto.pdf', fileName: 'boleto.pdf' };
    const args = { texto: 'gateway-e2e', nonce: randomUUID() };
    const call_id = `sc04:gw:${randomUUID().slice(0, 8)}`;
    const { invoke, eventos } = gatewayReal(turno, run_id);

    const reply = await invoke(chamadaGw(run_id, call_id, args));

    // ── a chamada FOI despachada (o defeito de costura matava isso aqui) ────
    expect(reply, JSON.stringify(reply)).toMatchObject({
      kind: 'result',
      call_id,
      is_error: false,
    });
    expect(fixture.chamadas).toBe(1);

    // ── a identidade é a REAL, congelada UMA vez, pelo CORPO ───────────────
    // Um segundo congelamento com outra chave (o `(4a)` do gateway) é
    // exatamente o defeito que esta asserção prende.
    expect(eventos.freezes).toHaveLength(1);
    expect(eventos.freezes[0]!.idempotency_key).not.toBe(call_id);
    // A chave é o sha256 de `computeIdempotencyKey` (com bucket de tempo) e o
    // payload hash é o de `computePayloadHash` — o versionado `v2:`. Nenhum dos
    // dois é o `call_id`/`canonicalDigest(args)` do passo legado.
    expect(eventos.freezes[0]!.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
    expect(eventos.freezes[0]!.idempotency_payload_hash).toMatch(/^v2:[0-9a-f]{64}$/);

    // ── o marcador recebeu a RESERVA real, não `res-<call_id>` ─────────────
    expect(eventos.marcadores).toHaveLength(1);
    expect(eventos.marcadores[0]!.reservation_token).not.toBe(`res-${call_id}`);

    const row = await lerCall(run_id, call_id);
    expect(row.state).toBe('completed');
    expect(row.effect_evidence).toBe('committed');
    expect(row.handler_started_at).not.toBeNull();
    expect(row.finished_at).not.toBeNull();
    expect(row.idempotency_key).toBe(eventos.freezes[0]!.idempotency_key);
    expect(row.reservation_token).toBe(eventos.marcadores[0]!.reservation_token);
    expect(row.reservation_token).not.toMatch(/^res-/);

    // A chave e o token do journal são os MESMOS do ledger: o journal do
    // despacho e o ledger de idempotência apontam para a mesma reserva.
    const reserva = await lerReserva(row.idempotency_key!);
    expect(reserva?.state).toBe('completed');
    expect(reserva?.reservation_token).toBe(row.reservation_token);

    // ── o receipt ficou no journal; o motor recebeu só a PROJEÇÃO ──────────
    const receipt = row.receipt_json as {
      call_id: string;
      status: string;
      effect_evidence: string;
      result: Record<string, unknown>;
      result_for_engine: Record<string, unknown>;
    };
    expect(receipt).toMatchObject({
      call_id,
      status: 'success',
      effect_evidence: 'committed',
    });
    expect(receipt.result).toEqual(fixture.resultado);
    expect(receipt.result_for_engine).toEqual({ ok: true });
    expect(row.receipt_hash).toBe(canonicalDigest(row.receipt_json));
    expect(reply.kind === 'result' ? reply.result : null).toEqual(receipt.result_for_engine);
    expect(JSON.stringify(reply)).not.toContain('/interno/boleto.pdf');

    // A liquidação foi a do GATEWAY, com o receipt — não uma recusa.
    expect(eventos.settles).toHaveLength(1);
    expect(eventos.settles[0]!.kind).toBe('completed');
  });

  it('AC05/AC08 — recusa comprovada ANTES do handler não deixa a call presa em `dispatching`', async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    const args = { texto: 'gateway-marcador-recusado', nonce: randomUUID() };
    const call_id = `sc04:gw:${randomUUID().slice(0, 8)}`;

    // O hook do marcador recusa ANTES do efeito (`BeforeHandlerError(false)`):
    // é o desfecho `journal_unavailable` com `handler_may_have_started: false`
    // que o corpo produz para uma recusa tipada de fence.
    const { invoke, eventos } = gatewayReal(turno, run_id, {
      dispatchDurable: (input, control) =>
        noEscopo(() =>
          runWithTurnExecution(turnContext(new AbortController().signal, 60_000), () =>
            dispatchToolDurable(input, {
              ...control,
              beforeHandler: async () => {
                throw new BeforeHandlerError(false);
              },
            }),
          ),
        ),
    });

    const reply = await invoke(chamadaGw(run_id, call_id, args));

    expect(reply).toEqual({ kind: 'refused', call_id, code: 'run_not_authorized' });
    expect(fixture.chamadas).toBe(0);

    // A call NÃO fica em `dispatching`: sem isso ela ocupa a vaga sequencial do
    // run para sempre, e o desfecho honesto do que não rodou é `denied`/`none`.
    const row = await lerCall(run_id, call_id);
    expect(row.state).toBe('denied');
    expect(row.effect_evidence).toBe('none');
    expect(row.handler_started_at).toBeNull();
    expect(row.receipt_json).toBeNull();
    expect(eventos.settles).toHaveLength(1);
    expect(eventos.settles[0]!.kind).toBe('denied');
  });
});