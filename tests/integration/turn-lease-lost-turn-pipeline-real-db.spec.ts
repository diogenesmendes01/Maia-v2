/**
 * Issue #507 — perder a lease em QUALQUER ponto do turno reivindicado tem de
 * ENCERRÁ-LO, não devolvê-lo ao fluxo normal.
 *
 * Três barreiras, nos três pontos que a revisão do dono nomeou: o pending-gate
 * (achado 1), o grafo cognitivo pre-turn e o Decision Engine (achado 2).
 *
 * ─── O defeito (achado 1 da revisão do dono na PR #599) ─────────────────────
 *
 * A entrega anterior já abortava a chamada de LLM do classificador e já
 * auditava `cancelled` em `cognitive_module_log`. O que ela NÃO fazia era
 * mudar o DESFECHO: o gate convertia o cancelamento em
 * `{ kind: 'unresolved', reason: 'low_confidence' }`, e o comentário justificava
 * isso dizendo que "o guard do ReAct interrompe na hora".
 *
 * Não interrompe. O guard vive DENTRO de `runReActLoop`; entre
 * `checkPendingFirst` e ele há ~700 linhas de `src/agent/core.ts` que rodam
 * primeiro:
 *
 *   - `captureInboundForOutreach` — MUTA estado de scheduling;
 *   - o grafo pre-turn — chama LLM e GRAVA `procedure_selector_decisions`,
 *     podendo iniciar/abortar `procedure_executions`;
 *   - o Decision Engine — chama LLM e pode BLOQUEAR o turno RESPONDENDO ao
 *     usuário.
 *
 * Ou seja: a perna que já perdeu a posse escrevia estado e podia falar com o
 * usuário. É a violação de fencing que a #504 (PR #567) existe para impedir.
 *
 * ─── Por que a prova aqui é COMPORTAMENTAL, e não de auditoria ──────────────
 *
 * O dono foi explícito: "provar ausência de qualquer mutação/resposta
 * posterior, não apenas aborto/auditoria da chamada". Uma asserção de que a row
 * do classificador diz `cancelled` passaria com o defeito INTEIRO no lugar —
 * ela mede a chamada, não o pipeline. Então este arquivo não olha a row do
 * gate: ele olha o que aconteceu DEPOIS do gate.
 *
 * ─── O que é real e o que é dublê ───────────────────────────────────────────
 *
 * REAL: `runAgentForMensagem` (o mesmo ponto de entrada que o worker da BullMQ
 * usa), todo o pipeline de `src/agent/core.ts`, o grafo cognitivo, o Decision
 * Engine, o Postgres, e a perda de posse pelo caminho de sempre — claim SQL →
 * `lease_expires_at` no passado → takeover por um SUCESSOR real → heartbeat do
 * dono descobre (`token_mismatch`) → `AbortSignal` do `TurnExecutionContext`.
 *
 * DUBLÊ: (a) `callLLM`, porque é chamada paga a provedor externo — e é também
 * o INSTRUMENTO, porque registra o `workload` de cada chamada, o que revela
 * quais reasoners do pipeline foram alcançados; (b) o classificador do gate,
 * injetado por `setClassifierForTesting` (o seam que a própria produção
 * oferece), que é o PONTO DE PAUSA determinístico onde a posse é tomada;
 * (c) `resolveChannel`, para o turno rodar sob um par tenant/agent PRÓPRIO —
 * o banco é compartilhado por dezenas de worktrees e semear um procedimento
 * atribuído a `primary` mudaria o comportamento das outras suítes.
 *
 * Nada de `beginTurnExecution`, `TurnLease`, `checkPendingFirst` ou dos guards
 * é mockado. Apagar o `if (gate.kind === 'cancelled')` de `src/agent/core.ts`
 * reprova a BARREIRA.
 *
 * ─── O CONTROLE ────────────────────────────────────────────────────────────
 *
 * "Nada aconteceu depois do gate" também passaria se o pipeline nunca chegasse
 * lá — mensagem não encontrada, tenant errado, gate desligado, procedimento não
 * semeado. O CONTROLE roda o MESMO caminho com a lease VIVA e EXIGE que cada
 * observável esteja PRESENTE. É ele que dá significado ao zero da barreira.
 *
 * Skipped sem TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type { LLMResponse } from '@/lib/llm/types.js';

// `config/env.ts` congela o env no import, então as flags têm de estar de pé
// ANTES de qualquer import — inclusive dos ESM içados. Mesmo motivo (e mesmo
// remédio) de `turn-claim-core-barrier-real-db.spec.ts`.
const envAnterior = vi.hoisted(() => {
  const prev = {
    FEATURE_TURN_STATE_MACHINE: process.env.FEATURE_TURN_STATE_MACHINE,
    FEATURE_TURN_CLAIM: process.env.FEATURE_TURN_CLAIM,
    FEATURE_PENDING_GATE: process.env.FEATURE_PENDING_GATE,
  };
  process.env.FEATURE_TURN_STATE_MACHINE = 'true';
  process.env.FEATURE_TURN_CLAIM = 'true';
  process.env.FEATURE_PENDING_GATE = 'true';
  return prev;
});

const T = 'll507pg-tenant';
const A = 'll507pg-agent';
/**
 * A pessoa desta suíte É o dono configurado (`OWNER_TELEFONE_WHATSAPP` em
 * `tests/setup.ts`). Não é detalhe: `src/agent/core.ts` só chama
 * `captureInboundForOutreach` quando `pessoasRepo.findByPhone(OWNER_...)`
 * ENCONTRA alguém — sem isso o primeiro observável pós-gate nunca acenderia
 * nem no CONTROLE, e o zero da barreira não significaria nada. A busca é
 * escopada por tenant (ALS), então o número não colide com outras worktrees.
 */
