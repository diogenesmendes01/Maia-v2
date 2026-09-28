/**
 * SC05 (§5.3.2, §5.4.2, §5.5.1, §5.5.2, §5.10.3/L1406) — approval e pendência
 * como MÁQUINAS TERMINAIS, contra Postgres REAL.
 *
 * ─── A frase que este arquivo torna executável ──────────────────────────────
 *
 * §5.5.1: «journal registra approval UUID completo, hash, classe e resposta do
 * dispatcher. `approval_required` é estado TERMINAL da chamada recusada, não
 * estado de espera de `agent_turns`» e «aprovar não reanima o run antigo: nova
 * mensagem solicitando a operação cria novo turno; approval consumida ou
 * execução incerta não é reutilizada».
 *
 * ─── O que é REAL aqui, e o que é double ────────────────────────────────────
 *
 * REAL: o banco (journal `engine_tool_calls`/`engine_runs`, `approval_requests`/
 * `approval_decisions`, `pending_questions`, ledger de idempotência), o CORPO do
 * dispatcher (`_dispatcher.ts`, o mesmo do caminho legado), o gateway de
 * produção (`createEngineToolGateway`), os repositórios de engine, de aprovação
 * e de pendências, e as transições de fence (`row_version` + `dispatch_token`).
 *
 * DOUBLE (um só, declarado): o REGISTRY, com duas tools fixture cujo handler
 * conta chamadas — é o que mede «quantas vezes o efeito foi emitido» sem
 * depender de um efeito externo. A autorização (`canAct`/`constitutionalCheck`)
 * também é atravessada por double: as duas checagens têm suíte própria e deixá-
 * las reais aqui só mediria a ausência de vínculos da fixture. O ledger, o
 * journal e as máquinas de aprovação/pendência NÃO são dublados.
 *
 * ─── O que cada caso prende ─────────────────────────────────────────────────
 *
 *  1. `approval_required` é TERMINAL e carrega PROVA de ledger — o UUID completo
 *     do pedido e o `intent_hash`, não o `AP-xxxxxxxx` truncado —, e não ocupa a
 *     vaga sequencial do run (o run não fica esperando humano) (AC01/AC02).
 *  2. O MESMO callback devolve a MESMA recusa, ANTES e DEPOIS de a aprovação
 *     virar `approved`, com zero handlers: aprovar não reanima a call recusada
 *     (AC02 / SPEC-L1406).
 *  3. Nova mensagem ⇒ novo turno/call revalida requester/payload/approval e
 *     executa UMA vez; a evidência é consumida e NÃO se reutiliza (AC03).
 *  4. Denied/consumed/vencida e payload/requester alterados não herdam a
 *     evidência: o caminho honesto é um pedido NOVO (AC03 / SPEC-L1406).
 *  5. O claim de aprovação só volta com PROVA de não início no journal; com
 *     carimbo de início ele é terminal (`execution_failed`) e TTL não libera
 *     efeito (AC04). A política pura de recovery concorda com o banco.
 *  6. Pergunta REAL é provada (mesma conversa, aberta, no prazo) e só então
 *     sobe; expirada ou de OUTRA conversa é suprimida do output, sem ressuscitar
 *     poll nem tocar a máquina de pendências (AC01/AC05/AC06).
 *
 * Skipped sem `TEST_DB_URL`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { engineRunsRepo } from '@/db/repositories/engine-repos.js';

/**
 * O gate do banco é EXPLÍCITO, e não um `describe.skip` silencioso: uma rodada
 * que não tocou o banco uma única vez não pode parecer verde (§5.10.3 exige
 * prova em banco real). Exige `TEST_DB_URL` apontando para o servidor LOCAL do
 * card e recusa qualquer coisa que cheire a produção.
 */
const DB_URL = process.env.TEST_DB_URL ?? '';
const SHOULD_RUN =
  DB_URL.length > 0 && /(^|\/\/|@)(127\.0\.0\.1|localhost):\d+\//.test(DB_URL) && !/prod/i.test(DB_URL);
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 'hermes-sc05-tenant';
const AGENT = 'hermes-sc05-agent';
const SHA = 'b'.repeat(64);

/** Ids FIXOS: `pessoas` tem UNIQUE (tenant, agent, telefone) e ids estáveis
 * tornam o `ON CONFLICT DO NOTHING` o no-op que se quer entre execuções. */
const PESSOA_ID = '33333333-3333-4333-8333-333333333333';
const PESSOA2_ID = '44444444-4444-4444-8444-444444444444';
const ENTIDADE_ID = '55555555-5555-4555-8555-555555555555';

const CLASS = 'two_distinct_owners';
const CLASSIFICACAO = {
  side_effect: 'write' as const,
  effect_class: 'non_interruptible' as const,
  sensitive: false,
  legacy_irreversible_invoked: false,
};

/** Contadores dos handlers — o que mede «o efeito foi emitido?» (§5.5.1). */
const { fixture } = vi.hoisted(() => ({
  fixture: {
    contraparte: 0,
    pendencia: 0,
    lancar: false,
    resultadoContraparte: { ok: true, contraparte_id: 'c-1' } as unknown,
  },
}));

/** Estado das pendências que a fixture cria/devolve (por cenário). */
const pendenciaCtl = {
  /** `null` = a fixture CRIA uma pergunta real; id = devolve um id existente. */
  devolverId: null as string | null,
  /** Conversa em que a fixture cria a pergunta (default: a do contexto). */
  conversaDaCriacao: null as string | null,
  expiraEmPassado: false,
};

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
      /**
       * A MESMA fixture sob o nome que o catálogo de operações críticas
       * (`requiresDualApproval`) classifica como exigindo aprovação DUPLA: é o
       * que faz o CORPO do dispatcher parar em `approval_required` com o pedido
       * REAL aberto — nenhum caminho paralelo de aprovação existe aqui.
       */
      create_contraparte: {
        name: 'create_contraparte',
        description: 'fixture SC05 — operação crítica com aprovação dupla',
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
          fixture.contraparte += 1;
          if (fixture.lancar) throw new Error('handler fixture explodiu pós-marcador');
          return fixture.resultadoContraparte;
        },
      },
      ask_pending_question: {
        name: 'ask_pending_question',
        description: 'fixture SC05 — pergunta pendente real',
        input_schema: passthrough,
        output_schema: passthrough,
        required_actions: [],
        side_effect: 'communication',
        effect_class: 'non_interruptible',
        sensitive: false,
        redis_required: false,
        operation_type: 'create',
        audit_action: 'pending_created',
        feature_flag: undefined,
        handler: async (args: unknown, c: { conversa: { id: string }; pessoa: { id: string } }) => {
          fixture.pendencia += 1;
          const opcoes = [
            { key: 'sim', label: 'Sim' },
            { key: 'nao', label: 'Não' },
          ];
          if (pendenciaCtl.devolverId !== null) {
            return { pending_question_id: pendenciaCtl.devolverId, opcoes_count: 2, opcoes_validas: opcoes };
          }
          void args;
          return await criarPendencia(
            pendenciaCtl.conversaDaCriacao ?? c.conversa.id,
            c.pessoa.id,
            opcoes,
            pendenciaCtl.expiraEmPassado,
          );
        },
      },
    },
    isToolEnabled: () => true,
  };
});

