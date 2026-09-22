/**
 * Spec Maia+Hermes §5.8.2/§5.8.4, INV-06, INV-09 — o RECONCILIADOR contra
 * Postgres real.
 *
 * O spec unitário prova a POLÍTICA com um repositório dublado. Este prova o que
 * só o banco pode provar, e que é justamente onde este worker seria mais fácil
 * de acertar por engano:
 *
 *   1. as recusas tipadas (`not_due`, `reservation_stale`, `phase_conflict`)
 *      são as do PostgreSQL, com locks e CAS de verdade, e não as do dublê;
 *   2. as escritas passam pelos CHECKs e triggers da 140 — um evento gravado
 *      com ator errado, ou um fechamento sem prova, quebraria aqui;
 *   3. o **efeito no turno** é o produto final: depois da varredura,
 *      `routeExistingEngineRun` deixa de mandar o turno para o laço de retry.
 *      Essa cadeia — journal → rota → desfecho do turno — não existe em
 *      nenhum dos dois lados isoladamente.
 *
 * O mundo é POLUÍDO de propósito (o banco local acumula runs de rodadas
 * anteriores), então toda asserção é sobre o ESCOPO semeado por este arquivo —
 * nunca sobre o conjunto global. Mesma disciplina de
 * `hermes-engine-sweep-real-db.spec.ts`, e pelo mesmo motivo.
 *
 * Skipped sem `TEST_DB_URL`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { engineRunsRepo } from '@/db/repositories/engine-repos.js';
import { reconcileDueRun } from '@/workers/engine-run-reconciler.js';
import { routeExistingEngineRun } from '@/runtime/engines/route-existing-run.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const SHA = 'a'.repeat(64);

let pool: pg.Pool;

type Escopo = { tenant_id: string; agent_id: string };

function novoEscopo(): Escopo {
  const id = randomUUID().slice(0, 8);
  return { tenant_id: `recon-t-${id}`, agent_id: `recon-a-${id}` };
}

const sob = <T>(e: Escopo, fn: () => Promise<T>): Promise<T> => runWithTenantContext(e, fn);

const escoposCriados: Escopo[] = [];

async function seedEscopo(e: Escopo): Promise<void> {
  await pool.query('INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING', [
    e.tenant_id,
  ]);
  await pool.query(
    'INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING',
    [e.agent_id, e.tenant_id],
  );
  escoposCriados.push(e);
}

async function mkControle(e: Escopo): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO conversation_controls (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id)
     VALUES ($1,$2,$3,$4,1,$5)`,
    [id, e.tenant_id, e.agent_id, `stream-${id}`, randomUUID()],
  );
  return id;
}

async function mkTurnoVivo(
  e: Escopo,
): Promise<{ turn_id: string; claim_token: string; attempt: number }> {
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, created_at)
     VALUES ($1,$2,$3,NULL,'in','texto','oi','{}'::jsonb, now())`,
    [mensagem_id, e.tenant_id, e.agent_id],
  );
  const turn_id = randomUUID();
  const claim_token = randomUUID();
  await pool.query(
    `INSERT INTO agent_turns (id, tenant_id, agent_id, representative_message_id, status,
        claim_token, claimed_by, attempt_count, lease_expires_at)
     VALUES ($1,$2,$3,$4,'running',$5,'worker-1',1, now() + interval '5 minutes')`,
    [turn_id, e.tenant_id, e.agent_id, mensagem_id, claim_token],
  );
  return { turn_id, claim_token, attempt: 1 };
}

function pedido(
  run_id: string,
  turno: { turn_id: string; claim_token: string; attempt: number },
  control_id: string,
) {
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
    remote_instance_id: 'inst-1',
    request_json: { version: 1 },
    request_hash: SHA,
    host_context_json: { version: 1 },
    host_context_hash: SHA,
    deadline_ms: 300_000,
    reconcile_deadline_ms: 900_000,
  };
}

type CenarioOpts = {
  /** Fase FORÇADA por SQL. O caminho legítimo até ela exige o motor. */
  phase?: string;
  comTerminal?: boolean;
  /** Status final do turno; o §5.8.4 nasce precisamente do turno que ANDOU. */
  turnStatus?: string;
  turnOutcome?: string | null;
  /** Lease morta é o que faz a manutenção deixar de disputar com o dono. */
  leaseMorta?: boolean;
  prazoVencido?: boolean;
};