const OWNER_PHONE = '+5511111111111';

vi.mock('@/lib/redis.js', () => ({
  redis: {},
  isRedisConnected: () => false,
  ensureRedisConnect: vi.fn(),
  isRedisOomError: () => false,
  recordRedisOomDegraded: () => {},
}));
vi.mock('@/gateway/queue.js', () => ({
  agentQueue: { add: vi.fn(), getJob: vi.fn() },
  startAgentWorker: vi.fn(),
  enqueueAgent: vi.fn(),
  shutdownQueue: vi.fn(),
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
// Roteamento não é o que esta suíte mede: o par tenant/agent é PRÓPRIO para
// não contaminar as outras worktrees que compartilham este Postgres.
vi.mock('@/gateway/channel-resolver.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveChannel: async () => ({ tenant_id: T, agent_id: A, channel_id: null }),
}));

/**
 * O INSTRUMENTO — e o único dublê de dependência paga.
 *
 * Registra o `workload` de cada chamada (é assim que o teste enxerga QUAIS
 * reasoners do pipeline foram alcançados), o `signal` recebido (é assim que se
 * mede a PROPAGAÇÃO — `undefined` denuncia um call site sem sinal) e quais
 * chamadas de fato PARARAM ao serem abortadas.
 *
 * `before` é o gancho que escolhe o instante da perda de posse: ele roda ANTES
 * da resposta, dentro da chamada, com o listener de abort já armado. É o
 * comportamento COOPERATIVO do gateway real (`src/lib/llm/gateway.ts`), que
 * cancela provider, retry e backoff.
 */
const llm = vi.hoisted(() => ({
  workloads: [] as string[],
  signals: [] as Array<AbortSignal | undefined>,
  abortadas: [] as string[],
  before: async (_workload: string): Promise<void> => {},
}));
vi.mock('@/lib/claude.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/claude.js')>();
  return {
    ...actual,
    callLLM: async (params: {
      workload?: string;
      signal?: AbortSignal;
    }): Promise<LLMResponse> => {
      const workload = params.workload ?? 'sem_workload';
      llm.workloads.push(workload);
      llm.signals.push(params.signal);
      const signal = params.signal;
      const resposta = (): LLMResponse => ({
        // Alto o bastante para o `procedure-selector` decidir `start`, e texto
        // livre o bastante para o reasoner encerrar o laço numa resposta.
        content: '{"matches": true, "confidence": 0.95, "reason": "ok"}',
        tool_uses: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'dublê',
      });
      return new Promise<LLMResponse>((resolve, reject) => {
        const onAbort = (): void => {
          llm.abortadas.push(workload);
          const e = new Error('llm_call_aborted');
          e.name = 'AbortError';
          reject(e);
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        void llm.before(workload).then(() => {
          if (signal?.aborted) return;
          signal?.removeEventListener('abort', onAbort);
          resolve(resposta());
        }, reject);
      });
    },
  };
});

/**
 * Espião de CHAMADA sobre o módulo REAL de scheduling. Ele conta e delega —
 * não substitui comportamento. É o observável do primeiro limite pós-gate:
 * `captureInboundForOutreach` MUTA estado de scheduling.
 */
const outreach = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/scheduling/disambiguation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/scheduling/disambiguation.js')>();
  return {
    ...actual,
    captureInboundForOutreach: async (
      ...args: Parameters<typeof actual.captureInboundForOutreach>
    ) => {
      outreach.calls += 1;
      return actual.captureInboundForOutreach(...args);
    },
  };
});

/**
 * Os PONTOS DE PAUSA da rodada 2 da revisão do dono — o mesmo padrão do achado
 * do Decision Engine ("guard, await, consumo sem guard depois"), nos dois
 * outros limites onde ele existia:
 *
 *  - `pessoasRepo.findByPhone` roda ENTRE `assertTurnOwnership('scheduling_inbound_hook')`
 *    e `captureInboundForOutreach`, que MUTA estado de scheduling;
 *  - `procedureSelectorDecisionsRepo.record` roda ENTRE
 *    `assertTurnOwnership('preturn_graph')` e `procedureEngine.startExecution`,
 *    que CRIA uma `procedure_executions`.
 *
 * Ambos DELEGAM ao repositório real e só então chamam o gancho: a operação
 * observada acontece de verdade, e a perda de posse cai exatamente na janela.
 * O gancho é de UM DISPARO — `procedure-selector` também chama `findById`, e
 * `captureInboundForOutreach` também busca pessoas.
 */
const repoHooks = vi.hoisted(() => ({
  aposFindByPhone: null as null | (() => Promise<void>),
  aposSelectorRecord: null as null | (() => Promise<void>),
}));
vi.mock('@/db/repositories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/repositories.js')>();
  const umDisparo = async (k: 'aposFindByPhone' | 'aposSelectorRecord'): Promise<void> => {
    const gancho = repoHooks[k];
    if (!gancho) return;
    repoHooks[k] = null;
    await gancho();
  };
  return {
    ...actual,
    pessoasRepo: {
      ...actual.pessoasRepo,
      findByPhone: async (...args: Parameters<typeof actual.pessoasRepo.findByPhone>) => {
        const r = await actual.pessoasRepo.findByPhone(...args);
        await umDisparo('aposFindByPhone');
        return r;
      },
    },
    procedureSelectorDecisionsRepo: {
      ...actual.procedureSelectorDecisionsRepo,
      record: async (
        ...args: Parameters<typeof actual.procedureSelectorDecisionsRepo.record>
      ) => {
        const r = await actual.procedureSelectorDecisionsRepo.record(...args);
        await umDisparo('aposSelectorRecord');
        return r;
      },
    },
  };
});

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