import { dispatchToolDurable } from '@/tools/_dispatcher.js';
import { createEngineToolGateway } from '@/integrations/hermes/tool-gateway.js';
import { runWithTurnExecution } from '@/runtime/turns/execution-context.js';
import { claimExecutableApproval } from '@/governance/approval-requests.js';
import { approvalRequestsRepo } from '@/db/repositories/approval-repos.js';
import { pendingQuestionsRepo } from '@/db/repositories/conversation-repos.js';
import { classifyApprovalClaimRecovery } from '@/runtime/engines/recovery.js';
import type { TurnExecutionContext } from '@/runtime/turns/claim.js';
import type { EngineToolCallV1, EngineToolReplyV1 } from '@/runtime/engines/contracts.js';
import type { ToolGatewayDepsV1 } from '@/integrations/hermes/tool-gateway.js';
import type { Pessoa, Conversa } from '@/db/schema.js';

let pool: pg.Pool;

const noEscopo = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, fn);

type Turno = { turn_id: string; claim_token: string; attempt: number };

const pessoaBase = {
  id: PESSOA_ID,
  nome: 'Fulana SC05',
  /**
   * `funcionario` NÃO é dono (`isOwnerType` = dono|co_dono), então a classe do
   * pedido é `two_distinct_owners` — a única que exige DUAS assinaturas de
   * owners distintos e que o requester não assina sozinho. É a classe que deixa
   * o pedido `pending` de verdade, sem auto-assinatura na criação, e é ela que
   * o caso 1 confere contra o banco.
   */
  tipo: 'funcionario',
  status: 'ativa',
} as unknown as Pessoa;

/**
 * Conversa REAL do tenant: `conversas` é referenciada por FK em
 * `pending_questions`, `mensagens` e `audit_log` — uma conversa inventada faz o
 * handler de pendência violar a FK e o desfecho virar `effect_unknown`, que é
 * exatamente o que aconteceu na primeira versão deste arquivo. O contexto usa
 * uma conversa que EXISTE.
 */
