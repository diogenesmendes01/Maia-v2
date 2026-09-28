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
 *  7. Crash REAL entre o marcador e o `consume` (pedido preso em `claimed`, call
 *     órfã em `handler_started`): o turno NOVO reconcilia pelo JOURNAL — a
 *     evidência vira `execution_failed`, ZERO handler, e um pedido NOVO nasce
 *     com o MESMO fingerprint, destravando a intenção (AC04/AC06).
 *  8. Claim SEM carimbo: o estado do banco é o MESMO para um dono vivo e para um
 *     processo morto — e é o fence do marcador que os separa. Dono VIVO ⇒ a
 *     evidência é SEGURADA (`pending`, zero handler, nenhum pedido novo); fence
 *     morto (a lease do turno parou de ser renovada: o que um crash deixa) ⇒ a
 *     MESMA evidência volta a `approved` e executa UMA vez (AC04).
 *  9. Executor VIVO entre o claim e o marcador (QA-P4): o turno concorrente NÃO
 *     herda o claim, a evidência nunca volta a `approved` depois do efeito, UM
 *     handler, e a repetição depois da janela de idempotência exige aprovação
 *     NOVA (AC03/AC04/AC06/SPEC-L1406).
 * 10. Executor VIVO DENTRO do handler (P5): o turno concorrente não fecha a
 *     evidência de quem está executando; o ledger termina `consumed`, coerente
 *     com o efeito real, sem pedido novo (AC04/AC06).
 * 11. Fence do banco: evidência devolvida (`claimed → approved`) não deixa o
 *     dono antigo iniciar — o marcador exige o claim VIGENTE (AC04).
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
    /**
     * Casos 9/10 (F2/QA-P5) — o portão que PAUSA um executor DENTRO do handler.
     * Sem ele não existe o estado "executor VIVO entre o claim e o consume": os
     * dois cenários de corrida precisam de um dono que já entrou no handler e
     * ainda não saiu.
     */
    gate: null as Promise<void> | null,
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
          // O contador sobe ANTES do portão: o caso 10 mede "o handler começou
          // e AINDA não terminou" — a janela em que a evidência dele não pode
          // ser fechada por um turno concorrente.
          if (fixture.gate) await fixture.gate;
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

import { dispatchToolDurable, dispatchTool } from '@/tools/_dispatcher.js';
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

/**
 * §5.5.1 (SC05) — O CRASH DE VERDADE, para o turno: o processo para de renovar
 * a lease e o fence do marcador morre. É a ÚNICA diferença observável entre um
 * dono vivo (que pode iniciar a qualquer instante) e um processo morto — a fase
 * do run e o estado da call são idênticos nos dois.
 */
async function expirarLeaseDoTurno(turn_id: string): Promise<void> {
  const r = await pool.query(
    `UPDATE agent_turns SET lease_expires_at = now() - interval '1 minute'
      WHERE tenant_id = $1 AND agent_id = $2 AND id = $3`,
    [TENANT, AGENT, turn_id],
  );
  if (r.rowCount !== 1) throw new Error(`lease do turno não expirou: ${turn_id}`);
}

const espera = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
 * §5.5.1 (SC05) — O ESTADO QUE UM SIGKILL DEIXA, montado a partir de uma
 * execução REAL.
 *
 * O crash que o AC04 descreve não é reproduzível dentro do processo: o
 * dispatcher sempre passa por `consume`, `failClaimedApproval` ou
 * `releaseClaimedApproval` antes de morrer, porque esses caminhos são código
 * dele. O que um `kill -9` deixa é outra coisa — o pedido `claimed` (com o
 * token que a call carrega) e a call no journal exatamente como estava no
 * instante da morte. É esse estado que se recria aqui, a partir das rows que
 * uma execução REAL produziu, sem inventar transição nenhuma:
 *
 *   * a evidência volta a `claimed` com o token da call — o CHECK da migration
 *     095 exige token justamente nesse estado, e é ele que o CAS de recovery
 *     vai exigir de volta;
 *   * `aposMarcador: false` limpa o carimbo de início e o desfecho da call: é o
 *     processo que morreu ENTRE o claim e o marcador. Nada rodou, e o journal
 *     diz isso;
 *   * `aposMarcador: true` deixa a call intacta (carimbo de início presente):
 *     o processo morreu ENTRE o marcador e o `consume`;
 *   * a reserva de idempotência é REMOVIDA para representar um cache podado ou
 *     vencido — sem isso a repetição nem chegaria à máquina de aprovação, e o
 *     que se mediria seria o ledger de idempotência, não o AC04.
 *
 * Nada aqui decide o desfecho: quem decide é o turno NOVO, pelo caminho real.
 */