/**
 * Um run aberto e VENCIDO, no estado pedido.
 *
 * A fase é escrita por SQL, e não alcançada pelas portas do repositório: chegar
 * a `result_ready` pelo caminho legítimo exige `markSubmitting` +
 * `recordStartObservation` + `recordTerminalProposal`, isto é, um motor. O que
 * este arquivo mede é a VARREDURA, não o caminho de start — e a 140 continua
 * valendo, porque `engine_runs_ready_chk` recusaria `result_ready` sem
 * terminal. Mesma técnica de `hermes-runs-real-db.spec.ts`.
 */
async function criarRun(
  e: Escopo,
  opts: CenarioOpts = {},
): Promise<{ run_id: string; turn_id: string }> {
  const turno = await mkTurnoVivo(e);
  const control_id = await mkControle(e);
  const run_id = randomUUID();
  const r = await sob(e, () =>
    engineRunsRepo.pinEngineAndPrepareRun(pedido(run_id, turno, control_id)),
  );
  if (!r.ok) throw new Error(`setup: prepare falhou (${r.reason})`);

  if (opts.comTerminal === true) {
    await pool.query(
      `UPDATE engine_runs SET terminal_json = '{"version":1}'::jsonb, terminal_hash = $2 WHERE id = $1`,
      [run_id, SHA],
    );
  }
  if (opts.phase !== undefined) {
    await pool.query('UPDATE engine_runs SET phase = $2 WHERE id = $1', [run_id, opts.phase]);
  }
  if (opts.prazoVencido === true) {
    // Os DOIS prazos, porque `engine_runs_deadlines_chk` exige
    // `reconcile_deadline_at >= deadline_at`.
    await pool.query(
      `UPDATE engine_runs
          SET deadline_at = clock_timestamp() - interval '2 hours',
              reconcile_deadline_at = clock_timestamp() - interval '1 hour'
        WHERE id = $1`,
      [run_id],
    );
  }
  if (opts.turnStatus !== undefined) {
    await pool.query('UPDATE agent_turns SET status = $2, outcome = $3 WHERE id = $1', [
      turno.turn_id,
      opts.turnStatus,
      opts.turnOutcome ?? null,
    ]);
  }
  if (opts.leaseMorta !== false) {
    await pool.query(
      `UPDATE agent_turns SET lease_expires_at = clock_timestamp() - interval '1 minute' WHERE id = $1`,
      [turno.turn_id],
    );
  }
  return { run_id, turn_id: turno.turn_id };
}

async function lerRun(run_id: string) {
  const r = await pool.query(
    `SELECT phase, closed_reason, capabilities_revoked_at, last_observed_at, last_error_code, row_version
       FROM engine_runs WHERE id = $1`,
    [run_id],
  );
  return r.rows[0] as {
    phase: string;
    closed_reason: string | null;
    capabilities_revoked_at: Date | null;
    last_observed_at: Date | null;
    last_error_code: string | null;
    row_version: string;
  };
}

async function eventos(run_id: string) {
  const r = await pool.query(
    `SELECT event_type, actor_kind, metadata_json FROM engine_run_events
      WHERE run_id = $1 ORDER BY sequence_no`,
    [run_id],
  );
  return r.rows as Array<{
    event_type: string;
    actor_kind: string;
    metadata_json: Record<string, unknown>;
  }>;
}

/** O que `listDueRuns` vê no escopo — a fila real do worker. */
async function devidos(e: Escopo) {
  return sob(e, () => engineRunsRepo.listDueRuns({ limit: 50 }));
}

async function reconciliarTudo(e: Escopo) {
  const fila = await devidos(e);
  const saidas = [];
  for (const due of fila.runs) {
    saidas.push(await sob(e, () => reconcileDueRun(engineRunsRepo, due)));
  }
  return saidas;
}