async function mkConversa(pessoa_id = PESSOA_ID): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO conversas (id, tenant_id, agent_id, pessoa_id, escopo_entidades, status)
     VALUES ($1,$2,$3,$4,ARRAY[$5::uuid],'ativa')`,
    [id, TENANT, AGENT, pessoa_id, ENTIDADE_ID],
  );
  return id;
}

type CtxFalso = {
  pessoa: Pessoa;
  scope: { entidades: string[]; byEntity: Map<string, unknown> };
  conversa: Conversa;
  mensagem_id: string;
  request_id: string;
};

let ctxBase!: CtxFalso;

/** Contexto com OUTRA conversa (pendência cross-conversa). */
function ctxComConversa(conversa_id: string) {
  return { ...ctxBase, conversa: { id: conversa_id } as unknown as Conversa };
}

async function seedTenant(): Promise<void> {
  await pool.query('INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING', [
    TENANT,
  ]);
  await pool.query(
    'INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING',
    [AGENT, TENANT],
  );
  // `pessoas`/`entidades` são FKs REAIS do ledger de idempotência: o caminho
  // durável não pode ser medido com ids inventados.
  await pool.query(
    `INSERT INTO pessoas (id, tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
     VALUES ($1, $2, $3, 'Fulana SC05', '+551****0888', 'funcionario', 'ativa')
     ON CONFLICT (id) DO NOTHING`,
    [PESSOA_ID, TENANT, AGENT],
  );
  await pool.query(
    `INSERT INTO pessoas (id, tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
     VALUES ($1, $2, $3, 'Beltrano SC05', '+551****0999', 'funcionario', 'ativa')
     ON CONFLICT (id) DO NOTHING`,
    [PESSOA2_ID, TENANT, AGENT],
  );
  await pool.query(
    `INSERT INTO entidades (id, tenant_id, agent_id, nome, tipo, status)
     VALUES ($1, $2, $3, 'Entidade SC05', 'pj', 'ativa')
     ON CONFLICT (id) DO NOTHING`,
    [ENTIDADE_ID, TENANT, AGENT],
  );
}

async function concederTool(nomes: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO agent_tool_grants (tenant_id, agent_id, granted_packs, granted_tools, granted_by, reason)
     VALUES ($1,$2,'{baseline.core}'::text[], $3::text[], 'test', 'SC05')
     ON CONFLICT ON CONSTRAINT agent_tool_grants_tenant_agent_key
       DO UPDATE SET granted_tools = EXCLUDED.granted_tools, granted_packs = EXCLUDED.granted_packs`,
    [TENANT, AGENT, nomes],
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
    remote_instance_id: 'inst-sc05',
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
  await noEscopo(() => engineRunsRepo.pinEngineAndPrepareRun(pedido(run_id, turno, control_id)));
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

function turnContext(signal: AbortSignal, deadlineMs: number): TurnExecutionContext {
  return {
    tenant_id: TENANT,
    agent_id: AGENT,
    turn_id: 'turno-sc05',
    attempt: 1,
    claim_token: 'claim-sc05',
    worker_id: 'worker-1',
    deadline: new Date(Date.now() + deadlineMs),
    signal,
  };
}

type EventosGateway = {
  settles: Array<{ kind: string }>;
};

/**
 * O gateway de PRODUÇÃO ligado aos repositórios REAIS.
 *
 * `over` existe para os cenários que substituem UMA dep do contrato (a prova de
 * pendência, a decisão estática do broker), nunca para atalhar a costura que
 * este arquivo mede.
 */
function gatewayReal(
  turno: Turno,
  run_id: string,
  opts: { over?: Partial<ToolGatewayDepsV1>; ctx?: typeof ctxBase } = {},
): { invoke: (call: EngineToolCallV1) => Promise<EngineToolReplyV1>; eventos: EventosGateway } {
  const eventos: EventosGateway = { settles: [] };
  const ctxDoCenario = opts.ctx ?? ctxBase;

  const deps: ToolGatewayDepsV1 = {
    decide: () => ({ kind: 'admit', tool: {} as never }),
    classify: () => CLASSIFICACAO,
    admit: (i) => noEscopo(() => engineRunsRepo.admitToolCall(i)),
    markDispatching: (i) => noEscopo(() => engineRunsRepo.markToolDispatching(i)) as never,
    freezeToolIdentity: (i) => noEscopo(() => engineRunsRepo.freezeToolIdentity(i)),
    markToolHandlerStarted: (i) => noEscopo(() => engineRunsRepo.markToolHandlerStarted(i)) as never,
    settle: async (i) => {
      eventos.settles.push(i.outcome as { kind: string });
      return noEscopo(() => engineRunsRepo.settleToolCall(i)) as never;
    },
    dispatch: async () => ({ error: 'caminho_legado_nao_esperado' }),
    buildToolContext: async () => ctxDoCenario as never,
    recordToolApproval: (i) => noEscopo(() => engineRunsRepo.recordToolCallApproval(i)) as never,
    dispatchDurable: (input, control) =>
      noEscopo(() =>
        runWithTurnExecution(turnContext(new AbortController().signal, 60_000), () =>
          dispatchToolDurable(input, control),
        ),
      ),
    ...opts.over,
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

function chamadaGw(
  run_id: string,
  call_id: string,
  args: Record<string, unknown>,
  ordinal = 0,
  nome = 'create_contraparte',
): EngineToolCallV1 {
  return { version: 1, run_id, call_id, ordinal, iteration: 1, name: nome, args } as EngineToolCallV1;
}

type CallRow = {
  state: string;
  effect_evidence: string;
  effect_class: string | null;
  side_effect: string | null;
  approval_request_id: string | null;
  approval_claim_token: string | null;
  result_json: unknown;
  receipt_json: unknown;
  handler_started_at: Date | null;
  finished_at: Date | null;
  row_version: number;
};

async function lerCall(run_id: string, call_id: string): Promise<CallRow> {
  const r = await pool.query<CallRow>(
    `SELECT state, effect_evidence, effect_class, side_effect,
            approval_request_id::text AS approval_request_id, approval_claim_token,
            result_json, receipt_json, handler_started_at, finished_at, row_version
       FROM engine_tool_calls WHERE run_id = $1 AND call_id = $2`,
    [run_id, call_id],
  );
  if (!r.rows[0]) throw new Error(`call não encontrada: ${call_id}`);
  return r.rows[0];
}

type ApprovalRow = {
  id: string;
  status: string;
  fingerprint: string;
  intent_hash: string;
  approval_class: string;
  required_approvals: number;
  claim_token: string | null;
  result_ref: string | null;
  expires_at: Date;
};

async function lerAprovacao(id: string): Promise<ApprovalRow> {
  const r = await pool.query<ApprovalRow>(
    `SELECT id::text AS id, status, fingerprint, intent_hash, approval_class,
            required_approvals, claim_token, result_ref, expires_at
       FROM approval_requests WHERE id = $1`,
    [id],
  );
  if (!r.rows[0]) throw new Error(`approval_requests não encontrada: ${id}`);
  return r.rows[0];
}

/** Pedidos de aprovação da fixture, por nonce, na ordem de criação. */
async function pedidosDoNonce(nonce: string): Promise<ApprovalRow[]> {
  const r = await pool.query<ApprovalRow>(
    `SELECT id::text AS id, status, fingerprint, intent_hash, approval_class,
            required_approvals, claim_token, result_ref, expires_at
       FROM approval_requests
      WHERE tenant_id = $1 AND agent_id = $2 AND tool = 'create_contraparte'
        AND intent_payload->>'nonce' = $3
      ORDER BY created_at`,
    [TENANT, AGENT, nonce],
  );
  return r.rows;
}

async function pedidosAbertosDoFingerprint(fingerprint: string): Promise<ApprovalRow[]> {
  const r = await pool.query<ApprovalRow>(
    `SELECT id::text AS id, status, fingerprint, intent_hash, approval_class,
            required_approvals, claim_token, result_ref, expires_at
       FROM approval_requests
      WHERE tenant_id = $1 AND agent_id = $2 AND fingerprint = $3
        AND status IN ('pending','approved','claimed')
      ORDER BY created_at`,
    [TENANT, AGENT, fingerprint],
  );
  return r.rows;
}

/**
 * A decisão HUMANA simulada no banco.
 *
 * A máquina de decisão (`recordApprovalDecision`, elegibilidade, 4-eyes) tem
 * suíte própria (`tests/integration/dual-approval-expiry-cas-real-db.spec.ts` e
 * `tests/unit/approval-requests.spec.ts`); o sujeito AQUI é o que acontece
 * DEPOIS de a evidência existir — claim, execução, consumo e não-reutilização.
 * Escrever o estado terminal direto é o que isola esse sujeito.
 */
async function aprovarPorSql(id: string): Promise<void> {
  const r = await pool.query(
    `UPDATE approval_requests SET status = 'approved', approved_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [id],
  );
  if (r.rowCount !== 1) throw new Error(`aprovação por SQL não aplicou: ${id}`);
}

async function vencePorSql(id: string): Promise<void> {
  const r = await pool.query(
    `UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`,
    [id],
  );
  if (r.rowCount !== 1) throw new Error(`vencimento por SQL não aplicou: ${id}`);
}

/**
 * Roda a devolução de claim de verdade e diz se o BANCO a aceitou.
 *
 * Existe separado porque o valor de retorno é o que diferencia "devolveu" de
 * "recusou de propósito" — e transformar isso em `boolean` evita que o teste
 * confunda uma recusa deliberada com um objeto ausente.
 */
async function lerAprovacaoDevolvida(id: string, claim_token: string): Promise<boolean> {
  const devolvida = await noEscopo(() => approvalRequestsRepo.releaseClaim({ id, claim_token }));
  return devolvida !== null;
}

async function contarAprovacoesDaTool(tool: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    'SELECT count(*) AS c FROM approval_requests WHERE tenant_id = $1 AND agent_id = $2 AND tool = $3',
    [TENANT, AGENT, tool],
  );
  return Number(r.rows[0]?.c ?? 0);
}

type PendenciaRow = { id: string; status: string; conversa_id: string | null; expira_em: Date };

async function criarPendencia(
  conversa_id: string,
  pessoa_id: string,
  opcoes: Array<{ key: string; label: string }>,
  expirada: boolean,
): Promise<{ pending_question_id: string; opcoes_count: number; opcoes_validas: typeof opcoes }> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO pending_questions
       (id, tenant_id, agent_id, conversa_id, pessoa_id, tipo, pergunta, opcoes_validas,
        acao_proposta, expira_em, status, metadata)
     VALUES ($1,$2,$3,$4,$5,'gate','Escolha?', $6::jsonb, '{}'::jsonb,
             ${expirada ? "now() - interval '1 minute'" : "now() + interval '10 minutes'"}, 'aberta', '{}'::jsonb)`,
    [id, TENANT, AGENT, conversa_id, pessoa_id, JSON.stringify(opcoes)],
  );
  return { pending_question_id: id, opcoes_count: opcoes.length, opcoes_validas: opcoes };
}

async function lerPendencia(id: string): Promise<PendenciaRow> {
  const r = await pool.query<PendenciaRow>(
    `SELECT id::text AS id, status, conversa_id::text AS conversa_id, expira_em
       FROM pending_questions WHERE id = $1`,
    [id],
  );
  if (!r.rows[0]) throw new Error(`pending_questions não encontrada: ${id}`);
  return r.rows[0];
}

async function contarPendencias(conversa_id: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    'SELECT count(*) AS c FROM pending_questions WHERE conversa_id = $1',
    [conversa_id],
  );
  return Number(r.rows[0]?.c ?? 0);
}

/**
 * A prova de pendência do §5.5.2, ligada à MESMA máquina que o laço legado usa
 * (`pendingQuestionsRepo.findActiveSnapshot`): aberta, no prazo e da conversa
 * ATUAL. É essa e não outra: uma consulta por id provaria que a linha existe e
 * nada sobre estar aberta, no prazo ou ser desta conversa.
 */
function provaDePendencia(conversa_id: string) {
  return async (input: { pending_question_id: string }): Promise<'open' | 'stale'> => {
    const ativa = await noEscopo(() => pendingQuestionsRepo.findActiveSnapshot(conversa_id));
    return ativa !== null && ativa.id === input.pending_question_id ? 'open' : 'stale';
  };
}

/** A recusa que o MOTOR ouve: projeção pública da prova do ledger. */
function recusaParaOMotor(request_id: string, approval_class: string) {
  return {
    error: 'approval_required',
    ref: `AP-${request_id.slice(0, 8)}`,
    approval_class,
  };
}

d('SC05 — approval terminal e pendência real (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await seedTenant();
    ctxBase = {
      pessoa: pessoaBase,
      scope: { entidades: [ENTIDADE_ID], byEntity: new Map() },
      conversa: { id: await mkConversa() } as unknown as Conversa,
      mensagem_id: randomUUID(),
      request_id: randomUUID(),
    };
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    fixture.contraparte = 0;
    fixture.pendencia = 0;
    fixture.lancar = false;
    fixture.resultadoContraparte = { ok: true, contraparte_id: 'c-1' };
    pendenciaCtl.devolverId = null;
    pendenciaCtl.conversaDaCriacao = null;
    pendenciaCtl.expiraEmPassado = false;
    await concederTool(['create_contraparte', 'ask_pending_question']);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. approval_required é TERMINAL, com prova de ledger, e não reanima
  // ══════════════════════════════════════════════════════════════════════════
  it('1. AC01/AC02 — approval_required terminal com UUID+intent_hash; mesmo callback devolve a MESMA recusa, antes e depois de approved', async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    const nonce = randomUUID();
    const args = { texto: 'contraparte', nonce };
    const call_id = `sc05:${randomUUID().slice(0, 8)}`;
    const { invoke, eventos } = gatewayReal(turno, run_id);

    const r1 = await invoke(chamadaGw(run_id, call_id, args));

    // ── zero handler: aprovação pendente não é autorização ────────────────
    expect(fixture.contraparte).toBe(0);
    // Nada foi LIQUIDADO: a call termina no registro de aprovação, não num
    // desfecho de handler.
    expect(eventos.settles).toHaveLength(0);

    // ── o journal: terminal, com UUID COMPLETO e intent_hash (não o `AP-…`) ─
    const row = await lerCall(run_id, call_id);
    expect(row.state).toBe('approval_required');
    expect(row.approval_request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(row.effect_evidence).toBe('none');
    expect(row.handler_started_at).toBeNull();
    expect(row.finished_at).not.toBeNull();

    const pedidoAprovacao = await lerAprovacao(row.approval_request_id!);
    expect(pedidoAprovacao.status).toBe('pending');
    expect(pedidoAprovacao.approval_class).toBe(CLASS);
    expect(pedidoAprovacao.required_approvals).toBe(2);
    expect(pedidoAprovacao.intent_hash).toMatch(/^v1:[0-9a-f]{64}$/);

    const registro = row.result_json as {
      error?: string;
      ref?: string;
      approval?: { request_id?: string; ref?: string; intent_hash?: string; approval_class?: string };
    };
    expect(registro.error).toBe('approval_required');
    expect(registro.ref).toBe(`AP-${row.approval_request_id!.slice(0, 8)}`);
    expect(registro.approval).toMatchObject({
      request_id: row.approval_request_id,
      ref: registro.ref,
      intent_hash: pedidoAprovacao.intent_hash,
      approval_class: CLASS,
    });

    // ── a vaga sequencial do run NÃO fica ocupada: consequência observável
    // de a call ser terminal, e não de espera (§5.5.1: «o run não mantém lease
    // nem stream ocupada esperando aprovação humana»).
    const proxima = await noEscopo(() =>
      engineRunsRepo.admitToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        request_id: randomUUID(),
        call: { call_id: `${call_id}:next`, ordinal: 1, iteration: 1, name: 'create_contraparte', args: { texto: 'outra', nonce: randomUUID() } },
      }),
    );
    expect(proxima.ok).toBe(true);

    // ── o motor recebe a recusa: erro real, sem material interno ──────────
    expect(r1).toMatchObject({ kind: 'result', call_id, is_error: true });
    expect((r1 as { result: unknown }).result).toEqual(
      recusaParaOMotor(row.approval_request_id!, CLASS),
    );

    // ── REPLAY antes da aprovação: MESMA resposta, zero handlers novos ────
    const r2 = await invoke(chamadaGw(run_id, call_id, args));
    expect(r2).toEqual(r1);
    expect(fixture.contraparte).toBe(0);

    // ── a decisão humana chega (aprovada) ────────────────────────────────
    await aprovarPorSql(row.approval_request_id!);
    expect((await lerAprovacao(row.approval_request_id!)).status).toBe('approved');

    // ── REPLAY DEPOIS de aprovada: o callback repetido é REDELIVERY da
    // recusa — a mesma call NÃO passa a executar por a aprovação ter chegado
    // (SPEC-L1406).
    const r3 = await invoke(chamadaGw(run_id, call_id, args));
    expect(r3).toEqual(r1);
    expect(fixture.contraparte).toBe(0);

    const depois = await lerAprovacao(row.approval_request_id!);
    // A evidência continua DISPONÍVEL (approved, não consumida): o replay não
    // executou nada nem gastou a aprovação de quem repetir a operação de fato.
    expect(depois.status).toBe('approved');
    expect(depois.claim_token).toBeNull();

    const rowDepois = await lerCall(run_id, call_id);
    expect(rowDepois.state).toBe('approval_required');
    expect(rowDepois.row_version).toBe(row.row_version);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. novo turno/call revalida e executa UMA vez; a evidência é consumida
  // ══════════════════════════════════════════════════════════════════════════
  it('2. AC03 — nova mensagem cria novo turno/call, executa UMA vez e CONSOME a evidência; a terceira tentativa exige aprovação NOVA', async () => {
    const nonce = randomUUID();
    const args = { texto: 'contraparte-2', nonce };

    // ── turno 1: o pedido nasce ────────────────────────────────────────────
    const turno1 = await mkTurnoVivo();
    const run1 = await runRodando(turno1, await mkControle());
    const call1 = `sc05:t1:${randomUUID().slice(0, 8)}`;
    const gw1 = gatewayReal(turno1, run1);
    const r1 = await gw1.invoke(chamadaGw(run1, call1, args));
    expect(r1).toMatchObject({ kind: 'result', is_error: true });

    const pedidos = await pedidosDoNonce(nonce);
    expect(pedidos).toHaveLength(1);
    const pedido = pedidos[0]!;
    await aprovarPorSql(pedido.id);

    // ── turno 2 (mensagem NOVA): a repetição legítima executa UMA vez ──────
    const turno2 = await mkTurnoVivo();
    const run2 = await runRodando(turno2, await mkControle());
    const call2 = `sc05:t2:${randomUUID().slice(0, 8)}`;
    const gw2 = gatewayReal(turno2, run2);
    const r2 = await gw2.invoke(chamadaGw(run2, call2, args));

    expect(fixture.contraparte).toBe(1);
    expect(r2, JSON.stringify(r2)).toMatchObject({ kind: 'result', is_error: false });
    expect((r2 as { result: unknown }).result).toEqual(fixture.resultadoContraparte);

    const row2 = await lerCall(run2, call2);
    expect(row2.state).toBe('completed');
    expect(row2.effect_evidence).toBe('committed');
    // O mesmo PEDIDO de aprovação viaja no journal da execução — UUID completo
    // e o token do claim que autorizou o efeito.
    expect(row2.approval_request_id).toBe(pedido.id);
    expect(row2.approval_claim_token).not.toBeNull();

    const consumida = await lerAprovacao(pedido.id);
    expect(consumida.status).toBe('consumed');
    expect(consumida.claim_token).toBe(row2.approval_claim_token);

    // Repetição EXATA dentro da janela do ledger de IDEMPOTÊNCIA: o resultado já
    // comprometido volta, sem handler novo e SEM novo claim de aprovação.
    const turnoRep = await mkTurnoVivo();
    const runRep = await runRodando(turnoRep, await mkControle());
    const callRep = `sc05:t2rep:${randomUUID().slice(0, 8)}`;
    const rRep = await gatewayReal(turnoRep, runRep).invoke(chamadaGw(runRep, callRep, args));

    expect(fixture.contraparte).toBe(1);
    expect(rRep).toMatchObject({ kind: 'result', is_error: false });
    expect((rRep as { result: unknown }).result).toEqual(fixture.resultadoContraparte);
    const rowRep = await lerCall(runRep, callRep);
    expect(rowRep.state).toBe('completed');
    expect(rowRep.approval_request_id).toBeNull();
    expect(rowRep.approval_claim_token).toBeNull();
    expect((await lerAprovacao(pedido.id)).status).toBe('consumed');

    // ── terceira tentativa: a evidência CONSUMIDA não autoriza de novo ────
    //
    // Dois desfechos possíveis para "repetir a operação", e o teste mede os
    // dois, porque confundi-los é o erro que o §5.5.1 previne:
    //
    //  1. Repetição EXATA dentro da janela do ledger de IDEMPOTÊNCIA: outra
    //     máquina (não a aprovação) devolve o resultado já comprometido, sem
    //     handler e sem claim. Isso não é reutilizar aprovação.
    //  2. Execução NOVA (a reserva não está mais no cache — podada ou vencida,
    //     representada aqui removendo a linha): aí quem governa é a máquina de
    //     aprovação, e `consumed` não está entre os estados `open`. O resultado
    //     só pode ser um pedido NOVO, sem efeito.
    const turno3 = await mkTurnoVivo();
    const run3 = await runRodando(turno3, await mkControle());
    const call3 = `sc05:t3:${randomUUID().slice(0, 8)}`;
    const gw3 = gatewayReal(turno3, run3);

    await pool.query(
      `DELETE FROM idempotency_keys
        WHERE tenant_id = $1 AND agent_id = $2 AND tool_name = 'create_contraparte' AND pessoa_id = $3`,
      [TENANT, AGENT, PESSOA_ID],
    );

    const r3 = await gw3.invoke(chamadaGw(run3, call3, args));

    expect(fixture.contraparte).toBe(1); // nenhum efeito novo
    expect(r3).toMatchObject({ kind: 'result', is_error: true });

    const novas = await pedidosDoNonce(nonce);
    expect(novas).toHaveLength(2);
    const nova = novas[1]!;
    expect(nova.id).not.toBe(pedido.id);
    expect(nova.status).toBe('pending');
    // MESMO fingerprint (mesma intenção) e MESMO intent_hash: o que mudou foi a
    // evidência — a antiga está consumida e não se transfere.
    expect(nova.fingerprint).toBe(pedido.fingerprint);
    expect(nova.intent_hash).toBe(pedido.intent_hash);
    const row3 = await lerCall(run3, call3);
    expect(row3.state).toBe('approval_required');
    expect(row3.approval_request_id).toBe(nova.id);
    expect((await lerAprovacao(pedido.id)).status).toBe('consumed');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. requester/payload alterados e evidência denied/vencida
  // ══════════════════════════════════════════════════════════════════════════
  it('3. AC03/SPEC-L1406 — payload alterado, outro requester, DENIED e VENCIDA não herdam a evidência', async () => {
    // ── (a) payload alterado na MESMA conversa ────────────────────────────
    const nonce = randomUUID();
    const turnoA = await mkTurnoVivo();
    const runA = await runRodando(turnoA, await mkControle());
    const callA = `sc05:a:${randomUUID().slice(0, 8)}`;
    const gwA = gatewayReal(turnoA, runA);
    await gwA.invoke(chamadaGw(runA, callA, { texto: 'original', nonce }));
    const pedidoA = (await pedidosDoNonce(nonce))[0]!;
    await aprovarPorSql(pedidoA.id);

    const turnoB = await mkTurnoVivo();
    const runB = await runRodando(turnoB, await mkControle());
    const callB = `sc05:b:${randomUUID().slice(0, 8)}`;
    const gwB = gatewayReal(turnoB, runB);
    const rB = await gwB.invoke(chamadaGw(runB, callB, { texto: 'ALTERADO', nonce }));

    expect(fixture.contraparte).toBe(0);
    expect(rB).toMatchObject({ kind: 'result', is_error: true });
    // A evidência aprovada do payload ORIGINAL segue intacta e não foi usada.
    expect((await lerAprovacao(pedidoA.id)).status).toBe('approved');
    const pedidosB = await pedidosDoNonce(nonce);
    expect(pedidosB).toHaveLength(2);
    expect(pedidosB[1]!.id).not.toBe(pedidoA.id);
    expect(pedidosB[1]!.status).toBe('pending');
    expect(pedidosB[1]!.fingerprint).not.toBe(pedidoA.fingerprint);

    // ── (b) OUTRO requester com o mesmo payload ───────────────────────────
    const turnoC = await mkTurnoVivo();
    const runC = await runRodando(turnoC, await mkControle());
    const callC = `sc05:c:${randomUUID().slice(0, 8)}`;
    const gwC = gatewayReal(turnoC, runC, {
      ctx: { ...ctxBase, pessoa: { ...pessoaBase, id: PESSOA2_ID } as unknown as Pessoa },
    });
    const rC = await gwC.invoke(chamadaGw(runC, callC, { texto: 'original', nonce }));

    expect(fixture.contraparte).toBe(0);
    expect(rC).toMatchObject({ kind: 'result', is_error: true });
    // A aprovação do primeiro requester NÃO se transfere para o segundo.
    expect((await lerAprovacao(pedidoA.id)).status).toBe('approved');
    const pedidosC = await pedidosDoNonce(nonce);
    expect(pedidosC).toHaveLength(3);
    expect(pedidosC[2]!.id).not.toBe(pedidoA.id);
    expect(pedidosC[2]!.status).toBe('pending');
    expect(pedidosC[2]!.fingerprint).not.toBe(pedidoA.fingerprint);

    // ── (c) DENIED não é reutilizada ──────────────────────────────────────
    const nonceD = randomUUID();
    const turnoD = await mkTurnoVivo();
    const runD = await runRodando(turnoD, await mkControle());
    const callD = `sc05:d:${randomUUID().slice(0, 8)}`;
    const gwD = gatewayReal(turnoD, runD);
    await gwD.invoke(chamadaGw(runD, callD, { texto: 'negada', nonce: nonceD }));
    const pedidoD = (await pedidosDoNonce(nonceD))[0]!;
    const negada = await noEscopo(() => approvalRequestsRepo.markDenied(pedidoD.id));
    expect(negada?.status).toBe('denied');

    const turnoE = await mkTurnoVivo();
    const runE = await runRodando(turnoE, await mkControle());
    const callE = `sc05:e:${randomUUID().slice(0, 8)}`;
    const gwE = gatewayReal(turnoE, runE);
    const rE = await gwE.invoke(chamadaGw(runE, callE, { texto: 'negada', nonce: nonceD }));

    expect(fixture.contraparte).toBe(0);
    expect(rE).toMatchObject({ kind: 'result', is_error: true });
    expect((await lerAprovacao(pedidoD.id)).status).toBe('denied');
    const pedidosE = await pedidosDoNonce(nonceD);
    expect(pedidosE).toHaveLength(2);
    expect(pedidosE[1]!.status).toBe('pending');
    expect(pedidosE[1]!.id).not.toBe(pedidoD.id);

    // ── (d) VENCIDA não é reutilizada (nem fica "pendente" para sempre) ───
    const nonceF = randomUUID();
    const turnoF = await mkTurnoVivo();
    const runF = await runRodando(turnoF, await mkControle());
    const callF = `sc05:f:${randomUUID().slice(0, 8)}`;
    const gwF = gatewayReal(turnoF, runF);
    await gwF.invoke(chamadaGw(runF, callF, { texto: 'vencida', nonce: nonceF }));
    const pedidoF = (await pedidosDoNonce(nonceF))[0]!;
    await aprovarPorSql(pedidoF.id);
    await vencePorSql(pedidoF.id);

    const turnoG = await mkTurnoVivo();
    const runG = await runRodando(turnoG, await mkControle());
    const callG = `sc05:g:${randomUUID().slice(0, 8)}`;
    const gwG = gatewayReal(turnoG, runG);
    const rG = await gwG.invoke(chamadaGw(runG, callG, { texto: 'vencida', nonce: nonceF }));

    expect(fixture.contraparte).toBe(0);
    expect(rG).toMatchObject({ kind: 'result', is_error: true });
    // A evidência vencida é ENCERRADA (não fica 'approved' intocável bloqueando
    // o fingerprint) e um pedido NOVO, com o MESMO fingerprint, é aberto.
    expect((await lerAprovacao(pedidoF.id)).status).toBe('expired');
    const pedidosG = await pedidosDoNonce(nonceF);
    expect(pedidosG).toHaveLength(2);
    expect(pedidosG[1]!.status).toBe('pending');
    expect(pedidosG[1]!.id).not.toBe(pedidoF.id);
    expect(pedidosG[1]!.fingerprint).toBe(pedidoF.fingerprint);
    const abertos = await pedidosAbertosDoFingerprint(pedidoF.fingerprint);
    expect(abertos).toHaveLength(1);
    expect(abertos[0]!.id).toBe(pedidosG[1]!.id);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. claim de aprovação: devolução só com PROVA de não início
  // ══════════════════════════════════════════════════════════════════════════
  it('4. AC04 — o claim só volta com prova de não início no journal; com início ou incerteza é terminal', async () => {
    const nonce = randomUUID();
    const args = { texto: 'claim', nonce };

    // ── pedido + execução REAL, para ter journal com carimbo de início ─────
    const turno = await mkTurnoVivo();
    const run = await runRodando(turno, await mkControle());
    const call = `sc05:claim:${randomUUID().slice(0, 8)}`;
    const gw = gatewayReal(turno, run);
    await gw.invoke(chamadaGw(run, call, args));
    const pedido = (await pedidosDoNonce(nonce))[0]!;
    await aprovarPorSql(pedido.id);

    const turno2 = await mkTurnoVivo();
    const run2 = await runRodando(turno2, await mkControle());
    const call2 = `sc05:claim2:${randomUUID().slice(0, 8)}`;
    const gw2 = gatewayReal(turno2, run2);
    const r2 = await gw2.invoke(chamadaGw(run2, call2, args));
    expect(r2).toMatchObject({ kind: 'result', is_error: false });
    expect(fixture.contraparte).toBe(1);

    const rowExec = await lerCall(run2, call2);
    expect(rowExec.handler_started_at).not.toBeNull();
    expect(rowExec.approval_claim_token).not.toBeNull();

    /**
     * O estado que um SIGKILL entre o marcador e o `consume` deixa no banco: o
     * journal PROVA o início e a evidência continua `claimed`. É este o estado
     * em que "devolver o claim" apagaria a única prova de que o efeito pode ter
     * acontecido — então é ele que precisa ser recusado.
     */
    await pool.query(
      `UPDATE approval_requests SET status = 'claimed', claim_token = $2, updated_at = now()
        WHERE id = $1`,
      [pedido.id, rowExec.approval_claim_token],
    );

    const devolvido = await noEscopo(() =>
      approvalRequestsRepo.releaseClaim({
        id: pedido.id,
        claim_token: rowExec.approval_claim_token!,
      }),
    );
    expect(devolvido).toBeNull();
    expect((await lerAprovacao(pedido.id)).status).toBe('claimed');
    // A política PURA concorda com o banco para o mesmo instantâneo.
    expect(
      classifyApprovalClaimRecovery({
        approval_status: 'claimed',
        handler_started: true,
        effect_class: 'non_interruptible',
        start_uncertain: false,
      }),
    ).toBe('execution_failed');

    // ── a classe que declara ausência de efeito é prova bastante ───────────
    await pool.query(`UPDATE engine_tool_calls SET effect_class = 'abort_safe' WHERE run_id = $1 AND call_id = $2`, [
      run2,
      call2,
    ]);
    const devolvidoAbortSafe = await noEscopo(() =>
      approvalRequestsRepo.releaseClaim({
        id: pedido.id,
        claim_token: rowExec.approval_claim_token!,
      }),
    );
    expect(devolvidoAbortSafe?.status).toBe('approved');

    // ── a prova de não início é a do JOURNAL, não a "ausência de erro" ────
    //
    // Diferencial deliberado: a MESMA row, com o MESMO token, muda de resposta
    // quando o ÚNICO campo relevante muda. Sem isso, "recusou" poderia ser
    // efeito colateral de qualquer outra condição do CAS.
    await pool.query(
      `UPDATE approval_requests SET status = 'claimed', claim_token = $2, updated_at = now()
        WHERE id = $1`,
      [pedido.id, rowExec.approval_claim_token],
    );
    await pool.query(
      `UPDATE engine_tool_calls SET effect_class = 'non_interruptible', handler_started_at = NULL
        WHERE run_id = $1 AND call_id = $2`,
      [run2, call2],
    );
    const devolvidoSemStart = await noEscopo(() =>
      approvalRequestsRepo.releaseClaim({
        id: pedido.id,
        claim_token: rowExec.approval_claim_token!,
      }),
    );
    expect(devolvidoSemStart?.status).toBe('approved');
    expect(
      classifyApprovalClaimRecovery({
        approval_status: 'claimed',
        handler_started: false,
        effect_class: null,
        start_uncertain: false,
      }),
    ).toBe('release_claim');

    // ── TTL NÃO libera efeito: o claim vencido continua segurando a vaga e o
    // token continua sendo a única chave para consumir ─────────────────────
    await pool.query(
      `UPDATE approval_requests SET status = 'claimed', claim_token = $2, expires_at = now() - interval '1 hour'
        WHERE id = $1`,
      [pedido.id, rowExec.approval_claim_token],
    );
    const comClaimVencido = await noEscopo(() =>
      claimExecutableApproval({ intent_hash: pedido.intent_hash, requester: pessoaBase }),
    );
    // Outro executante NÃO rouba o claim por relógio: a resposta é 'pending'.
    expect(comClaimVencido.outcome).toBe('pending');
    const aposTtl = await lerAprovacao(pedido.id);
    expect(aposTtl.status).toBe('claimed');
    expect(aposTtl.claim_token).toBe(rowExec.approval_claim_token);
    // Devolver com o token ERRADO nunca passa.
    expect(await lerAprovacaoDevolvida(pedido.id, randomUUID())).toBe(false);
    // A incerteza do próprio journal é tratada como início comprovado.
    expect(
      classifyApprovalClaimRecovery({
        approval_status: 'claimed',
        handler_started: false,
        effect_class: null,
        start_uncertain: true,
      }),
    ).toBe('execution_failed');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. execução incerta pós-marcador é terminal e exige NOVA aprovação
  // ══════════════════════════════════════════════════════════════════════════
  it('5. AC04 — handler que lança DEPOIS do marcador: journal effect_unknown e approval execution_failed (nova aprovação)', async () => {
    const nonce = randomUUID();
    const args = { texto: 'crash', nonce };

    const turno1 = await mkTurnoVivo();
    const run1 = await runRodando(turno1, await mkControle());
    const call1 = `sc05:crash1:${randomUUID().slice(0, 8)}`;
    await gatewayReal(turno1, run1).invoke(chamadaGw(run1, call1, args));
    const pedido = (await pedidosDoNonce(nonce))[0]!;
    await aprovarPorSql(pedido.id);

    const turno2 = await mkTurnoVivo();
    const run2 = await runRodando(turno2, await mkControle());
    const call2 = `sc05:crash2:${randomUUID().slice(0, 8)}`;
    fixture.lancar = true;
    const r2 = await gatewayReal(turno2, run2).invoke(chamadaGw(run2, call2, args));

    // O handler EXECUTOU e explodiu: o efeito não pode ser declarado inexistente.
    expect(fixture.contraparte).toBe(1);
    expect(r2).toMatchObject({ kind: 'result', is_error: true });
    expect((r2 as { result: { error?: string } }).result.error).toBe('effect_unknown');

    const row = await lerCall(run2, call2);
    expect(row.state).toBe('effect_unknown');
    expect(row.effect_evidence).toBe('unknown');
    expect(row.handler_started_at).not.toBeNull();
    expect(row.approval_request_id).toBe(pedido.id);

    // A evidência humana é TERMINAL: não volta para 'approved' nem segue
    // 'claimed' esperando alguém adivinhar o que aconteceu no mundo.
    expect((await lerAprovacao(pedido.id)).status).toBe('execution_failed');
    expect(
      classifyApprovalClaimRecovery({
        approval_status: 'claimed',
        handler_started: true,
        effect_class: 'non_interruptible',
        start_uncertain: false,
      }),
    ).toBe('execution_failed');

    // Repetir a operação NÃO herda a evidência gasta: exige aprovação NOVA e
    // não emite efeito nenhum antes disso.
    fixture.lancar = false;
    const turno3 = await mkTurnoVivo();
    const run3 = await runRodando(turno3, await mkControle());
    const call3 = `sc05:crash3:${randomUUID().slice(0, 8)}`;
    const r3 = await gatewayReal(turno3, run3).invoke(chamadaGw(run3, call3, args));

    expect(fixture.contraparte).toBe(1);
    expect(r3).toMatchObject({ kind: 'result', is_error: true });
    const pedidos = await pedidosDoNonce(nonce);
    expect(pedidos).toHaveLength(2);
    expect(pedidos[1]!.status).toBe('pending');
    expect(pedidos[1]!.id).not.toBe(pedido.id);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 6. pendência: sobe com prova; sem prova, é suprimida sem ressuscitar poll
  // ══════════════════════════════════════════════════════════════════════════
  it('6. AC01/AC05/AC06 — pergunta REAL sobe com prova no ledger; vencida/cross-conversa/sem-prova/cache-antigo são suprimidas sem poll novo', async () => {
    /**
     * Cada sub-caso usa args DIFERENTES de propósito: o ledger de IDEMPOTÊNCIA é
     * de outra máquina e, com a MESMA intenção, devolveria o resultado já
     * comprometido sem rodar o handler — o que mediria o cache em vez da
     * pendência.
     */
    const argsDe = (nonce: string) => ({ pergunta: 'Qual das duas?', nonce, opcoes: ['sim', 'nao'] });
    const argsA = argsDe(randomUUID());

    // ── (a) pergunta REAL, aberta, no prazo, desta conversa ───────────────
    const conversaA = await mkConversa();
    const turnoA = await mkTurnoVivo();
    const runA = await runRodando(turnoA, await mkControle());
    const callA = `sc05:p1:${randomUUID().slice(0, 8)}`;
    const gwA = gatewayReal(turnoA, runA, {
      over: { pendingQuestionProof: provaDePendencia(conversaA) },
      ctx: ctxComConversa(conversaA),
    });
    const rA = await gwA.invoke(chamadaGw(runA, callA, argsA, 0, 'ask_pending_question'));

    expect(fixture.pendencia).toBe(1);
    expect(rA).toMatchObject({ kind: 'result', is_error: false });
    const idA = ((rA as { result: { pending_question_id?: string } }).result.pending_question_id)!;
    expect(idA).toMatch(/^[0-9a-f-]{36}$/);
    expect((rA as { result: { opcoes_validas?: unknown[] } }).result.opcoes_validas).toHaveLength(2);
    expect((await lerPendencia(idA)).status).toBe('aberta');
    expect((await lerPendencia(idA)).conversa_id).toBe(conversaA);

    const rowA = await lerCall(runA, callA);
    expect(rowA.state).toBe('completed');
    // A prova fica no LEDGER: é o receipt do journal que carrega a pendência,
    // não uma inferência de quem lê a resposta.
    const receiptA = rowA.receipt_json as {
      pending_question_id?: string | null;
      approval?: unknown;
      result_for_engine?: { pending_question_id?: string };
    };
    expect(receiptA.pending_question_id).toBe(idA);
    expect(receiptA.result_for_engine?.pending_question_id).toBe(idA);
    expect(receiptA.approval).toBeNull();
    // Máquinas SEPARADAS: o caminho de pendência não cria evidência de
    // aprovação, e o de aprovação (casos 1–5) não cria pendência.
    expect(await contarAprovacoesDaTool('ask_pending_question')).toBe(0);
    expect(await contarPendencias(conversaA)).toBe(1);

    // ── (b) pergunta VENCIDA: suprimida, e a máquina legada fica INTOCADA ─
    const conversaB = await mkConversa();
    pendenciaCtl.expiraEmPassado = true;
    const turnoB = await mkTurnoVivo();
    const runB = await runRodando(turnoB, await mkControle());
    const callB = `sc05:p2:${randomUUID().slice(0, 8)}`;
    const gwB = gatewayReal(turnoB, runB, {
      over: { pendingQuestionProof: provaDePendencia(conversaB) },
      ctx: ctxComConversa(conversaB),
    });
    const rB = await gwB.invoke(chamadaGw(runB, callB, argsDe(randomUUID()), 0, 'ask_pending_question'));
    pendenciaCtl.expiraEmPassado = false;

    const receptB = (await lerCall(runB, callB)).receipt_json as {
      pending_question_id?: string | null;
      result_for_engine?: { pending_question_id?: string; opcoes_validas?: unknown[] };
    };
    expect((rB as { result: { pending_question_id?: string } }).result.pending_question_id).toBeUndefined();
    expect((rB as { result: { opcoes_validas?: unknown[] } }).result.opcoes_validas).toBeUndefined();
    expect(receptB.pending_question_id).toBeNull();
    expect(receptB.result_for_engine?.pending_question_id).toBeUndefined();
    // Supressão NÃO é ressuscitação: o gateway não cria pergunta nova, não
    // reabre a vencida e não muda o status dela.
    expect(await contarPendencias(conversaB)).toBe(1);
    const rowB = await pool.query<{ id: string; status: string }>(
      'SELECT id::text AS id, status FROM pending_questions WHERE conversa_id = $1',
      [conversaB],
    );
    expect(rowB.rows[0]!.status).toBe('aberta');

    // ── (c) pendência de OUTRA conversa: não sobe nesta ───────────────────
    const conversaC = await mkConversa();
    const conversaD = await mkConversa();
    const opcoes = [
      { key: 'sim', label: 'Sim' },
      { key: 'nao', label: 'Não' },
    ];
    const deOutra = await criarPendencia(conversaD, PESSOA_ID, opcoes, false);
    const daConversaC = await criarPendencia(conversaC, PESSOA_ID, opcoes, false);
    pendenciaCtl.devolverId = deOutra.pending_question_id;
    const turnoC = await mkTurnoVivo();
    const runC = await runRodando(turnoC, await mkControle());
    const callC = `sc05:p3:${randomUUID().slice(0, 8)}`;
    const gwC = gatewayReal(turnoC, runC, {
      over: { pendingQuestionProof: provaDePendencia(conversaC) },
      ctx: ctxComConversa(conversaC),
    });
    const rC = await gwC.invoke(chamadaGw(runC, callC, argsDe(randomUUID()), 0, 'ask_pending_question'));
    pendenciaCtl.devolverId = null;

    expect((rC as { result: { pending_question_id?: string } }).result.pending_question_id).toBeUndefined();
    const receptC = (await lerCall(runC, callC)).receipt_json as {
      pending_question_id?: string | null;
    };
    expect(receptC.pending_question_id).toBeNull();
    // A pergunta VIVA desta conversa continua viva (não foi "resgatada" nem
    // substituída) e a da outra conversa segue intocada.
    expect((await lerPendencia(daConversaC.pending_question_id)).status).toBe('aberta');
    expect((await lerPendencia(deOutra.pending_question_id)).status).toBe('aberta');
    expect(await contarPendencias(conversaC)).toBe(1);
    expect(await contarPendencias(conversaD)).toBe(1);

    // ── (d) SEM prova injetada: fail-closed, nada sobe ────────────────────
    const conversaE = await mkConversa();
    const turnoE = await mkTurnoVivo();
    const runE = await runRodando(turnoE, await mkControle());
    const callE = `sc05:p4:${randomUUID().slice(0, 8)}`;
    const gwE = gatewayReal(turnoE, runE, { ctx: ctxComConversa(conversaE) });
    const rE = await gwE.invoke(chamadaGw(runE, callE, argsDe(randomUUID()), 0, 'ask_pending_question'));

    expect((rE as { result: { pending_question_id?: string } }).result.pending_question_id).toBeUndefined();
    expect(((await lerCall(runE, callE)).receipt_json as { pending_question_id?: string | null }).pending_question_id).toBeNull();
    // A pergunta real existe no banco, mas sem prova ela não é oferecida.
    expect(await contarPendencias(conversaE)).toBe(1);

    // ── (e) SUCESSO ANTIGO no cache, com pendência já vencida ─────────────
    //
    // O caso que o §5.5.2 nomeia: a intenção repete e o ledger de IDEMPOTÊNCIA
    // devolve o resultado ANTERIOR — com o UUID da pergunta já vencida dentro.
    // Devolver esse payload ao motor seria ressuscitar a pergunta, e é aqui que
    // a supressão deixa de ser teoria: o handler NÃO roda (nada novo é criado) e
    // a única coisa que muda é a pendência sair do payload.
    const conversaF = await mkConversa();
    const argsF = argsDe(randomUUID());
    const turnoF = await mkTurnoVivo();
    const runF = await runRodando(turnoF, await mkControle());
    const gwF = gatewayReal(turnoF, runF, {
      over: { pendingQuestionProof: provaDePendencia(conversaF) },
      ctx: ctxComConversa(conversaF),
    });
    const rF1 = await gwF.invoke(chamadaGw(runF, `sc05:p5a:${randomUUID().slice(0, 8)}`, argsF, 0, 'ask_pending_question'));
    const idF = ((rF1 as { result: { pending_question_id?: string } }).result.pending_question_id)!;
    expect(idF).toMatch(/^[0-9a-f-]{36}$/);
    expect(fixture.pendencia).toBe(5);

    // A pergunta vence SEM ser respondida (o instante em que a resposta do turno
    // ainda não saiu e o TTL fecha).
    await pool.query(`UPDATE pending_questions SET expira_em = now() - interval '1 minute' WHERE id = $1`, [idF]);
    expect(await noEscopo(() => pendingQuestionsRepo.findActiveSnapshot(conversaF))).toBeNull();

    const turnoG = await mkTurnoVivo();
    const runG = await runRodando(turnoG, await mkControle());
    const gwG = gatewayReal(turnoG, runG, {
      over: { pendingQuestionProof: provaDePendencia(conversaF) },
      ctx: ctxComConversa(conversaF),
    });
    const rG = await gwG.invoke(chamadaGw(runG, `sc05:p5b:${randomUUID().slice(0, 8)}`, argsF, 0, 'ask_pending_question'));

    // O handler NÃO rodou de novo e nenhuma pergunta nova nasceu.
    expect(fixture.pendencia).toBe(5);
    expect(await contarPendencias(conversaF)).toBe(1);
    // O que voltou não oferece a pergunta vencida — e o registro também não.
    expect((rG as { result: { pending_question_id?: string } }).result.pending_question_id).toBeUndefined();
    expect((rG as { result: { opcoes_validas?: unknown[] } }).result.opcoes_validas).toBeUndefined();
    expect(((await lerCall(runG, (await pool.query<{ call_id: string }>(
      `SELECT call_id FROM engine_tool_calls WHERE run_id = $1 ORDER BY ordinal DESC LIMIT 1`,
      [runG],
    )).rows[0]!.call_id)).receipt_json as { pending_question_id?: string | null }).pending_question_id).toBeNull();
    // A pergunta vencida continua `aberta` e sem resposta: o gateway suprime, não
    // cancela nem ressuscita.
    expect((await lerPendencia(idF)).status).toBe('aberta');
  });
});