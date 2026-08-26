/**
 * Issue #626 (fatia C da #505) — HEAD-OF-LINE como condição do claim, contra
 * PostgreSQL REAL (migrations 120 + 122 + 124 + 126).
 *
 * ─── Por que nada aqui pode ser dublê ─────────────────────────────────────
 *
 * O objeto sob teste é um PREDICADO SQL avaliado dentro da mesma declaração
 * atômica que reivindica o turno. Um harness que reconstruísse o claim com SQL
 * próprio passaria feliz com a condição REMOVIDA do código de produção — ele
 * estaria provando o harness. Por isso toda entrada aqui é pela porta real:
 * `agentTurnsRepo.claimNextEligibleTurn`, `agentTurnsRepo.findRecoverableTurns`
 * e `beginTurnExecution`, carregados por `moduloDeProducao`.
 *
 * O que se prova:
 *   1. só o menor `first_ingress_seq` da stream avança — M1, M2, M3;
 *   2. o turno posterior é recusado como `not_head`, com o bloqueador
 *      identificado, e o `stream_busy` da fatia B NÃO é o motivo;
 *   3. a fila anda: concluído o head, o sucessor passa a ser reivindicável;
 *   4. `retryable` (backoff em aberto) continua ocupando a posição — um turno
 *      novo não ultrapassa por baixo;
 *   5. `outbound_pending` ANTERIOR devolve `stream_blocked`, não `not_head`;
 *   6. conversas DISTINTAS seguem em paralelo — sem lock global;
 *   7. a MESMA `stream_key` em tenants diferentes não se bloqueia;
 *   8. turno anterior ao protocolo (`stream_key` NULL) segue claimável;
 *   9. o RECOVERY usa a MESMA regra: `findRecoverableTurns` só devolve heads;
 *  10. `maia_stream_fifo_violation_total` existe, está em ZERO e continua zero
 *      depois de uma rajada legítima;
 *  11. a interação com a fatia B: recuperar o claim expirado do head NÃO libera
 *      o sucessor;
 *  12. `beginTurnExecution` (o call site REAL) devolve `not_head`, e a
 *      `audit_log` `turn_stream_blocked` é escrita.
 *
 * Skipped sem TEST_DB_URL, como as demais suítes de DB real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// Ids NAMESPACED — `agents.id` é PK global e outras suítes semeiam a mesma base.
const T_A = 'hol626-tenant-a';
const A_A = 'hol626-agent-a';
const T_B = 'hol626-tenant-b';
const A_B = 'hol626-agent-b';

const LEASE_MS = 60_000;

let pool: pg.Pool;

const inA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A }, fn);
const inB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_B, agent_id: A_B }, fn);

async function ensureTenantAgent(tenant: string, agent: string): Promise<void> {
  await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
    tenant,
  ]);
  await pool.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [agent, tenant],
  );
}

async function mkInbound(tenant: string, agent: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, NULL)`,
    [id, tenant, agent],
  );
  return id;
}

/**
 * Turno `received` numa stream NOMEADA, com a fronteira de sequência carimbada.
 *
 * A `stream_key` é passada de fora — e não derivada — pela mesma razão da suíte
 * da fatia B: o caso de isolamento precisa de duas tenants carregando a MESMA
 * chave literal, e a derivação canônica (que embute tenant e agent no material)
 * nunca produziria isso.
 *
 * A CRIAÇÃO continua sendo a de produção (`ensureTurnForMessage`); só as
 * colunas de shadow são carimbadas depois, como o ingresso da fatia A as
 * carimbaria. Nada aqui reescreve o claim.
 */
async function turnInStream(args: {
  tenant: string;
  agent: string;
  stream_key: string | null;
  seq: number | null;
  repos: typeof import('../../src/db/repositories.js');
}): Promise<string> {
  const mensagem_id = await mkInbound(args.tenant, args.agent);
  const run = args.tenant === T_A ? inA : inB;
  const turn = await run(() =>
    args.repos.agentTurnsRepo.ensureTurnForMessage({
      id: mensagem_id,
      tenant_id: args.tenant,
      agent_id: args.agent,
      conversa_id: null,
      channel_id: null,
    }),
  );
  if (args.stream_key !== null) {
    await pool.query(
      `UPDATE agent_turns
          SET stream_key = $2, stream_key_version = 1,
              first_ingress_seq = $3, last_ingress_seq = $3
        WHERE id = $1`,
      [turn.id, args.stream_key, args.seq],
    );
  }
  return turn.id;
}