/** Curto o bastante para o heartbeat descobrir o takeover dentro do teste. */
const HEARTBEAT_MS = 400;
/**
 * TTL longo pelo mesmo motivo de `turn-lease-lost-reasoner-real-db.spec.ts`: a
 * BARREIRA não perde a posse por expiração natural (o helper força o vencimento
 * por SQL e um SUCESSOR reivindica), então um TTL curto só criaria um cronômetro
 * competindo com o corpo do teste e faria o CONTROLE flocar sob contenção.
 */
const TTL_MS = 30_000;

let pool: pg.Pool;
let pessoa_id: string;
let definition_id: string;
const createdMensagens: string[] = [];
const createdConversas: string[] = [];

const inT = <R>(fn: () => Promise<R>): Promise<R> =>
  runWithTenantContext({ tenant_id: T, agent_id: A }, fn);

/**
 * Uma conversa NOVA por caso. O índice
 * `uniq_pending_questions_active_per_conversa` só admite UMA pendência aberta
 * por conversa, e o desfecho `unresolved` do gate deixa a pendência aberta —
 * reaproveitar a conversa faria o segundo caso morrer na semeadura.
 */
async function mkConversa(): Promise<string> {
  const c = await pool.query<{ id: string }>(
    `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, escopo_entidades)
     VALUES ($1,$2,$3,'{}') RETURNING id`,
    [T, A, pessoa_id],
  );
  const id = c.rows[0]!.id;
  createdConversas.push(id);
  return id;
}

async function mkInbound(conversa_id: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1,$2,$3,$4,'in','texto','sim', jsonb_build_object('telefone', $5::text), NULL)`,
    [id, T, A, conversa_id, OWNER_PHONE],
  );
  createdMensagens.push(id);
  return id;
}

/** Uma pendência ABERTA para o gate ter o que classificar. */
async function mkPendingQuestion(conversa_id: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO pending_questions
       (tenant_id, agent_id, conversa_id, pessoa_id, tipo, pergunta, opcoes_validas, acao_proposta, expira_em, status)
     VALUES ($1,$2,$3,$4,'confirmacao','Confirma?',
             '[{"key":"sim","label":"Sim"},{"key":"nao","label":"Não"}]'::jsonb,
             '{"tool":"noop","args":{}}'::jsonb, now() + interval '1 hour', 'aberta')
     RETURNING id`,
    [T, A, conversa_id, pessoa_id],
  );
  return r.rows[0]!.id;
}

async function turnIdFor(mensagem_id: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM agent_turns WHERE representative_message_id = $1`,
    [mensagem_id],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`nenhum agent_turns para a mensagem ${mensagem_id}`);
  return id;
}

/**
 * `state_version` de `agent_turns` LOGO DEPOIS do takeover — a marca d'água que
 * torna "o perdedor não gravou nada" uma afirmação verificável e não uma
 * suposição. Toda escrita de estado do turno incrementa a versão, então
 * comparar o valor final com este é a forma mais forte (e a mais barata) de
 * dizer que a última gravação da linha foi a do SUCESSOR.
 */
let versaoAposTakeover: number | null = null;

/**
 * A PERDA DE POSSE, pelo mecanismo REAL: a lease vence por SQL, um sucessor
 * reivindica de verdade (`tryClaimTurn`), o heartbeat do dono descobre o
 * `token_mismatch` e aborta o `AbortSignal` da tentativa. Nada é sinalizado à
 * mão — o teste apenas ESPERA o sinal do contexto ambiente virar `aborted`.
 */
async function loseOwnershipForReal(turn_id: string): Promise<void> {
  const { agentTurnsRepo } = await import('@/db/repositories.js');
  const { getTurnExecutionContext } = await import('@/runtime/turns/execution-context.js');
  await pool.query(
    `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [turn_id],
  );
  const successor = await inT(() =>
    agentTurnsRepo.tryClaimTurn({
      turn_id,
      worker_id: `sucessor-${randomUUID().slice(0, 8)}`,
      lease_ms: 60_000,
    }),
  );
  expect(successor.ok, 'o sucessor deveria assumir a lease vencida').toBe(true);
  // Estreitamento para o TS — e a captura da marca d'água do takeover.
  if (!successor.ok) throw new Error('o sucessor não assumiu a lease vencida');
  versaoAposTakeover = successor.claim.state_version;
  const deadline = Date.now() + 10_000;
  while (!getTurnExecutionContext()?.signal.aborted && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(
    getTurnExecutionContext()?.signal.aborted,
    'o heartbeat real deveria ter detectado a perda e abortado o sinal da tentativa',
  ).toBe(true);
}

// ── Os OBSERVÁVEIS pós-gate ────────────────────────────────────────────────

/**
 * Rows do `procedure-selector` — o grafo pre-turn chamou LLM e foi auditado.
 *
 * Filtrado por INSTANTE e não por `turno_id`: `selectProcedure`
 * (`src/cognition/procedure-selector.ts`) chama `runCognitiveModule` sem
 * `turno_id`/`conversa_id`, então essas colunas ficam nulas nestas rows. O par
 * tenant/agent é exclusivo desta suíte, e `desde` isola o caso.
 */