async function simularCrashDoClaim(input: {
  run_id: string;
  call_id: string;
  pedido_id: string;
  aposMarcador: boolean;
}): Promise<string> {
  const call = await lerCall(input.run_id, input.call_id);
  const token = call.approval_claim_token;
  if (token === null) throw new Error('call sem approval_claim_token para simular o crash');
  const r = await pool.query(
    `UPDATE approval_requests SET status = 'claimed', claim_token = $2, updated_at = now()
      WHERE id = $1 AND status = 'consumed'`,
    [input.pedido_id, token],
  );
  if (r.rowCount !== 1) throw new Error(`crash simulado não aplicou no pedido: ${input.pedido_id}`);
  if (!input.aposMarcador) {
    await pool.query(
      `UPDATE engine_tool_calls
          SET state = 'dispatching', handler_started_at = NULL,
              finished_at = NULL, result_json = NULL,
              receipt_json = NULL, receipt_hash = NULL
        WHERE run_id = $1 AND call_id = $2`,
      [input.run_id, input.call_id],
    );
  } else {
    // Morreu depois do marcador, antes do `consume`: a call fica `handler_started`
    // (o carimbo existe, e com ele os dois tokens que o CHECK exige) e SEM
    // desfecho gravado.
    await pool.query(
      `UPDATE engine_tool_calls
          SET state = 'handler_started', finished_at = NULL,
              result_json = NULL, receipt_json = NULL, receipt_hash = NULL
        WHERE run_id = $1 AND call_id = $2`,
      [input.run_id, input.call_id],
    );
  }
  await pool.query(
    `DELETE FROM idempotency_keys
      WHERE tenant_id = $1 AND agent_id = $2 AND tool_name = 'create_contraparte' AND pessoa_id = $3`,
    [TENANT, AGENT, PESSOA_ID],
  );
  return token;
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

/** Quantas calls do JOURNAL carregam este pedido (o «journal ligado» do SC05). */
async function contarCallsDoPedido(approval_request_id: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT count(*) AS c FROM engine_tool_calls
      WHERE tenant_id = $1 AND agent_id = $2 AND approval_request_id = $3`,
    [TENANT, AGENT, approval_request_id],
  );
  return Number(r.rows[0]?.c ?? 0);
}

/**
 * O caminho LEGADO (`dispatchTool`, `run === null`) — em produção neste SHA é
 * ELE que roda: `runtime/engines/reasoner-stage.ts`, `scheduling/engine.ts` e
 * `agent/pending-resolver.ts` chamam `dispatchTool`, e nenhum chamador de `src`
 * usa `dispatchToolDurable`.
 *
 * Sem `run`, o dispatcher não abre call no `engine_tool_calls`: o pedido de
 * aprovação existe no banco e NENHUMA linha do journal o carrega. É essa a
 * forma do caminho — e é por isso que a política de recovery do claim não pode
 * tratar "sem call ligada" como prova de não início.
 */
const legado = (args: Record<string, unknown>) =>
  noEscopo(() =>
    dispatchTool({
      tool: 'create_contraparte',
      args,
      ctx: { ...ctxBase, request_id: randomUUID() } as never,
    }),
  );

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
    fixture.gate = null;
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
        journal_call_linked: true,
        start_uncertain: false,
        can_still_start: false,
        execution_in_flight: false,
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
        journal_call_linked: true,
        start_uncertain: false,
        can_still_start: false,
        execution_in_flight: false,
      }),
    ).toBe('release_claim');

    // ── TTL NÃO libera efeito — e não é ele que decide ────────────────────
    //
    // O pedido volta a 'claimed' e VENCIDO, com o journal ainda provando NÃO
    // INÍCIO (o carimbo foi removido no bloco acima). A idade não é critério:
    // quem decide é o journal. O claim é DEVOLVIDO (a evidência volta a
    // 'approved') — e, por estar vencida, é ENCERRADA em seguida pela regra de
    // vencimento, porque `claim` exige `expires_at > now()`. O desfecho é
    // 'none': nenhum efeito, nenhuma execução, e um pedido NOVO é o único
    // caminho — o fingerprint não fica preso atrás de uma evidência que já não
    // pode executar. É esta a diferença entre "TTL libera efeito" (proibido) e
    // "TTL fecha a janela de uma evidência cujo efeito não começou" (exigido).
    await pool.query(
      `UPDATE approval_requests SET status = 'claimed', claim_token = $2, expires_at = now() - interval '1 hour'
        WHERE id = $1`,
      [pedido.id, rowExec.approval_claim_token],
    );
    const comClaimVencido = await noEscopo(() =>
      claimExecutableApproval({ intent_hash: pedido.intent_hash, requester: pessoaBase }),
    );
    expect(comClaimVencido.outcome).toBe('none');
    const aposTtl = await lerAprovacao(pedido.id);
    expect(aposTtl.status).toBe('expired');
    expect(aposTtl.claim_token).toBeNull();
    // Devolver com o token ERRADO nunca passa.
    expect(await lerAprovacaoDevolvida(pedido.id, randomUUID())).toBe(false);

    // ── o MESMO cenário, com o journal provando INÍCIO: terminal ───────────
    // O vencimento não muda a resposta do CAS nem da política: com o carimbo
    // de início, o claim continua RECUSADO — TTL não transforma "pode ter
    // acontecido" em "não aconteceu".
    await pool.query(
      `UPDATE approval_requests SET status = 'claimed', claim_token = $2, expires_at = now() - interval '1 hour'
        WHERE id = $1`,
      [pedido.id, rowExec.approval_claim_token],
    );
    await pool.query(
      `UPDATE engine_tool_calls SET effect_class = 'non_interruptible', handler_started_at = now() - interval '1 minute'
        WHERE run_id = $1 AND call_id = $2`,
      [run2, call2],
    );
    expect(
      await lerAprovacaoDevolvida(pedido.id, rowExec.approval_claim_token!),
    ).toBe(false);
    const reivindicadoVencido = await noEscopo(() =>
      claimExecutableApproval({ intent_hash: pedido.intent_hash, requester: pessoaBase }),
    );
    expect(reivindicadoVencido.outcome).toBe('none');
    expect((await lerAprovacao(pedido.id)).status).toBe('execution_failed');

    // A incerteza do próprio journal é tratada como início comprovado.
    expect(
      classifyApprovalClaimRecovery({
        approval_status: 'claimed',
        handler_started: false,
        effect_class: null,
        journal_call_linked: true,
        start_uncertain: true,
        can_still_start: false,
        execution_in_flight: false,
      }),
    ).toBe('execution_failed');
    expect(fixture.contraparte).toBe(1);
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
        journal_call_linked: true,
        start_uncertain: false,
        can_still_start: false,
        execution_in_flight: false,
      }),
    ).toBe('execution_failed');

    // ── as DUAS regras de espera: o carimbo ausente não é prova de não início ─
    //
    // Sem carimbo, mas com o fence do turno ainda valendo, o dono do claim pode
    // cruzar o marcador a qualquer instante: o instantâneo NÃO prova não início
    // e a evidência é SEGURADA — é a corrida que o QA reproduziu (QA-P4). O MESMO
    // instantâneo, com o fence morto (lease vencida), é prova de não início.
    expect(
      classifyApprovalClaimRecovery({
        approval_status: 'claimed',
        handler_started: false,
        effect_class: null,
        journal_call_linked: true,
        start_uncertain: false,
        can_still_start: true,
        execution_in_flight: false,
      }),
    ).toBe('hold');
    expect(
      classifyApprovalClaimRecovery({
        approval_status: 'claimed',
        handler_started: false,
        effect_class: null,
        journal_call_linked: true,
        start_uncertain: false,
        can_still_start: false,
        execution_in_flight: false,
      }),
    ).toBe('release_claim');

    // E com o carimbo posto, quem segura é a EXECUÇÃO EM VOO (a reserva viva do
    // efeito): fechar a evidência enquanto o handler roda é o P5 do QA.
    expect(
      classifyApprovalClaimRecovery({
        approval_status: 'claimed',
        handler_started: true,
        effect_class: 'nil',
        journal_call_linked: true,
        start_uncertain: false,
        can_still_start: false,
        execution_in_flight: true,
      }),
    ).toBe('hold');
    expect(
      classifyApprovalClaimRecovery({
        approval_status: 'claimed',
        handler_started: true,
        effect_class: 'nil',
        journal_call_linked: true,
        start_uncertain: false,
        can_still_start: false,
        execution_in_flight: false,
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

  // ══════════════════════════════════════════════════════════════════════════
  // 7. crash REAL pós-marcador: o claim órfão é reconciliado pelo caminho real
  // ══════════════════════════════════════════════════════════════════════════
  it('7. AC04/AC06 — crash entre o marcador e o consume: novo turno reconcilia pelo JOURNAL e a evidência vira execution_failed (nova aprovação, zero handler)', async () => {
    const nonce = randomUUID();
    const args = { texto: 'orfao-pos-marcador', nonce };

    // ── o pedido nasce e é aprovado por humanos ────────────────────────────
    const turno1 = await mkTurnoVivo();
    const run1 = await runRodando(turno1, await mkControle());
    const call1 = `sc05:orf1:${randomUUID().slice(0, 8)}`;
    await gatewayReal(turno1, run1).invoke(chamadaGw(run1, call1, args));
    const pedido = (await pedidosDoNonce(nonce))[0]!;
    await aprovarPorSql(pedido.id);

    // ── uma execução REAL reivindica a evidência e roda o handler ──────────
    const turno2 = await mkTurnoVivo();
    const run2 = await runRodando(turno2, await mkControle());
    const call2 = `sc05:orf2:${randomUUID().slice(0, 8)}`;
    const r2 = await gatewayReal(turno2, run2).invoke(chamadaGw(run2, call2, args));
    expect(r2).toMatchObject({ kind: 'result', is_error: false });
    expect(fixture.contraparte).toBe(1);
    expect((await lerCall(run2, call2)).approval_request_id).toBe(pedido.id);

    // ── o processo MORRE antes do consume e o pedido fica preso em 'claimed' ─
    const tokenDoCrash = await simularCrashDoClaim({
      run_id: run2,
      call_id: call2,
      pedido_id: pedido.id,
      aposMarcador: true,
    });
    const orfa = await lerCall(run2, call2);
    expect(orfa.state).toBe('handler_started');
    expect(orfa.handler_started_at).not.toBeNull();
    const presa = await lerAprovacao(pedido.id);
    expect(presa.status).toBe('claimed');
    expect(presa.claim_token).toBe(tokenDoCrash);
    // O estado ANTES da correção: `claimed` está em OPEN_STATUSES, então este
    // pedido — que ninguém consegue decidir — bloqueia a partial unique do
    // fingerprint e a operação fica presa para sempre.
    expect(await pedidosAbertosDoFingerprint(pedido.fingerprint)).toHaveLength(1);

    // ── turno NOVO (mensagem nova, mesmo intent): quem reconcilia é o caminho
    // real — gateway → dispatcher → claimExecutableApproval ────────────────
    const turno3 = await mkTurnoVivo();
    const run3 = await runRodando(turno3, await mkControle());
    const call3 = `sc05:orf3:${randomUUID().slice(0, 8)}`;
    const r3 = await gatewayReal(turno3, run3).invoke(chamadaGw(run3, call3, args));

    // ZERO handler: a reconciliação não executa nada, nem "retoma" o run antigo.
    expect(fixture.contraparte).toBe(1);
    expect(r3).toMatchObject({ kind: 'result', is_error: true });

    // O pedido órfão vira TERMINAL — o journal provou o início, e uma execução
    // que pode ter acontecido exige aprovação NOVA (§5.5.1, INV-09).
    const posRecuperacao = await lerAprovacao(pedido.id);
    expect(posRecuperacao.status).toBe('execution_failed');
    expect(await pedidosAbertosDoFingerprint(pedido.fingerprint)).toHaveLength(1);

    // O pedido NOVO tem o MESMO fingerprint/hash — a intenção é a mesma, a
    // EVIDÊNCIA é que não se transfere.
    const novos = await pedidosDoNonce(nonce);
    expect(novos).toHaveLength(2);
    const novo = novos[1]!;
    expect(novo.id).not.toBe(pedido.id);
    expect(novo.status).toBe('pending');
    expect(novo.fingerprint).toBe(pedido.fingerprint);
    expect(novo.intent_hash).toBe(pedido.intent_hash);

    const row3 = await lerCall(run3, call3);
    expect(row3.state).toBe('approval_required');
    expect(row3.approval_request_id).toBe(novo.id);
    expect(row3.handler_started_at).toBeNull();

    // A call órfã NÃO é ressuscitada nem reescrita: o journal guarda o que
    // aconteceu, e quem reconcilia o RUN (não a aprovação) é o motor de recovery.
    const orfaDepois = await lerCall(run2, call2);
    expect(orfaDepois.state).toBe('handler_started');
    expect(orfaDepois.handler_started_at).toEqual(orfa.handler_started_at);
    expect(orfaDepois.receipt_json).toBeNull();

    // ── e o fingerprint DESTRAVOU: aprovado o pedido novo, a operação executa
    // UMA vez (o efeito antigo não foi reemitido por causa disso) ───────────
    await aprovarPorSql(novo.id);
    const turno4 = await mkTurnoVivo();
    const run4 = await runRodando(turno4, await mkControle());
    const call4 = `sc05:orf4:${randomUUID().slice(0, 8)}`;
    const r4 = await gatewayReal(turno4, run4).invoke(chamadaGw(run4, call4, args));
    expect(r4).toMatchObject({ kind: 'result', is_error: false });
    expect(fixture.contraparte).toBe(2);
    expect((await lerAprovacao(novo.id)).status).toBe('consumed');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 8. claim SEM carimbo: dono VIVO segura a evidência; lease morta a devolve
  // ══════════════════════════════════════════════════════════════════════════
  it('8. AC04 — claim sem carimbo: o dono VIVO não perde a evidência; com o fence morto (crash) ela volta e executa UMA vez', async () => {
    const nonce = randomUUID();
    const args = { texto: 'orfao-antes-do-marcador', nonce };

    const turno1 = await mkTurnoVivo();
    const run1 = await runRodando(turno1, await mkControle());
    const call1 = `sc05:pre1:${randomUUID().slice(0, 8)}`;
    await gatewayReal(turno1, run1).invoke(chamadaGw(run1, call1, args));
    const pedido = (await pedidosDoNonce(nonce))[0]!;
    await aprovarPorSql(pedido.id);

    const turno2 = await mkTurnoVivo();
    const run2 = await runRodando(turno2, await mkControle());
    const call2 = `sc05:pre2:${randomUUID().slice(0, 8)}`;
    await gatewayReal(turno2, run2).invoke(chamadaGw(run2, call2, args));
    expect(fixture.contraparte).toBe(1);

    // ── o processo morre ANTES do marcador: o claim existe, o carimbo não ──
    const tokenDoCrash = await simularCrashDoClaim({
      run_id: run2,
      call_id: call2,
      pedido_id: pedido.id,
      aposMarcador: false,
    });
    const orfa = await lerCall(run2, call2);
    expect(orfa.state).toBe('dispatching');
    expect(orfa.handler_started_at).toBeNull();
    expect((await lerAprovacao(pedido.id)).status).toBe('claimed');

    /**
     * ── O MESMO estado do banco, mas o dono AINDA VIVO: a evidência é SEGURA ──
     *
     * «Sem carimbo» NÃO é prova de não início: `turno2` continua com a lease
     * viva, então a tentativa que reivindicou a evidência ainda pode cruzar o
     * marcador a qualquer instante. Era exatamente este o defeito que o QA
     * reproduziu (QA-P4): a evidência era devolvida, o dono antigo executava
     * depois e a MESMA aprovação autorizava um segundo efeito. Enquanto o fence
     * do marcador autoriza AQUELA tentativa, a resposta é `pending`: um turno
     * novo recebe `approval_required` apontando para o pedido `claimed`, sem
     * handler e sem pedido novo.
     */
    const turnoVivo = await mkTurnoVivo();
    const runVivo = await runRodando(turnoVivo, await mkControle());
    const callVivo = `sc05:pre2v:${randomUUID().slice(0, 8)}`;
    const rVivo = await gatewayReal(turnoVivo, runVivo).invoke(chamadaGw(runVivo, callVivo, args));
    expect(rVivo).toMatchObject({ kind: 'result', is_error: true });
    expect(fixture.contraparte).toBe(1);
    const retida = await lerAprovacao(pedido.id);
    expect(retida.status).toBe('claimed');
    expect(retida.claim_token).toBe(tokenDoCrash);
    expect(await pedidosDoNonce(nonce)).toHaveLength(1);

    // ── agora sim o crash: o heartbeat para e a lease do turno morre ──────
    //
    // É ESTA a diferença entre um dono vivo e um processo morto — e é a única.
    // Um crash real não muda a fase do run nem o estado da call: ele para de
    // renovar `agent_turns.lease_expires_at`, e é o fence do marcador que passa
    // a recusar a tentativa antiga.
    await expirarLeaseDoTurno(turno2.turn_id);

    // ── turno NOVO: a prova de NÃO INÍCIO devolve a evidência e ela executa ─
    const turno3 = await mkTurnoVivo();
    const run3 = await runRodando(turno3, await mkControle());
    const call3 = `sc05:pre3:${randomUUID().slice(0, 8)}`;
    const r3 = await gatewayReal(turno3, run3).invoke(chamadaGw(run3, call3, args));

    // UM handler — o do turno novo —, sob o MESMO pedido de aprovação: a
    // evidência humana voltou a valer porque a tentativa antiga comprovadamente
    // já não pode iniciar (o fence dela está morto), e o consume é dela.
    expect(fixture.contraparte).toBe(2);
    expect(r3).toMatchObject({ kind: 'result', is_error: false });
    const row3 = await lerCall(run3, call3);
    expect(row3.state).toBe('completed');
    expect(row3.approval_request_id).toBe(pedido.id);
    expect(row3.approval_claim_token).not.toBeNull();
    expect(row3.approval_claim_token).not.toBe(tokenDoCrash);

    const depois = await lerAprovacao(pedido.id);
    expect(depois.status).toBe('consumed');
    expect(depois.claim_token).toBe(row3.approval_claim_token);

    // Nenhum pedido NOVO foi criado: a evidência devolvida é a MESMA, porque o
    // journal provou que o handler não chegou a rodar. Devolver aqui não é
    // reutilizar evidência gasta — é não gastar uma evidência que não executou.
    expect(await pedidosDoNonce(nonce)).toHaveLength(1);
    expect((await lerCall(run2, call2)).handler_started_at).toBeNull();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 9. executor VIVO entre o claim e o marcador (F2 / QA-P4)
  // ══════════════════════════════════════════════════════════════════════════
  it('9. AC03/AC04/AC06/SPEC-L1406 — executor VIVO antes do marcador: o turno concorrente NÃO herda o claim, UM efeito, sem reexecução depois', async () => {
    const nonce = randomUUID();
    const args = { texto: 'sc05-vivo-antes-do-marcador', nonce };

    const turno1 = await mkTurnoVivo();
    const run1 = await runRodando(turno1, await mkControle());
    await gatewayReal(turno1, run1).invoke(chamadaGw(run1, `sc05:v4p:${randomUUID().slice(0, 8)}`, args));
    const pedido = (await pedidosDoNonce(nonce))[0]!;
    await aprovarPorSql(pedido.id);

    // ── A: reivindica a evidência e PAUSA antes do marcador ──────────────
    let soltarA!: () => void;
    const gateA = new Promise<void>((r) => (soltarA = r));
    let chegouAoMarcador!: () => void;
    const noMarcador = new Promise<void>((r) => (chegouAoMarcador = r));
    const turnoA = await mkTurnoVivo();
    const runA = await runRodando(turnoA, await mkControle());
    const callA = `sc05:v4A:${randomUUID().slice(0, 8)}`;
    const gwA = gatewayReal(turnoA, runA, {
      over: {
        markToolHandlerStarted: async (
          i: Parameters<ToolGatewayDepsV1['markToolHandlerStarted']>[0],
        ) => {
          chegouAoMarcador();
          await gateA;
          return noEscopo(() => engineRunsRepo.markToolHandlerStarted(i)) as never;
        },
      },
    });
    const pA = gwA.invoke(chamadaGw(runA, callA, args));
    await noMarcador;

    const durante = await lerAprovacao(pedido.id);
    expect(durante.status).toBe('claimed');
    expect(fixture.contraparte).toBe(0);
    const tokenA = durante.claim_token!;

    // ── B: turno CONCORRENTE, mesma intenção, com A vivo ────────────────
    const turnoB = await mkTurnoVivo();
    const runB = await runRodando(turnoB, await mkControle());
    const callB = `sc05:v4B:${randomUUID().slice(0, 8)}`;
    const pB = gatewayReal(turnoB, runB).invoke(chamadaGw(runB, callB, args));

    // Dá a B a chance de TENTAR tomar a evidência. O que ele NÃO pode fazer é
    // mudar quem é o dono: o claim tem de continuar sendo o de A.
    await espera(1500);
    const aposB = await lerAprovacao(pedido.id);
    const callBRow = await lerCall(runB, callB);
    expect(fixture.contraparte).toBe(0);

    soltarA();
    const [resA, resB] = await Promise.all([pA, pB]);

    // O claim de A não foi tomado, a evidência não voltou a `approved` e B não
    // emitiu efeito nenhum: B é recusado com a aprovação do MESMO pedido.
    expect(aposB.status).toBe('claimed');
    expect(aposB.claim_token).toBe(tokenA);
    expect(resB).toMatchObject({ kind: 'result', is_error: true });
    expect(callBRow.state).toBe('approval_required');
    expect(callBRow.approval_request_id).toBe(pedido.id);

    // A conclui: UM efeito, e o efeito CONSOME a evidência (nunca volta a
    // `approved` depois de um efeito — o defeito do QA-P4).
    expect(resA).toMatchObject({ kind: 'result', is_error: false });
    expect(fixture.contraparte).toBe(1);
    const fim = await lerAprovacao(pedido.id);
    expect(fim.status).toBe('consumed');

    // ── repetição DEPOIS da janela de idempotência: NÃO executa de novo ──
    await pool.query(
      `DELETE FROM idempotency_keys
        WHERE tenant_id = $1 AND agent_id = $2 AND tool_name = 'create_contraparte' AND pessoa_id = $3`,
      [TENANT, AGENT, PESSOA_ID],
    );
    const turnoC = await mkTurnoVivo();
    const runC = await runRodando(turnoC, await mkControle());
    const callC = `sc05:v4C:${randomUUID().slice(0, 8)}`;
    const resC = await gatewayReal(turnoC, runC).invoke(chamadaGw(runC, callC, args));

    expect(fixture.contraparte).toBe(1);
    expect(resC).toMatchObject({ kind: 'result', is_error: true });
    const pedidos = await pedidosDoNonce(nonce);
    expect(pedidos).toHaveLength(2);
    expect(pedidos[0]!.status).toBe('consumed');
    expect(pedidos[1]!.status).toBe('pending');
    expect((await lerCall(runC, callC)).approval_request_id).toBe(pedidos[1]!.id);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 10. executor VIVO DENTRO do handler (P5)
  // ══════════════════════════════════════════════════════════════════════════
  it('10. AC04/AC06 — executor VIVO dentro do handler: o turno concorrente não fecha a evidência dele', async () => {
    const nonce = randomUUID();
    const args = { texto: 'sc05-vivo-no-handler', nonce };

    const turno1 = await mkTurnoVivo();
    const run1 = await runRodando(turno1, await mkControle());
    await gatewayReal(turno1, run1).invoke(chamadaGw(run1, `sc05:v5p:${randomUUID().slice(0, 8)}`, args));
    const pedido = (await pedidosDoNonce(nonce))[0]!;
    await aprovarPorSql(pedido.id);

    // ── A: entra no handler e FICA lá ───────────────────────────────────
    let soltar!: () => void;
    fixture.gate = new Promise<void>((r) => (soltar = r));
    const turnoA = await mkTurnoVivo();
    const runA = await runRodando(turnoA, await mkControle());
    const callA = `sc05:v5A:${randomUUID().slice(0, 8)}`;
    const pA = gatewayReal(turnoA, runA).invoke(chamadaGw(runA, callA, args));
    for (let i = 0; i < 100 && fixture.contraparte === 0; i++) await espera(50);
    expect(fixture.contraparte).toBe(1);
    const durante = await lerAprovacao(pedido.id);
    expect(durante.status).toBe('claimed');

    // ── B: turno concorrente enquanto A está DENTRO do handler ──────────
    const turnoB = await mkTurnoVivo();
    const runB = await runRodando(turnoB, await mkControle());
    const callB = `sc05:v5B:${randomUUID().slice(0, 8)}`;
    const resB = await gatewayReal(turnoB, runB).invoke(chamadaGw(runB, callB, args));
    const aposB = await lerAprovacao(pedido.id);
    const pedidosAposB = await pedidosDoNonce(nonce);

    soltar();
    fixture.gate = null;
    const resA = await pA;

    /**
     * O LEDGER TEM DE CONCORDAR COM O EFEITO REAL.
     *
     * O dono está VIVO e dentro do handler: declarar `execution_failed` aqui
     * afirmaria um desfecho terminal sobre uma execução em voo (e o efeito que
     * ela produziria ficaria sem a evidência que o autoriza). B recebe a mesma
     * recusa de aprovação de sempre — e quem fecha a evidência é A, consumindo.
     */
    expect(aposB.status).toBe('claimed');
    expect(pedidosAposB).toHaveLength(1);
    expect(fixture.contraparte).toBe(1);
    expect(resA).toMatchObject({ kind: 'result', is_error: false });
    expect(resB).toMatchObject({ kind: 'result', is_error: true });
    const fim = await lerAprovacao(pedido.id);
    expect(fim.status).toBe('consumed');
    expect((await lerCall(runA, callA)).state).toBe('completed');
    expect(await pedidosDoNonce(nonce)).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 11. o marcador é CERCADO pelo claim (fence do banco)
  // ══════════════════════════════════════════════════════════════════════════
  it('11. AC04 — evidência devolvida não deixa o dono antigo iniciar: o marcador exige o claim VIGENTE', async () => {
    const nonce = randomUUID();
    const args = { texto: 'sc05-fence-do-marcador', nonce };

    const turno1 = await mkTurnoVivo();
    const run1 = await runRodando(turno1, await mkControle());
    await gatewayReal(turno1, run1).invoke(chamadaGw(run1, `sc05:fc1:${randomUUID().slice(0, 8)}`, args));
    const pedido = (await pedidosDoNonce(nonce))[0]!;
    await aprovarPorSql(pedido.id);

    // ── A: reivindica a evidência e PAUSA antes do marcador ──────────────
    let soltarA!: () => void;
    const gateA = new Promise<void>((r) => (soltarA = r));
    let chegouAoMarcador!: () => void;
    const noMarcador = new Promise<void>((r) => (chegouAoMarcador = r));
    const turnoA = await mkTurnoVivo();
    const runA = await runRodando(turnoA, await mkControle());
    const callA = `sc05:fcA:${randomUUID().slice(0, 8)}`;
    const gwA = gatewayReal(turnoA, runA, {
      over: {
        markToolHandlerStarted: async (
          i: Parameters<ToolGatewayDepsV1['markToolHandlerStarted']>[0],
        ) => {
          chegouAoMarcador();
          await gateA;
          return noEscopo(() => engineRunsRepo.markToolHandlerStarted(i)) as never;
        },
      },
    });
    const pA = gwA.invoke(chamadaGw(runA, callA, args));
    await noMarcador;

    const durante = await lerAprovacao(pedido.id);
    expect(durante.status).toBe('claimed');
    const tokenA = durante.claim_token!;

    // ── a evidência é DEVOLVIDA enquanto A está vivo (o defeito do QA-P4) ──
    //
    // É a devolução real do repositório — o CAS que exige a prova de não início
    // no journal —, e ela é ACEITA (não há carimbo algum).
    expect(await lerAprovacaoDevolvida(pedido.id, tokenA)).toBe(true);
    expect((await lerAprovacao(pedido.id)).status).toBe('approved');

    // ── o dono ANTIGO não inicia mesmo assim ──────────────────────────────
    //
    // O marcador é cercado pelo claim: `status = 'claimed' AND claim_token =
    // <o meu>`. Uma evidência devolvida deixa de autorizar quem a tinha — é isso
    // que torna a devolução segura, e é isso que impede a mesma aprovação de
    // autorizar dois efeitos (§5.5.1).
    soltarA();
    const resA = await pA;
    const rowA = await lerCall(runA, callA);
    expect(rowA.handler_started_at).toBeNull();
    expect(fixture.contraparte).toBe(0);
    expect(resA).toMatchObject({ kind: 'refused', code: 'run_not_authorized' });
    expect(rowA.state).toBe('denied');
    // E a evidência continua intacta e executável para quem a reivindicar de
    // novo (devolver não é gastar): o pedido segue `approved`.
    expect((await lerAprovacao(pedido.id)).status).toBe('approved');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 12. caminho LEGADO (`run === null`) — o que roda em produção neste SHA
  // ══════════════════════════════════════════════════════════════════════════
  it('12. AC03/AC04/AC06/SPEC-L1406 — caminho LEGADO: executor VIVO no handler não é destituído, UM efeito e pedido NOVO fora da janela', async () => {
    const nonce = randomUUID();
    const args = { texto: 'sc05-legado', nonce };

    // ── 1ª chamada: abre o pedido humano e NÃO executa ────────────────────
    const primeira = (await legado(args)) as { error?: string };
    expect(primeira.error).toBe('requires_dual_approval');
    expect(fixture.contraparte).toBe(0);
    const pedido = (await pedidosDoNonce(nonce))[0]!;
    await aprovarPorSql(pedido.id);

    // O TRAÇO do caminho legado: o pedido existe e o journal NÃO tem call que
    // o carregue. É esta ausência que a recovery do claim não pode ler como
    // prova de não início (F3 da rodada 3 do QA).
    expect(await contarCallsDoPedido(pedido.id)).toBe(0);

    // ── A: dono VIVO DENTRO do handler (pausado pelo portão da fixture) ───
    let soltarA!: () => void;
    fixture.gate = new Promise<void>((r) => (soltarA = r));
    const pA = legado(args);
    for (let i = 0; i < 100 && fixture.contraparte === 0; i += 1) await espera(50);
    expect(fixture.contraparte).toBe(1);

    const durante = await lerAprovacao(pedido.id);
    expect(durante.status).toBe('claimed');
    const tokenA = durante.claim_token!;

    // ── B: MESMA intenção, concorrente, com A vivo no handler ─────────────
    //
    // B não pode destituir A: a ausência de call no journal não prova que o
    // dono do claim não vai começar (ou não está começando agora). A resposta
    // honesta é a mesma da base — 'approval_pending' do MESMO pedido.
    //
    // B é disparado SEM await em propósito: enquanto A está vivo, o desfecho de
    // B só pode ser observado com A ainda no handler. Se a evidência de A for
    // devolvida no meio, o estado é lido DEPOIS da tentativa de B — é o defeito
    // do QA-P6, e é ele que esta janela mede.
    const pB = legado(args);
    await espera(1500);
    const aposB = await lerAprovacao(pedido.id);
    expect(aposB.status).toBe('claimed');
    expect(aposB.claim_token).toBe(tokenA);
    expect(fixture.contraparte).toBe(1);

    // ── A conclui: UM efeito, e a evidência é CONSUMIDA ───────────────────
    soltarA();
    fixture.gate = null;
    const [resA, resB] = await Promise.all([pA, pB]);
    expect((resA as { error?: string }).error).toBeUndefined();
    expect((resB as { error?: string }).error).toBe('approval_pending');
    expect(fixture.contraparte).toBe(1);
    expect((await lerAprovacao(pedido.id)).status).toBe('consumed');

    // ── repetição DEPOIS da janela de idempotência: pedido NOVO ───────────
    //
    // O cache de idempotência é podado (em produção, o bucket de 5 min vira) e
    // a chamada volta pelo caminho real. O pedido consumido NÃO é reutilizado:
    // a operação exige uma aprovação NOVA e não emite efeito antes disso.
    await pool.query(
      `DELETE FROM idempotency_keys
        WHERE tenant_id = $1 AND agent_id = $2 AND tool_name = 'create_contraparte' AND pessoa_id = $3`,
      [TENANT, AGENT, PESSOA_ID],
    );
    const resC = (await legado(args)) as { error?: string };
    expect(fixture.contraparte).toBe(1);
    expect(resC.error).toBe('requires_dual_approval');
    const pedidos = await pedidosDoNonce(nonce);
    expect(pedidos).toHaveLength(2);
    expect(pedidos[0]!.status).toBe('consumed');
    expect(pedidos[1]!.status).toBe('pending');
    expect(pedidos[1]!.id).not.toBe(pedido.id);
    expect(pedidos[1]!.fingerprint).toBe(pedido.fingerprint);
    expect(await contarCallsDoPedido(pedido.id)).toBe(0);

    // ── a POLÍTICA PURA, no instantâneo exato do caminho legado ───────────
    //
    // Sem call ligada ao pedido, `handler_started` e os dois sinais de
    // vitalidade são estruturalmente falsos — eles olham o journal que não
    // existe. "Não começou" deixa de ser fato PROVADO e a evidência é
    // SEGURADA; devolver aqui é que autorizaria dois efeitos com a MESMA
    // aprovação (o QA-P6).
    expect(
      classifyApprovalClaimRecovery({
        approval_status: 'claimed',
        handler_started: false,
        effect_class: null,
        start_uncertain: false,
        can_still_start: false,
        execution_in_flight: false,
        journal_call_linked: false,
      }),
    ).toBe('hold');
    // Controle diferencial: o MESMO instantâneo com a call ligada ao pedido (o
    // caminho durável, onde os dois sinais têm significado) é prova de não
    // início e devolve a evidência.
    expect(
      classifyApprovalClaimRecovery({
        approval_status: 'claimed',
        handler_started: false,
        effect_class: null,
        start_uncertain: false,
        can_still_start: false,
        execution_in_flight: false,
        journal_call_linked: true,
      }),
    ).toBe('release_claim');
  });
});