async function readTurn(turn_id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT * FROM agent_turns WHERE id = $1`, [turn_id]);
  return r.rows[0] as Record<string, unknown>;
}

async function setStatus(turn_id: string, status: string): Promise<void> {
  await pool.query(`UPDATE agent_turns SET status = $2 WHERE id = $1`, [turn_id, status]);
}

/** Termina o turno pelo caminho mais curto que o CHECK de 097 aceita. */
async function concluir(turn_id: string): Promise<void> {
  await pool.query(
    `UPDATE agent_turns SET status = 'completed', outcome = 'reply_delivered', completed_at = now()
      WHERE id = $1`,
    [turn_id],
  );
}

/** Empurra a lease do turno para o PASSADO, simulando um dono morto. */
async function expireLease(turn_id: string): Promise<void> {
  await pool.query(
    `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [turn_id],
  );
}

const streamKey = (): string => `v1:${randomUUID().replace(/-/g, '').repeat(2)}`;

const handleFor = (turn_id: string) =>
  ({
    turn_id,
    status: 'received' as const,
    state_version: 0,
    attempt_count: 0,
    conversa_id: null,
    lease: null,
  }) as never;

d('#626 — head-of-line como condição do claim (DB real)', () => {
  const repos = moduloDeProducao(() => import('../../src/db/repositories.js'));
  const metricas = moduloDeProducao(() => import('../../src/lib/metrics.js'));
  // A semeadura das séries é do ponto de boot da observabilidade
  // (`registerRuntimeObservability`), não de um efeito de topo — ver o
  // cabeçalho de `src/runtime/turns/stream-metrics.ts`. Aqui ela é chamada à
  // mão porque esta suíte não sobe o servidor; QUE o boot a chame é afirmado em
  // `tests/unit/observability/stream-scheduling-metrics.spec.ts`.
  const streamMetrics = moduloDeProducao(() => import('@/runtime/turns/stream-metrics.js'));
  const turns = moduloDeProducao(() => import('@/runtime/turns/lifecycle.js'));

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await ensureTenantAgent(T_A, A_A);
    await ensureTenantAgent(T_B, A_B);
  }, 30_000);

  afterAll(async () => {
    await pool?.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM agent_turns WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM mensagens WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM audit_log WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [[A_A, A_B]]);
    await pool?.query(`DELETE FROM tenants WHERE id = ANY($1::text[])`, [[T_A, T_B]]);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool.query(`DELETE FROM agent_turns WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool.query(`DELETE FROM mensagens WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool.query(`DELETE FROM audit_log WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
  });

  // ─── 1. O critério de pronto literal da issue ──────────────────────────────

  it('somente o menor first_ingress_seq da stream avança (M1, M2, M3)', async () => {
    const key = streamKey();
    const m = [] as string[];
    for (const seq of [1, 2, 3]) {
      m.push(
        await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq, repos: repos() }),
      );
    }

    // A ORDEM DE TENTATIVA É INVERTIDA de propósito: M3 primeiro. Se a
    // elegibilidade fosse "qualquer turno da stream", M3 venceria — e é
    // exatamente esse o defeito que a fatia fecha. Um teste que tentasse M1
    // primeiro passaria mesmo com a regra removida.
    const r3 = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m[2]!,
        worker_id: 'w3',
        lease_ms: LEASE_MS,
      }),
    );
    const r2 = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m[1]!,
        worker_id: 'w2',
        lease_ms: LEASE_MS,
      }),
    );
    const r1 = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m[0]!,
        worker_id: 'w1',
        lease_ms: LEASE_MS,
      }),
    );

    expect(r3.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r1.ok).toBe(true);
    // E o motivo é da FILA, não da posse: `stream_busy` aqui significaria que
    // quem barrou foi o índice da fatia B (não havia nada ativo), e
    // `not_eligible` significaria que o próprio turno se recusou.
    expect(r3.ok === false && r3.reason).toBe('not_head');
    expect(r2.ok === false && r2.reason).toBe('not_head');
    // Os recusados não foram tocados: nem estado, nem tentativa.
    for (const perdedor of [m[1]!, m[2]!]) {
      const row = await readTurn(perdedor);
      expect(row['status']).toBe('received');
      expect(Number(row['attempt_count'])).toBe(0);
    }
  });

  it('a recusa identifica QUEM está na frente — e é sempre o mais antigo', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2, repos: repos() });
    const m3 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 3, repos: repos() });

    const r3 = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m3,
        worker_id: 'w3',
        lease_ms: LEASE_MS,
      }),
    );
    // Não basta dizer "há fila": o operador precisa saber ATRÁS DE QUEM. E o
    // apontado tem de ser o head (m1), não o do meio (m2) — apontar para o do
    // meio mandaria a remediação para o turno errado.
    expect(r3.ok === false && r3.head_block?.turn_id).toBe(m1);
    expect(r3.ok === false && r3.head_block?.status).toBe('received');
  });

  // ─── 2. A fila ANDA ────────────────────────────────────────────────────────

  it('concluído o head, o sucessor passa a ser reivindicável', async () => {
    // O contrário de "somente o head avança" não pode ser "a stream trava".
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2, repos: repos() });

    expect(
      (
        await inA(() =>
          repos().agentTurnsRepo.claimNextEligibleTurn({
            turn_id: m2,
            worker_id: 'w2',
            lease_ms: LEASE_MS,
          }),
        )
      ).ok,
    ).toBe(false);

    await concluir(m1);

    const depois = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m2,
        worker_id: 'w2',
        lease_ms: LEASE_MS,
      }),
    );
    expect(depois.ok).toBe(true);
  });

  it('turno em RETRYABLE continua ocupando a posição — o novo não ultrapassa', async () => {
    // Cláusula literal da issue-mãe: "Turno retryable continua ocupando a
    // posição e bloqueia sucessores até nova tentativa ou política de término"
    // e "Backoff não autoriza ultrapassagem silenciosa por mensagens
    // posteriores". Sem o head-of-line, um turno em backoff longo era
    // exatamente a janela pela qual a mensagem seguinte passava na frente.
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2, repos: repos() });
    await pool.query(
      `UPDATE agent_turns SET status = 'retryable', next_attempt_at = now() + interval '1 hour'
        WHERE id = $1`,
      [m1],
    );

    const r2 = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m2,
        worker_id: 'w2',
        lease_ms: LEASE_MS,
      }),
    );
    expect(r2.ok === false && r2.reason).toBe('not_head');
    expect(r2.ok === false && r2.head_block?.status).toBe('retryable');
  });

  it('um turno TERMINAL nunca é `not_head` — a fila DELE acabou', async () => {
    // Dizer "não é o head" de um turno concluído mandaria o operador procurar
    // o bloqueador de um trabalho que já terminou. O motivo honesto é
    // `not_eligible`: este turno não pode ser reivindicado, ponto.
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2, repos: repos() });
    void m1;
    await concluir(m2);
    const r = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m2,
        worker_id: 'w2',
        lease_ms: LEASE_MS,
      }),
    );
    expect(r.ok === false && r.reason).toBe('not_eligible');
  });

  it('turno terminal NÃO bloqueia — nem superseded, nem dead_letter', async () => {
    // O predicado é "não terminal". Se `superseded` bloqueasse, todo turno
    // absorvido pelo debounce travaria a conversa dele para sempre; se
    // `dead_letter` bloqueasse, seria a falha nº 5 da issue-mãe ("um turno em
    // DLQ bloqueia a stream para sempre").
    // Estado e outcome NÃO são livres: o CHECK `agent_turns_status_outcome_chk`
    // (migration 097) só aceita os pares de `TERMINAL_OUTCOMES`. Os pares abaixo
    // vêm de lá.
    const terminais: ReadonlyArray<readonly [string, string]> = [
      ['completed', 'reply_delivered'],
      ['ignored', 'blocked_by_policy'],
      ['superseded', 'merged_into_turn'],
      ['dead_letter', 'retry_exhausted'],
    ];
    for (const [terminal, outcome] of terminais) {
      const key = streamKey();
      const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
      const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2, repos: repos() });
      await pool.query(
        `UPDATE agent_turns SET status = $2, outcome = $3 WHERE id = $1`,
        [m1, terminal, outcome],
      );
      const r2 = await inA(() =>
        repos().agentTurnsRepo.claimNextEligibleTurn({
          turn_id: m2,
          worker_id: 'w2',
          lease_ms: LEASE_MS,
        }),
      );
      expect(r2.ok, `terminal=${terminal}`).toBe(true);
    }
  }, 30_000);

  // ─── 3. `stream_blocked`: a recusa que o tempo não resolve ─────────────────

  it('head em outbound_pending devolve stream_blocked, não not_head', async () => {
    // As duas recusas param o claim; a leitura operacional é oposta. `not_head`
    // é "espere, o anterior avança sozinho". `stream_blocked` é "nenhum claim
    // move o anterior — quem o move é o delivery worker do outbox (#506)".
    // Colapsá-las mandaria o operador esperar por algo que não vai acontecer.
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2, repos: repos() });
    await setStatus(m1, 'outbound_pending');

    const r2 = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m2,
        worker_id: 'w2',
        lease_ms: LEASE_MS,
      }),
    );
    expect(r2.ok === false && r2.reason).toBe('stream_blocked');
    expect(r2.ok === false && r2.head_block?.turn_id).toBe(m1);
  });

  // ─── 4. Paralelismo: a regra é POR STREAM ─────────────────────────────────

  it('conversas DISTINTAS seguem em paralelo — nenhum lock global', async () => {
    // Este caso fica VERMELHO se a serialização for global (por tenant, agente
    // ou fila) em vez de por stream — a exigência nº 8 do objetivo da #505
    // ("ausência de lock global por tenant, agente ou fila").
    //
    // Cada conversa está num ponto DIFERENTE do próprio contador (a conversa i
    // começa em `i*10+1`), que é o estado normal de um agente com N conversas
    // vivas: `ingress_seq` é por stream, e conversas nascidas em momentos
    // diferentes nunca estão no mesmo número. Essa diferença é o que torna o
    // caso CAPAZ de detectar serialização global — com todas as conversas
    // começando em 1, um `NOT EXISTS` sem a correlação por `stream_key`
    // passaria despercebido, porque nenhum turno teria sequência menor que 1.
    // Com os pontos distintos, a versão global deixaria passar apenas a
    // conversa de menor sequência.
    const chaves = Array.from({ length: 12 }, () => streamKey());
    const heads: string[] = [];
    for (const [i, key] of chaves.entries()) {
      const base = i * 10 + 1;
      heads.push(
        await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: base, repos: repos() }),
      );
      await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: base + 1, repos: repos() });
      await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: base + 2, repos: repos() });
    }

    const results = await Promise.all(
      heads.map((turn_id, i) =>
        inA(() =>
          repos().agentTurnsRepo.claimNextEligibleTurn({
            turn_id,
            worker_id: `w-${i}`,
            lease_ms: LEASE_MS,
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(chaves.length);
  }, 30_000);

  it('a MESMA stream_key em TENANTS diferentes não se bloqueia', async () => {
    // O escopo é parte da REGRA, não só do índice. Sem `tenant_id`/`agent_id`
    // no `NOT EXISTS`, uma colisão de hash faria o turno da tenant A bloquear a
    // conversa da B — e o bloqueio seria invisível na linha de B.
    const key = streamKey();
    const a1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    // Em B só existe o turno de sequência 2: se o escopo vazasse, o turno de
    // sequência 1 da tenant A o barraria.
    const b2 = await turnInStream({ tenant: T_B, agent: A_B, stream_key: key, seq: 2, repos: repos() });

    const rB = await inB(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: b2,
        worker_id: 'wb',
        lease_ms: LEASE_MS,
      }),
    );
    const rA = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: a1,
        worker_id: 'wa',
        lease_ms: LEASE_MS,
      }),
    );
    expect(rB.ok).toBe(true);
    expect(rA.ok).toBe(true);
  });

  it('turno anterior ao protocolo (stream_key NULL) segue claimável', async () => {
    // Sem backfill (decisão da fatia A), turnos históricos têm `stream_key`
    // NULL. Recusá-los tornaria INCLAIMÁVEL todo o histórico — uma parada total
    // do ingresso causada pela própria proteção.
    const t1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: null, seq: null, repos: repos() });
    const t2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: null, seq: null, repos: repos() });
    for (const t of [t1, t2]) {
      expect(
        (
          await inA(() =>
            repos().agentTurnsRepo.claimNextEligibleTurn({
              turn_id: t,
              worker_id: 'w',
              lease_ms: LEASE_MS,
            }),
          )
        ).ok,
      ).toBe(true);
    }
  });

  // ─── 5. O RECOVERY usa a MESMA função ─────────────────────────────────────

  it('findRecoverableTurns devolve SÓ o head da stream — a mesma regra do claim', async () => {
    // A exigência literal da issue: "Recovery usa a mesma regra FIFO que o
    // worker — mesma função". O formato do defeito, se as regras divergissem: o
    // varredor rearma o turno posterior, o job acorda, o claim recusa e a
    // conversa não anda — enquanto a métrica de recovery diz que houve trabalho.
    const key = streamKey();
    const antigo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2, repos: repos() });
    const m3 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 3, repos: repos() });
    await pool.query(`UPDATE agent_turns SET created_at = $2 WHERE id = ANY($1::uuid[])`, [
      [m1, m2, m3],
      antigo,
    ]);

    const candidatos = await inA(() => repos().agentTurnsRepo.findRecoverableTurns(1_000, 200));
    expect(candidatos.map((c) => c.turn.id)).toEqual([m1]);

    // E a fila anda no recovery também: concluído o head, o próximo aparece.
    await concluir(m1);
    const depois = await inA(() => repos().agentTurnsRepo.findRecoverableTurns(1_000, 200));
    expect(depois.map((c) => c.turn.id)).toEqual([m2]);
  });

  it('o dispatcher cross-tenant não enumera um par cujos candidatos estão todos atrás do head', async () => {
    // O dispatcher roda FORA de contexto de tenant e correlaciona o escopo com
    // as colunas da própria linha. Se ele não carregasse a regra, enumeraria o
    // par a cada varredura para o inner devolver lista vazia.
    const key = streamKey();
    const antigo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2, repos: repos() });
    await pool.query(`UPDATE agent_turns SET created_at = $2 WHERE id = ANY($1::uuid[])`, [
      [m1, m2],
      antigo,
    ]);
    // O head sai do caminho do recovery (`outbound_pending` não é recuperável)
    // e continua bloqueando a ordem: não sobra trabalho neste par.
    await setStatus(m1, 'outbound_pending');

    const pares = await repos().agentTurnsRepo.listTenantAgentPairsWithRecoverableTurns(1_000);
    expect(pares.filter((p) => p.tenant_id === T_A && p.agent_id === A_A)).toEqual([]);
  });

  it('o canário do recovery não acusa nada quando a regra está de pé', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2, repos: repos() });
    // O canário é consultado com os ids que o filtro devolveu; aqui passamos os
    // DOIS de propósito, para provar que ele SABE apontar o fora-de-ordem — e
    // que o filtro é quem impede que ele receba um.
    const foraDeOrdem = await inA(() => repos().agentTurnsRepo.listNonHeadTurns([m1, m2]));
    expect(foraDeOrdem.map((f) => f.turn_id)).toEqual([m2]);
    const doFiltro = await inA(() => repos().agentTurnsRepo.findRecoverableTurns(1_000, 200));
    expect(
      await inA(() => repos().agentTurnsRepo.listNonHeadTurns(doFiltro.map((c) => c.turn.id))),
    ).toEqual([]);
  });

  // ─── 6. `maia_stream_fifo_violation_total` ────────────────────────────────

  it('maia_stream_fifo_violation_total EXISTE, começa em zero e continua zero', async () => {
    // "Existe e é sempre zero" só é verificável se a série for PUBLICADA em
    // zero: um contador que nasce na primeira violação satisfaria "sempre zero"
    // por ausência, e nenhum alerta escrito contra ele dispararia nunca.
    streamMetrics().registrarSeriesDeStream();
    const antes = await metricas().renderPrometheus();
    expect(antes).toContain('maia_stream_fifo_violation_total{stage="claim"} 0');
    expect(antes).toContain('maia_stream_fifo_violation_total{stage="recovery"} 0');

    // Uma rajada LEGÍTIMA: três mensagens da mesma conversa, tentadas fora de
    // ordem. Nenhuma delas pode produzir violação — a regra as barra antes.
    const key = streamKey();
    const m: string[] = [];
    for (const seq of [1, 2, 3]) {
      m.push(await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq, repos: repos() }));
    }
    for (const turn_id of [m[2]!, m[1]!, m[0]!, m[1]!]) {
      await inA(() =>
        repos().agentTurnsRepo.claimNextEligibleTurn({ turn_id, worker_id: 'w', lease_ms: LEASE_MS }),
      );
    }

    const depois = await metricas().renderPrometheus();
    expect(depois).toContain('maia_stream_fifo_violation_total{stage="claim"} 0');
    expect(depois).toContain('maia_stream_fifo_violation_total{stage="recovery"} 0');
    // E o bloqueio FOI medido — senão o zero acima seria zero por nada ter
    // acontecido, e não por a regra ter agido.
    expect(depois).toMatch(/maia_stream_blocked_total\{reason="not_head"\} [1-9]/);
  }, 30_000);

  // ─── 7. Interação com a fatia B (exclusão por stream) ─────────────────────

  it('recuperar o claim expirado do head NÃO libera o sucessor', async () => {
    // A fatia B recupera, DENTRO da transação do claim, o turno cuja lease
    // venceu — e, antes desta fatia, quem se beneficiava era o SUCESSOR: ele
    // entrava na hora, fora de ordem. Agora o beneficiado é o próprio head, na
    // vez dele. A recuperação continua acontecendo (é o que destrava a stream),
    // e o sucessor continua parado (é o que mantém a ordem).
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2, repos: repos() });

    expect(
      (
        await inA(() =>
          repos().agentTurnsRepo.claimNextEligibleTurn({
            turn_id: m1,
            worker_id: 'zumbi',
            lease_ms: LEASE_MS,
          }),
        )
      ).ok,
    ).toBe(true);
    await expireLease(m1);

    const doSucessor = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m2,
        worker_id: 'sucessor',
        lease_ms: LEASE_MS,
      }),
    );
    expect(doSucessor.ok).toBe(false);
    expect(doSucessor.ok === false && doSucessor.reason).toBe('not_head');
    // A metade TEMPORAL da fatia B agiu mesmo no caminho que ia fracassar —
    // sem ela o head ficaria `claimed` para sempre e a stream não destravaria
    // nem para ele.
    expect(doSucessor.recovered_stream_claims).toEqual([m1]);
    expect((await readTurn(m1))['status']).toBe('retryable');

    // E o head, rearmado, entra.
    expect(
      (
        await inA(() =>
          repos().agentTurnsRepo.claimNextEligibleTurn({
            turn_id: m1,
            worker_id: 'sucessor',
            lease_ms: LEASE_MS,
          }),
        )
      ).ok,
    ).toBe(true);
  });

  // ─── 8. O call site REAL do runtime ───────────────────────────────────────

  it('beginTurnExecution (call site de produção) devolve not_head e AUDITA', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2, repos: repos() });

    const primeiro = await inA(() => turns().beginTurnExecution(handleFor(m1)));
    const segundo = await inA(() => turns().beginTurnExecution(handleFor(m2)));

    expect(primeiro.started).toBe(true);
    expect(segundo.started).toBe(false);
    expect(segundo.started === false && segundo.reason).toBe('not_head');

    // A TRILHA. `stream.blocked` é auditoria mínima pela issue-mãe, e sem a row
    // "a conversa parou" e "a conversa parou atrás DAQUELE turno" seriam o mesmo
    // registro. Nenhuma `stream_key` na row — a issue-mãe a restringe a log
    // protegido; o par de turnos já ancora a investigação.
    const trilha = await pool.query(
      `SELECT metadata FROM audit_log
        WHERE tenant_id = $1 AND acao = 'turn_stream_blocked' AND alvo_id = $2`,
      [T_A, m2],
    );
    expect(trilha.rows).toHaveLength(1);
    const meta = (trilha.rows[0] as { metadata: Record<string, unknown> }).metadata;
    expect(meta['reason']).toBe('not_head');
    expect(meta['blocked_by_turn_id']).toBe(m1);
    expect(JSON.stringify(meta)).not.toContain(key);
  }, 30_000);
});