d('engine-run-reconciler contra Postgres real', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
  });

  /**
   * APOSENTA o que este spec criou, em vez de apagar: `engine_run_events` tem
   * trigger append-only e a FK RESTRICT prende `engine_runs` junto. Empurrar
   * `next_poll_at` tira a linha do conjunto "vencido", que é o que poluiria a
   * varredura cross-tenant de outros arquivos.
   */
  afterAll(async () => {
    for (const e of escoposCriados) {
      await pool.query(
        `UPDATE engine_runs SET next_poll_at = clock_timestamp() + interval '100 years'
          WHERE tenant_id = $1 AND agent_id = $2`,
        [e.tenant_id, e.agent_id],
      );
    }
    await pool.end();
  });

  // ════════════════════════════════════════════════════════════════════════
  // 1. A leitura dos fatos é ESCOPADA
  // ════════════════════════════════════════════════════════════════════════

  it('readRecoveryFacts devolve os fatos do run sob o escopo dele', async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id, turn_id } = await criarRun(e, { turnStatus: 'retryable' });

    const f = await sob(e, () => engineRunsRepo.readRecoveryFacts({ run_id }));

    expect(f).toMatchObject({
      run_id,
      turn_id,
      phase: 'prepared',
      turn_status: 'retryable',
      lease_alive: false,
      control_mode: 'bot',
      has_terminal: false,
      adopted: false,
      unreconciled_calls: 0,
      effect_unknown_calls: 0,
      outbound_rows: 0,
      remote_run_id_known: false,
      capabilities_revoked: false,
      reconcile_deadline_passed: false,
    });
  });

  it('CONTRA-PROVA: o MESMO run é invisível de outro escopo', async () => {
    const dono = novoEscopo();
    const vizinho = novoEscopo();
    await seedEscopo(dono);
    await seedEscopo(vizinho);
    const { run_id } = await criarRun(dono, { turnStatus: 'retryable' });

    // O caso anterior prova que a leitura ENCONTRA. Este prova que o que a
    // faz encontrar é o escopo, e não a existência da linha.
    await expect(
      sob(vizinho, () => engineRunsRepo.readRecoveryFacts({ run_id })),
    ).resolves.toBeNull();
    await expect(
      sob(dono, () => engineRunsRepo.readRecoveryFacts({ run_id })),
    ).resolves.not.toBeNull();
  });

  it('e lança fora de qualquer contexto — não devolve o mundo', async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id } = await criarRun(e);
    await expect(engineRunsRepo.readRecoveryFacts({ run_id })).rejects.toThrow();
  });

  // ════════════════════════════════════════════════════════════════════════
  // 2. O ÓRFÃO fecha — e o turno sai do limbo
  // ════════════════════════════════════════════════════════════════════════

  it('run em result_ready com turno terminal é fechado como `safe_to_retry`', async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id, turn_id } = await criarRun(e, {
      phase: 'result_ready',
      comTerminal: true,
      turnStatus: 'dead_letter',
      turnOutcome: 'retry_exhausted',
    });

    const saidas = await reconciliarTudo(e);
    expect(saidas).toEqual([{ result: 'acted', code: 'orphan_closed' }]);

    const run = await lerRun(run_id);
    expect(run.phase).toBe('closed');
    expect(run.closed_reason).toBe('safe_to_retry');
    // O fechamento também revoga: `closeRunAfterHandoff` faz
    // `COALESCE(capabilities_revoked_at, clock_timestamp())`.
    expect(run.capabilities_revoked_at).not.toBeNull();

    const evs = await eventos(run_id);
    const fechamento = evs.filter((v) => v.event_type === 'closed');
    expect(fechamento).toHaveLength(1);
    // O ator é `recovery`, nunca `turn_owner`: o scanner não é o dono.
    expect(fechamento[0]?.actor_kind).toBe('recovery');
    // A decisão veio ANTES da ação, e ficou no journal.
    expect(evs.some((v) => v.event_type === 'reconcile_decision')).toBe(true);

    // O PRODUTO FINAL: sem run aberto, a rota volta a permitir o pipeline em
    // vez de mandar o turno para o backoff. É isto que tira o turno do limbo.
    const estado = await sob(e, () => engineRunsRepo.findTurnEngineState({ turn_id }));
    expect(estado.kind).toBe('binding_without_open_run');
    expect(routeExistingEngineRun(estado).kind).toBe('run_pipeline');
  });

  it('CONTRA-PROVA: o run fechado não volta para a fila e não é reprocessado', async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id } = await criarRun(e, {
      phase: 'result_ready',
      comTerminal: true,
      turnStatus: 'completed',
      turnOutcome: 'no_reply_produced',
    });

    await reconciliarTudo(e);
    const antes = await lerRun(run_id);

    // Segunda passada: a fila do escopo tem de estar VAZIA — `listDueRuns`
    // filtra por fases abertas — e o journal não pode ter andado.
    const fila = await devidos(e);
    expect(fila.runs.map((r) => r.run_id)).not.toContain(run_id);

    const depois = await lerRun(run_id);
    expect(depois.row_version).toBe(antes.row_version);
    expect((await eventos(run_id)).filter((v) => v.event_type === 'closed')).toHaveLength(1);
  });

  it('e a reserva de um run fechado é recusada por FASE, não silenciada', async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id } = await criarRun(e, {
      phase: 'result_ready',
      comTerminal: true,
      turnStatus: 'completed',
      turnOutcome: 'no_reply_produced',
    });
    await reconciliarTudo(e);

    const r = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: 60_000,
        actor: { kind: 'recovery', actor_ref: 'spec' },
      }),
    );
    expect(r).toMatchObject({ ok: false, reason: 'phase_conflict', current_phase: 'closed' });
  });

  // ════════════════════════════════════════════════════════════════════════
  // 3. INV-06 — `submission_unknown` observa, nunca é declarado morto
  // ════════════════════════════════════════════════════════════════════════

  it('submission_unknown dentro do prazo apenas OBSERVA', async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id, turn_id } = await criarRun(e, {
      phase: 'submission_unknown',
      turnStatus: 'retryable',
    });

    const saidas = await reconciliarTudo(e);
    expect(saidas).toEqual([{ result: 'acted', code: 'awaiting_engine_lookup' }]);

    const run = await lerRun(run_id);
    // NADA de fechamento, nada de bloqueio: o run pode ter sido aceito pelo
    // motor, e ausência de prova não é prova de ausência (§5.3.1).
    expect(run.phase).toBe('submission_unknown');
    expect(run.closed_reason).toBeNull();
    expect(run.last_observed_at).not.toBeNull();

    const decisoes = (await eventos(run_id)).filter((v) => v.event_type === 'reconcile_decision');
    expect(decisoes).toHaveLength(1);
    expect(decisoes[0]?.actor_kind).toBe('recovery');
    expect(decisoes[0]?.metadata_json).toMatchObject({ code: 'awaiting_engine_lookup' });

    // O turno continua barrado de reexecutar — e AGORA com um journal que
    // registra que alguém olhou.
    const estado = await sob(e, () => engineRunsRepo.findTurnEngineState({ turn_id }));
    expect(routeExistingEngineRun(estado).kind).toBe('reconcile_run');
  });

  it('CONTRA-PROVA: passado o prazo ele vai para `blocked`, e o turno vai para uma PESSOA', async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id, turn_id } = await criarRun(e, {
      phase: 'submission_unknown',
      turnStatus: 'retryable',
      prazoVencido: true,
    });

    const saidas = await reconciliarTudo(e);
    expect(saidas).toEqual([{ result: 'acted', code: 'blocked_after_deadline' }]);

    const run = await lerRun(run_id);
    expect(run.phase).toBe('blocked');
    // Bloquear NÃO é fechar: o journal continua aberto para quem for
    // reconciliar, e a `request_key` é preservada.
    expect(run.closed_reason).toBeNull();
    expect(run.last_error_code).toBe('blocked_after_deadline');

    const estado = await sob(e, () => engineRunsRepo.findTurnEngineState({ turn_id }));
    const rota = routeExistingEngineRun(estado);
    expect(rota.kind).toBe('await_operator');
  });

  // ════════════════════════════════════════════════════════════════════════
  // 4. O FENCE — a corrida é decidida pelo PostgreSQL
  // ════════════════════════════════════════════════════════════════════════

  it('a segunda reserva da mesma janela recebe `not_due` e não escreve', async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id } = await criarRun(e, { turnStatus: 'retryable' });

    const primeira = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: 60_000,
        actor: { kind: 'recovery', actor_ref: 'replica-1' },
      }),
    );
    expect(primeira.ok).toBe(true);

    const segunda = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: 60_000,
        actor: { kind: 'recovery', actor_ref: 'replica-2' },
      }),
    );
    expect(segunda).toMatchObject({ ok: false, reason: 'not_due' });

    // E o run some da fila do escopo enquanto a janela dura.
    const fila = await devidos(e);
    expect(fila.runs.map((r) => r.run_id)).not.toContain(run_id);
  });

  it('perder o fence entre a reserva e a gravação é recusa — e o journal não anda', async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id } = await criarRun(e, {
      phase: 'result_ready',
      comTerminal: true,
      turnStatus: 'dead_letter',
      turnOutcome: 'unsafe_to_retry',
    });

    const reserva = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: 60_000,
        actor: { kind: 'recovery', actor_ref: 'replica-1' },
      }),
    );
    if (!reserva.ok) throw new Error('setup: reserva falhou');

    // A JANELA DA RÉPLICA 1 EXPIRA — o cenário do §5.8.4 item 4, e a única
    // forma honesta de produzir uma manutenção atrasada: o relógio anda, não o
    // journal. `next_poll_at` é o único campo tocado, por SQL, porque não há
    // porta que "envelheça" uma reserva.
    await pool.query(
      `UPDATE engine_runs SET next_poll_at = clock_timestamp() - interval '1 minute' WHERE id = $1`,
      [run_id],
    );

    // A réplica 2 reserva e passa a ser a dona da janela (row_version + 1).
    const segunda = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: 60_000,
        actor: { kind: 'recovery', actor_ref: 'replica-2' },
      }),
    );
    if (!segunda.ok) throw new Error('setup: segunda reserva falhou');
    expect(segunda.reserved_row_version).toBeGreaterThan(reserva.reserved_row_version);

    const antes = await lerRun(run_id);
    const tardia = await sob(e, () =>
      engineRunsRepo.recordMaintenanceObservation({
        run_id,
        reserved_row_version: reserva.reserved_row_version,
        actor: { kind: 'recovery', actor_ref: 'replica-1' },
        observation: { code: 'orphan_closed', detail: {} },
      }),
    );

    expect(tardia).toMatchObject({ ok: false, reason: 'reservation_stale' });
    const depois = await lerRun(run_id);
    // O run NÃO fechou: a recusa aconteceu antes de qualquer ação de estado.
    expect(depois.phase).toBe(antes.phase);
    expect(depois.closed_reason).toBeNull();
  });

  // ════════════════════════════════════════════════════════════════════════
  // 5. O dono vivo vence a manutenção
  // ════════════════════════════════════════════════════════════════════════

  it('turno com lease VIVA e ainda reivindicável faz a varredura adiar', async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id } = await criarRun(e, { leaseMorta: false });

    const fila = await devidos(e);
    const due = fila.runs.find((r) => r.run_id === run_id);
    expect(due).toBeDefined();

    const saida = await sob(e, () => reconcileDueRun(engineRunsRepo, due!));
    expect(saida).toEqual({ result: 'skipped', code: 'owner_alive' });

    const run = await lerRun(run_id);
    expect(run.last_observed_at).toBeNull();
    expect((await eventos(run_id)).filter((v) => v.event_type === 'reconcile_decision')).toEqual(
      [],
    );
  });
});