async function selectorLogRows(desde: Date): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM cognitive_module_log
      WHERE tenant_id=$1 AND agent_id=$2 AND module_name LIKE 'procedure-selector.%'
        AND started_at >= $3`,
    [T, A, desde],
  );
  return r.rows[0]!.n;
}

/** A GRAVAÇÃO pós-grafo: a decisão do selector virou estado. */
async function selectorDecisionRows(turno_id: string): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM procedure_selector_decisions WHERE turno_id = $1`,
    [turno_id],
  );
  return r.rows[0]!.n;
}

/** Execuções de procedimento nascidas neste turno. */
async function execucoesDaConversa(conversa_id: string): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM procedure_executions WHERE conversa_id = $1`,
    [conversa_id],
  );
  return r.rows[0]!.n;
}

/** Qualquer RESPOSTA ao usuário nesta conversa. */
async function outboundRows(conversa_id: string): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM mensagens WHERE conversa_id = $1 AND direcao = 'out'`,
    [conversa_id],
  );
  return r.rows[0]!.n;
}

/**
 * QUAL limite recusou o efeito — o discriminador entre "o turno parou" e "o
 * turno parou NO LUGAR CERTO".
 *
 * Sem isto o teste seria cego a qual guard agiu: o pipeline tem vários em
 * sequência, e neutralizar o primeiro só faz o segundo pegar — a suíte
 * continuaria verde com o defeito no lugar. `reportBlockedEffect`
 * (`src/runtime/turns/execution-context.ts`) publica `boundary` como label
 * desta série, que é exatamente o nome do ponto que recusou.
 */
async function boundariesBloqueados(): Promise<string[]> {
  const metrics = await import('@/lib/metrics.js');
  const exposicao = await metrics.renderPrometheus();
  return exposicao
    .split('\n')
    .filter((l) => l.startsWith('maia_turn_effect_blocked_total'))
    .map((l) => /boundary="([^"]+)"/.exec(l)?.[1] ?? '?')
    .sort();
}

/**
 * O DESFECHO DO TURNO na fonte de verdade — `agent_turns` —, com a ligação
 * `agent_turn_inputs` e a projeção legada que hoje DERIVA dela.
 *
 * Por que não basta olhar `mensagens.processada_em`: com
 * `FEATURE_TURN_STATE_AUTHORITATIVE` ligada (default desde a #504), a projeção
 * legada deixou de ser um efeito INDEPENDENTE do fim do pipeline e passou a ser
 * consequência do ESTADO — `runTransition` (`src/db/repositories/turn-repos.ts`)
 * só carimba `processada_em` em transição TERMINAL, na mesma transação do CAS e
 * restrita às mensagens ligadas por `agent_turn_inputs`; fora disso
 * `src/agent/core.ts` registra `agent.legacy_projection_skipped_non_terminal`.
 * Um turno que termina `retryable` — o caso deste harness — corretamente NÃO
 * carimba, porque carimbar é justamente o que matava o retry (achado P1).
 *
 * Então o sinal equivalente, e mais forte, é este: QUEM escreveu o desfecho da
 * tentativa, QUAL desfecho, se a posse foi devolvida e se a mensagem está
 * ligada ao turno. `state_version` fecha a prova — nenhuma gravação de estado
 * passa por ela sem incrementá-la.
 */
type DesfechoDoTurno = {
  status: string;
  outcome: string | null;
  last_error_code: string | null;
  posse_liberada: boolean;
  ligada_por_inputs: boolean;
  projecao_legada: unknown;
  state_version: number;
};

async function desfechoDoTurno(mensagem_id: string): Promise<DesfechoDoTurno> {
  const r = await pool.query<DesfechoDoTurno>(
    `SELECT t.status,
            t.outcome,
            t.last_error_code,
            (t.claim_token IS NULL) AS posse_liberada,
            t.state_version::int   AS state_version,
            EXISTS (SELECT 1 FROM agent_turn_inputs i
                     WHERE i.turn_id = t.id AND i.mensagem_id = m.id) AS ligada_por_inputs,
            m.processada_em AS projecao_legada
       FROM mensagens m
       JOIN agent_turns t ON t.representative_message_id = m.id
      WHERE m.id = $1`,
    [mensagem_id],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`nenhum agent_turns para a mensagem ${mensagem_id}`);
  return { ...row, projecao_legada: row.projecao_legada ?? null };
}

/**
 * O desfecho que um turno PERDIDO tem de exibir: a última gravação da linha é a
 * do SUCESSOR (`claimed`, versão a do takeover, lease dele) e o perdedor não
 * escreveu NADA — nem outcome, nem erro, nem a projeção legada.
 */
function desfechoIntactoDoSucessor(): DesfechoDoTurno {
  if (versaoAposTakeover === null) {
    throw new Error('o takeover não aconteceu — a marca d\'água não foi capturada');
  }
  return {
    status: 'claimed',
    outcome: null,
    last_error_code: null,
    posse_liberada: false,
    ligada_por_inputs: true,
    projecao_legada: null,
    state_version: versaoAposTakeover,
  };
}

d('#507 — perda de lease no turno reivindicado encerra a tentativa ANTES do efeito', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query(
      `INSERT INTO tenants(id, nome) VALUES ($1,'ll507 pending gate') ON CONFLICT DO NOTHING`,
      [T],
    );
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,'ll507 pending gate agent')
       ON CONFLICT DO NOTHING`,
      [A, T],
    );

    const p = await pool.query<{ id: string }>(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1,$2,'ll507-pending-gate',$3,'dono','ativa') RETURNING id`,
      [T, A, OWNER_PHONE],
    );
    pessoa_id = p.rows[0]!.id;

    // Um procedimento ATIVO e ATRIBUÍDO ao agente: é ele que faz o grafo
    // pre-turn chamar LLM e gravar. Sem isto o `procedure-selector` retorna
    // antes de qualquer chamada e o CONTROLE não teria o que exigir.
    const def = await pool.query<{ id: string }>(
      `INSERT INTO procedure_definitions
         (tenant_id, agent_id, scope, nome, version_number, status, intencao, source)
       VALUES ($1,$2,'agent','ll507-proc',1,'active','confirmar algo','ensino')
       RETURNING id`,
      [T, A],
    );
    definition_id = def.rows[0]!.id;
    await pool.query(
      `INSERT INTO procedure_assignments
         (tenant_id, definition_id, definition_version, target_type, target_id, enabled)
       VALUES ($1,$2,1,'agent',$3,true)`,
      [T, definition_id, A],
    );
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    const { setClassifierForTesting } = await import('@/agent/pending-gate.js');
    setClassifierForTesting(null);

    // Limpeza GENÉRICA por tenant: o banco é compartilhado por dezenas de
    // worktrees, e enumerar tabelas à mão envelhece mal (cada migration nova
    // pode acrescentar uma). Varre toda tabela com coluna `tenant_id` e repete
    // até as dependências caírem em ordem — a última passada apaga agente e
    // tenant.
    const tabelas = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'`,
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

    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await pool.end();
  }, 60_000);

  /**
   * Roda um turno completo pelo ponto de entrada de produção.
   *
   * `perderEm` escolhe o BOUNDARY em que a posse cai:
   *   - `'pending_gate'` — dentro do classificador do gate (achado 1);
   *   - um `workload` de LLM (`'procedure_selector'`, `'risk_classifier'`) —
   *     dentro daquela chamada em voo (achado 2);
   *   - `null` — não perde (CONTROLE).
   */
  async function rodarTurno(opts: { perderEm: string | null }): Promise<{
    mensagem_id: string;
    turno_id: string;
    conversa_id: string;
    desde: Date;
  }> {
    const { config } = await import('@/config/env.js');
    vi.spyOn(config, 'TURN_LEASE_TTL_MS', 'get').mockReturnValue(TTL_MS);
    vi.spyOn(config, 'TURN_LEASE_HEARTBEAT_MS', 'get').mockReturnValue(HEARTBEAT_MS);

    const { runAgentForMensagem } = await import('@/agent/core.js');
    const { setClassifierForTesting } = await import('@/agent/pending-gate.js');

    // Zerado a cada caso: `boundariesBloqueados()` lê contadores de processo.
    (await import('@/lib/metrics.js'))._resetForTests();
    llm.workloads = [];
    llm.signals = [];
    llm.abortadas = [];
    llm.before = async () => {};
    outreach.calls = 0;
    repoHooks.aposFindByPhone = null;
    repoHooks.aposSelectorRecord = null;
    versaoAposTakeover = null;

    const conversa_id = await mkConversa();
    await mkPendingQuestion(conversa_id);
    const mensagem_id = await mkInbound(conversa_id);

    const perder = async (): Promise<void> =>
      loseOwnershipForReal(await turnIdFor(mensagem_id));

    // Os dois pontos de pausa de repositório (rodada 2). Armados fora do
    // `llm.before` porque nenhum dos dois passa por chamada de LLM.
    if (opts.perderEm === 'procedure_start') {
      repoHooks.aposSelectorRecord = perder;
    }

    if (
      opts.perderEm !== null &&
      opts.perderEm !== 'pending_gate' &&
      opts.perderEm !== 'scheduling_hook' &&
      opts.perderEm !== 'procedure_start'
    ) {
      llm.before = async (workload: string) => {
        if (workload === opts.perderEm) await perder();
      };
    }

    setClassifierForTesting(async () => {
      if (opts.perderEm === 'pending_gate') {
        await perder();
      }
      // O gate é a última coisa antes do hook de scheduling: armar aqui garante
      // que o gancho de UM DISPARO caia no `findByPhone` DELE, e não numa busca
      // anterior do pipeline.
      if (opts.perderEm === 'scheduling_hook') {
        repoHooks.aposFindByPhone = perder;
      }
      // Resolução DELIBERADAMENTE fraca: sem o desfecho `cancelled`, o gate
      // devolve `unresolved/low_confidence` e o core segue para o pipeline
      // inteiro. É exatamente o caminho que o achado 1 descreve.
      return { resolves_pending: false, confidence: 0.1 };
    });
    // `started_at` de `cognitive_module_log` vem do relógio do NODE (o runner
    // insere `new Date(startTime)`), então esta marca é exata e não depende do
    // relógio do Postgres. Fica DEPOIS da semeadura para não capturar rows do
    // caso anterior — a suíte reusa o par tenant/agent.
    const desde = new Date();
    try {
      await runAgentForMensagem(mensagem_id);
    } finally {
      setClassifierForTesting(null);
    }
    // `turno_id` nas tabelas cognitivas É o id da mensagem representativa
    // (ver `PreturnContext.turno_id` em `src/agent/core.ts`).
    return { mensagem_id, turno_id: mensagem_id, conversa_id, desde };
  }

  it('CONTROLE: com a lease VIVA, o pipeline pós-gate roda e deixa rastro', async () => {
    const { mensagem_id, turno_id, conversa_id, desde } = await rodarTurno({
      perderEm: null,
    });

    expect(outreach.calls, 'o hook de scheduling tem de ter sido alcançado').toBeGreaterThan(0);
    expect(
      await selectorLogRows(desde),
      'o grafo pre-turn tem de ter chamado o procedure-selector',
    ).toBeGreaterThan(0);
    expect(
      await selectorDecisionRows(turno_id),
      'e a decisão do selector tem de ter virado estado',
    ).toBeGreaterThan(0);
    // Rodada 2 — sem esta linha o zero de `execucoesDaConversa` nas barreiras
    // não significaria nada: talvez o CONTROLE também nunca crie execução.
    expect(
      await execucoesDaConversa(conversa_id),
      'e o procedimento selecionado tem de ter iniciado uma execução',
    ).toBeGreaterThan(0);
    // A SEQUÊNCIA COMPLETA do que roda depois do gate, na ordem do pipeline:
    // o reasoner do grafo pre-turn, o classificador de risco do Decision Engine
    // e o reasoner do ReAct. São os três pontos do achado 2 do dono.
    expect(
      llm.workloads,
      'o pipeline pós-gate inteiro tem de ter sido alcançado',
    ).toEqual(['procedure_selector', 'risk_classifier', 'reasoner']);
    // O DESFECHO, escrito pelo DONO na fonte de verdade.
    //
    // Aqui o ReAct produz resposta e o ENVIO falha — o Baileys é dublê e o par
    // tenant/agent desta suíte não tem canal ativo (`line_output.sole_channel_
    // unresolvable`). `decideTurnAction` (`src/agent/turn-outcome.ts`) classifica
    // isso como `outbound_failure` RETRYABLE, e o dono fecha a tentativa em
    // `retryable`, devolvendo a lease. É o fim de pipeline mais PROFUNDO que
    // este harness alcança: só se chega a `outbound_failure` depois de o
    // reasoner ter rodado e produzido.
    //
    // A projeção legada nula NÃO é ausência de rastro: é a regra do regime
    // autoritativo (`agent.legacy_projection_skipped_non_terminal`) — estado
    // não-terminal não carimba `processada_em`, e é isso que mantém o turno
    // visível para o recovery. Ela entra na igualdade para continuar coberta.
    expect(
      await desfechoDoTurno(mensagem_id),
      'o dono tem de ter fechado a tentativa no estado do turno',
    ).toEqual({
      status: 'retryable',
      outcome: null,
      last_error_code: 'outbound_failure',
      posse_liberada: true,
      ligada_por_inputs: true,
      projecao_legada: null,
      state_version: 3, // created -> claimed (dono) -> retryable
    });
    expect(
      await boundariesBloqueados(),
      'com a posse intacta nenhum limite de efeito pode ter recusado nada',
    ).toEqual([]);
  }, 60_000);

  it('BARREIRA: posse perdida no classificador — NENHUM efeito posterior', async () => {
    const { mensagem_id, turno_id, conversa_id, desde } = await rodarTurno({
      perderEm: 'pending_gate',
    });

    // 1. O hook de scheduling NÃO rodou. Ele é o PRIMEIRO limite depois do
    //    gate e o primeiro que mutava estado.
    expect(
      outreach.calls,
      'captureInboundForOutreach rodou depois de a posse acabar',
    ).toBe(0);

    // 2. O grafo pre-turn NÃO rodou: nem a chamada de LLM, nem a gravação da
    //    decisão, nem a execução de procedimento.
    expect(await selectorLogRows(desde), 'o grafo pre-turn rodou sem posse').toBe(0);
    expect(
      await selectorDecisionRows(turno_id),
      'procedure_selector_decisions foi gravado sem posse',
    ).toBe(0);
    expect(await execucoesDaConversa(conversa_id), 'uma execução de procedimento nasceu sem posse').toBe(0);

    // 3. NENHUM reasoner foi alcançado — Decision Engine e ReAct incluídos. O
    //    classificador do gate é dublê e não passa por `callLLM`, então
    //    qualquer workload aqui veio do pipeline DEPOIS do gate.
    expect(
      llm.workloads,
      'algum reasoner posterior ao gate foi chamado sem posse',
    ).toEqual([]);

    // 4. NADA foi dito ao usuário. É REDE, não discriminador, e a diferença
    //    importa: neste harness o Baileys é dublê e o CONTROLE também não
    //    consegue entregar (`agent has no active channel`), então um zero aqui
    //    sozinho não provaria nada. Quem discrimina a resposta é o item 3 — o
    //    Decision Engine (que responde ao bloquear) e o ReAct (que responde ao
    //    concluir) sequer foram alcançados.
    expect(await outboundRows(conversa_id), 'o turno perdido respondeu ao usuário').toBe(0);

    // 5. E o DESFECHO do turno é o do SUCESSOR, intacto: quem perdeu a posse
    //    não gravou estado nem projeção. `state_version` é o discriminador —
    //    ela ainda é a do takeover, então a ÚLTIMA gravação da linha foi a do
    //    sucessor. `projecao_legada` (o antigo `processada_em`) entra aqui como
    //    parte do mesmo desfecho: era assim que um zumbi fazia o turno do dono
    //    legítimo parecer processado por fora.
    expect(
      await desfechoDoTurno(mensagem_id),
      'quem já não tinha a posse gravou desfecho no turno',
    ).toEqual(desfechoIntactoDoSucessor());

    // A REDE, e o que prova que o core REALMENTE entrou (sem ela o teste
    // passaria por não ter rodado): a posse na linha é a do SUCESSOR.
    const t = await pool.query<{ claimed_by: string }>(
      `SELECT claimed_by FROM agent_turns WHERE id = $1`,
      [await turnIdFor(mensagem_id)],
    );
    expect(t.rows[0]!.claimed_by).toMatch(/^sucessor-/);

    // 6. E parou NO GATE. Esta é a asserção que torna o caso discriminante:
    //    sem o desfecho `cancelled`, o turno seguia e era o guard SEGUINTE
    //    (`scheduling_inbound_hook`) que o barrava — os itens 1..5 continuariam
    //    verdes e o achado 1 passaria despercebido.
    expect(
      await boundariesBloqueados(),
      'a recusa tem de vir do pending-gate, não de um guard mais adiante',
    ).toEqual(['pending_gate']);
  }, 60_000);

  /**
   * Achado 2 da revisão do dono, primeira metade: o GRAFO COGNITIVO.
   *
   * O tipo `NodeRunResult` registrava, por escrito, que `cancelled` era
   * INALCANÇÁVEL no grafo porque `runOne` não passava sinal. Consequência: com
   * a lease caindo durante o `procedure-selector`, a chamada seguia paga até o
   * timeout do node e o resultado ainda podia virar
   * `procedure_selector_decisions` + `procedure_executions`.
   */
  it('BARREIRA (grafo pre-turn): a chamada aborta e NADA do pós-grafo é gravado', async () => {
    const { mensagem_id, turno_id, conversa_id, desde } = await rodarTurno({
      perderEm: 'procedure_selector',
    });

    // 1. A PROPAGAÇÃO, medida na entrada. `undefined` aqui é o denunciador
    //    exato de um `runOne` que voltou a chamar `n.run(ctx)` sem sinal.
    expect(
      llm.signals[0],
      'o node do grafo tem de receber o AbortSignal da tentativa',
    ).toBeInstanceOf(AbortSignal);

    // 2. A CHAMADA EM VOO PAROU — não apenas perdeu o `Promise.race`.
    expect(llm.abortadas, 'a chamada do procedure-selector tem de abortar').toEqual([
      'procedure_selector',
    ]);

    // 3. E NADA depois dela: nem outro reasoner, nem as gravações pós-grafo.
    expect(llm.workloads, 'o pipeline não pode continuar sem posse').toEqual([
      'procedure_selector',
    ]);
    expect(await selectorLogRows(desde), 'uma row por chamada — só a cancelada').toBe(1);
    expect(
      await selectorDecisionRows(turno_id),
      'procedure_selector_decisions foi gravado sem posse',
    ).toBe(0);
    expect(await execucoesDaConversa(conversa_id), 'uma execução nasceu sem posse').toBe(0);
    expect(await outboundRows(conversa_id), 'o turno perdido respondeu ao usuário').toBe(0);
    expect(
      await desfechoDoTurno(mensagem_id),
      'quem já não tinha a posse gravou desfecho no turno',
    ).toEqual(desfechoIntactoDoSucessor());

    // 4. E parou NO GRAFO — não num guard mais adiante.
    expect(
      await boundariesBloqueados(),
      'a recusa tem de vir do grafo pre-turn',
    ).toEqual(['preturn_graph']);
  }, 60_000);

  /**
   * ─── Rodada 2 da revisão do dono, MESMO PADRÃO em outro limite ────────────
   *
   * O achado da rodada 2 é sobre o Decision Engine: "guard antes, await,
   * consumo com efeito depois — sem novo guard". O hook de scheduling tinha a
   * mesma forma: `assertTurnOwnership('scheduling_inbound_hook')` roda ANTES de
   * dois `import()` dinâmicos e de `pessoasRepo.findByPhone`, e só DEPOIS disso
   * vem `captureInboundForOutreach`, que MUTA estado de scheduling (anexa a
   * resposta à occurrence, avança a máquina, pode notificar o dono).
   *
   * A pausa é no `findByPhone` do próprio hook: a busca acontece de verdade, a
   * lease é tomada de verdade, e o que se mede é se a MUTAÇÃO seguinte
   * aconteceu.
   */
  it('BARREIRA (hook de scheduling): a lease cai entre a busca e a mutação', async () => {
    const { mensagem_id, turno_id, conversa_id, desde } = await rodarTurno({
      perderEm: 'scheduling_hook',
    });

    // 1. A MUTAÇÃO não aconteceu. É o observável do achado, e é o que separa
    //    este caso do guard de fora (que já havia rodado, com posse, e deixado
    //    passar).
    expect(
      outreach.calls,
      'captureInboundForOutreach mutou scheduling depois de a posse acabar',
    ).toBe(0);

    // 2. E nada depois dele: o pipeline inteiro parou aqui.
    expect(llm.workloads, 'nenhum reasoner pode rodar depois da perda').toEqual([]);
    expect(await selectorLogRows(desde), 'o grafo pre-turn rodou sem posse').toBe(0);
    expect(
      await selectorDecisionRows(turno_id),
      'procedure_selector_decisions foi gravado sem posse',
    ).toBe(0);
    expect(await execucoesDaConversa(conversa_id), 'uma execução nasceu sem posse').toBe(0);
    expect(await outboundRows(conversa_id), 'o turno perdido respondeu ao usuário').toBe(0);
    expect(
      await desfechoDoTurno(mensagem_id),
      'quem já não tinha a posse gravou desfecho no turno',
    ).toEqual(desfechoIntactoDoSucessor());

    // 3. E o limite que recusou é o hook — não um guard mais adiante. Sem o
    //    guard NOVO (o de dentro do `if (owner)`), a mutação rodaria e quem
    //    recusaria seria `preturn_graph`: é esta linha que discrimina.
    expect(
      await boundariesBloqueados(),
      'a recusa tem de vir do hook de scheduling',
    ).toEqual(['scheduling_inbound_hook']);
  }, 60_000);

  /**
   * Mesmo padrão, terceiro limite: o INÍCIO DE PROCEDIMENTO pós-grafo.
   *
   * `assertTurnOwnership('preturn_graph')` roda antes de
   * `procedureSelectorDecisionsRepo.record`; entre ele e
   * `procedureEngine.startExecution` ainda há esse INSERT e um
   * `procedureDefinitionsRepo.findById`. `procedure_executions` é estado do
   * turno — nascer de uma tentativa sem posse é a gravação que a #504 fecha.
   *
   * O CONTRASTE aqui é interno ao próprio caso: a row de
   * `procedure_selector_decisions` EXISTE (foi escrita com a posse intacta) e a
   * execução NÃO. É o que prova que a barreira é esta, e não uma anterior.
   */
  it('BARREIRA (início de procedimento): a decisão fica, a execução não nasce', async () => {
    const { mensagem_id, turno_id, conversa_id } = await rodarTurno({
      perderEm: 'procedure_start',
    });

    expect(
      await selectorDecisionRows(turno_id),
      'a decisão foi gravada COM posse — sem ela o caso não chegou onde devia',
    ).toBeGreaterThan(0);
    expect(
      await execucoesDaConversa(conversa_id),
      'procedure_executions nasceu de uma tentativa sem posse',
    ).toBe(0);

    // O turno parou aqui: o Decision Engine e o ReAct nunca foram alcançados.
    expect(llm.workloads, 'nenhum reasoner posterior ao grafo pode rodar').toEqual([
      'procedure_selector',
    ]);
    expect(await outboundRows(conversa_id), 'o turno perdido respondeu ao usuário').toBe(0);
    expect(
      await desfechoDoTurno(mensagem_id),
      'quem já não tinha a posse gravou desfecho no turno',
    ).toEqual(desfechoIntactoDoSucessor());
    expect(
      await boundariesBloqueados(),
      'a recusa tem de vir do grafo pre-turn',
    ).toEqual(['preturn_graph']);
  }, 60_000);

  /**
   * Achado 2, segunda metade: o DECISION ENGINE.
   *
   * `runDecisionEngineForTurn(baseCtx)` chamava `engine.run({ base })` sem
   * sinal, embora todo o motor já aceite `options.signal`. Perdida a lease
   * durante a avaliação, o motor ia até o próprio budget e o pacote resultante
   * ainda podia BLOQUEAR o turno — o que em `src/agent/core.ts` significa
   * RESPONDER ao usuário e concluir o turno.
   *
   * Aqui a barreira é NECESSARIAMENTE mais tardia que a anterior: o grafo
   * pre-turn rodou com a posse INTACTA, e por isso suas gravações EXISTEM. É o
   * que separa "parou no lugar certo" de "nunca chegou lá".
   */
  it('BARREIRA (Decision Engine): a chamada aborta e o ReAct nunca começa', async () => {
    const { mensagem_id, turno_id, conversa_id } = await rodarTurno({
      perderEm: 'risk_classifier',
    });

    // 1. PROPAGAÇÃO até o gate de risco — a última chamada de LLM do Decision
    //    Engine que ainda não recebia sinal antes desta rodada.
    const iRisco = llm.workloads.indexOf('risk_classifier');
    expect(iRisco, 'o Decision Engine tem de ter sido alcançado').toBeGreaterThanOrEqual(0);
    expect(llm.signals[iRisco], 'o gate de risco tem de receber o sinal').toBeInstanceOf(
      AbortSignal,
    );
    expect(llm.abortadas, 'e a chamada em voo tem de parar').toEqual(['risk_classifier']);

    // 2. O TURNO PAROU AQUI: o ReAct — que é quem responde — nunca começou.
    expect(llm.workloads, 'nenhum reasoner pode rodar depois da perda').not.toContain('reasoner');
    expect(await outboundRows(conversa_id), 'o turno perdido respondeu ao usuário').toBe(0);
    expect(
      await desfechoDoTurno(mensagem_id),
      'quem já não tinha a posse gravou desfecho no turno',
    ).toEqual(desfechoIntactoDoSucessor());

    // 3. O CONTRASTE que prova que a barreira é a do Decision Engine e não uma
    //    anterior: o grafo pre-turn rodou COM posse e deixou o rastro dele.
    expect(
      await selectorDecisionRows(turno_id),
      'o grafo pre-turn rodou com a posse intacta e tem de ter gravado',
    ).toBeGreaterThan(0);

    // 4. E o limite que recusou é o do Decision Engine — nem antes, nem depois.
    expect(
      await boundariesBloqueados(),
      'a recusa tem de vir do Decision Engine',
    ).toEqual(['decision_engine']);
  }, 60_000);
});
