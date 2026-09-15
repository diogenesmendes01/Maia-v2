/**
 * P03 (spec Maia+Hermes §5.6.2) — o JOURNAL DE EXECUÇÃO contra Postgres REAL
 * (migrations 139/140).
 *
 * Prova o que só o banco pode provar — e que nenhum teste com mock alcança,
 * porque o ponto inteiro destas regras é valerem para quem NÃO passa pelo
 * repositório (um `UPDATE` de incidente no psql, um backfill, um script):
 *
 *  1. escopo é FK composta: binding/run/call de um tenant não alcançam linhas de outro;
 *  2. no máximo UM run não fechado por turno (unique parcial);
 *  3. `request_key` é identidade do start — repetir com outros bytes é conflito;
 *  4. colunas imutáveis recusam UPDATE (pin, pedido, contexto, origem, identidade da chamada);
 *  5. `remote_run_id` passa NULL→valor UMA vez, e reatribuir bloqueia;
 *  6. terminal aceito não é substituído;
 *  7. `effect_evidence` é MONOTÔNICO: `possible`/`unknown` não voltam a `none`;
 *  8. `engine_run_events` é append-only (UPDATE e DELETE recusados);
 *  9. os CHECKs de coerência (`closed` sem motivo, `result_ready` sem terminal,
 *     `handler_started` sem token, `effect_unknown` com evidência errada) reprovam;
 * 10. identidade da chamada é única por `(run, call_id)` e por `(run, ordinal)`.
 *
 * Skipped sem `TEST_DB_URL` — a lane unit-only continua passando sem Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// Ids NAMESPACED: `agents.id` é PK global e um id genérico colidiria com seeds
// de outras suítes.
const T_A = 'hermes140-tenant-a';
const G_A = 'hermes140-agent-a';
const T_B = 'hermes140-tenant-b';
const G_B = 'hermes140-agent-b';

const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

let pool: pg.Pool;

async function ensureTenantAgent(tenant: string, agent: string): Promise<void> {
  await pool.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [
    tenant,
  ]);
  await pool.query(
    'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING',
    [agent, tenant],
  );
}

/** Inbound cru + turno em `running`, que é o estado que autoriza um run. */
async function mkTurn(tenant: string, agent: string): Promise<{ turn_id: string; claim: string }> {
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, created_at)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, now())`,
    [mensagem_id, tenant, agent],
  );
  const turn_id = randomUUID();
  const claim = randomUUID();
  await pool.query(
    `INSERT INTO agent_turns (id, tenant_id, agent_id, representative_message_id, status, claim_token, attempt_count)
     VALUES ($1, $2, $3, $4, 'running', $5, 1)`,
    [turn_id, tenant, agent, mensagem_id, claim],
  );
  return { turn_id, claim };
}

async function mkControl(tenant: string, agent: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO conversation_controls (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id)
     VALUES ($1, $2, $3, $4, 1, $5)`,
    [id, tenant, agent, `stream-${id}`, randomUUID()],
  );
  return id;
}

async function mkBinding(tenant: string, agent: string, turn_id: string): Promise<void> {
  await pool.query(
    `INSERT INTO engine_turn_bindings (tenant_id, agent_id, turn_id, engine, adapter_revision, configuration_digest, protocol_version, max_generations)
     VALUES ($1, $2, $3, 'hermes', 'adapter-0.1.0', $4, 1, 3)`,
    [tenant, agent, turn_id, SHA],
  );
}

type RunOver = Partial<{
  phase: string;
  generation_no: number;
  request_key: string;
  remote_run_id: string | null;
  mode: string;
}>;

async function mkRun(
  tenant: string,
  agent: string,
  turn_id: string,
  claim: string,
  control_id: string,
  over: RunOver = {},
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO engine_runs (
       id, tenant_id, agent_id, turn_id, generation_no, origin_turn_attempt, origin_claim_token,
       origin_worker_id, control_id, control_epoch, mode, manifest_digest, phase, request_key,
       remote_instance_id, remote_run_id, request_json, request_hash, host_context_json,
       host_context_hash, deadline_at, reconcile_deadline_at)
     VALUES ($1,$2,$3,$4,$5,1,$6,'worker-1',$7,0,$8,$9,$10,$11,'inst-1',$12,
             '{"version":1}'::jsonb,$13,'{"version":1}'::jsonb,$14,
             now() + interval '5 minutes', now() + interval '30 minutes')`,
    [
      id,
      tenant,
      agent,
      turn_id,
      over.generation_no ?? 1,
      claim,
      control_id,
      over.mode ?? 'live',
      SHA,
      over.phase ?? 'running',
      over.request_key ?? randomUUID(),
      over.remote_run_id ?? null,
      SHA,
      SHA2,
    ],
  );
  return id;
}

async function mkCall(
  tenant: string,
  agent: string,
  turn_id: string,
  run_id: string,
  over: Partial<{ call_id: string; ordinal: number; state: string; evidence: string }> = {},
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO engine_tool_calls (
       id, tenant_id, agent_id, turn_id, run_id, call_id, ordinal, tool_name, args_json, args_hash,
       request_id, state, effect_evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'maia_fixture_echo','{"texto":"oi"}'::jsonb,$8,$9,$10,$11)`,
    [
      id,
      tenant,
      agent,
      turn_id,
      run_id,
      over.call_id ?? `${run_id}:0`,
      over.ordinal ?? 0,
      SHA,
      randomUUID(),
      over.state ?? 'received',
      over.evidence ?? 'none',
    ],
  );
  return id;
}

/** Erro do Postgres com `code`, para asserção por SQLSTATE e não por mensagem. */
async function expectPgError(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code ?? '', message: e.message ?? '' };
  }
  throw new Error('esperava erro do Postgres, mas a operação passou');
}

d('journal de execução do engine — Postgres real (migrations 139/140)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await ensureTenantAgent(T_A, G_A);
    await ensureTenantAgent(T_B, G_B);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('1. escopo: binding não alcança turno de outro tenant (FK composta)', async () => {
    const { turn_id } = await mkTurn(T_B, G_B);
    const erro = await expectPgError(() => mkBinding(T_A, G_A, turn_id));
    expect(erro.code).toBe('23503'); // foreign_key_violation
  });

  it('1b. escopo: o literal `default` é recusado pelo CHECK', async () => {
    const erro = await expectPgError(() =>
      pool.query(
        `INSERT INTO conversation_controls (tenant_id, agent_id, stream_key, stream_key_version, channel_id)
         VALUES ('default','default','s',1,$1)`,
        [randomUUID()],
      ),
    );
    expect(erro.code).toBe('23514'); // check_violation
  });

  it('2. no máximo UM run não fechado por turno', async () => {
    const { turn_id, claim } = await mkTurn(T_A, G_A);
    const control = await mkControl(T_A, G_A);
    await mkBinding(T_A, G_A, turn_id);
    await mkRun(T_A, G_A, turn_id, claim, control, { generation_no: 1 });

    const erro = await expectPgError(() =>
      mkRun(T_A, G_A, turn_id, claim, control, { generation_no: 2 }),
    );
    expect(erro.code).toBe('23505'); // unique_violation

    // Fechar o primeiro libera a segunda geração — e fechar exige motivo,
    // instante e revogação de capacidade (CHECK de coerência).
    const runs = await pool.query<{ id: string }>(
      'SELECT id FROM engine_runs WHERE tenant_id=$1 AND agent_id=$2 AND turn_id=$3',
      [T_A, G_A, turn_id],
    );
    await pool.query(
      `UPDATE engine_runs SET phase='closed', closed_reason='discarded', closed_at=now(),
         capabilities_revoked_at=now() WHERE id=$1`,
      [runs.rows[0]?.id],
    );
    await expect(
      mkRun(T_A, G_A, turn_id, claim, control, { generation_no: 2 }),
    ).resolves.toBeTruthy();
  });

  it('3. `request_key` é única por escopo — reenviar outro pedido com a mesma chave conflita', async () => {
    const a = await mkTurn(T_A, G_A);
    const b = await mkTurn(T_A, G_A);
    const control = await mkControl(T_A, G_A);
    await mkBinding(T_A, G_A, a.turn_id);
    await mkBinding(T_A, G_A, b.turn_id);
    const chave = randomUUID();
    await mkRun(T_A, G_A, a.turn_id, a.claim, control, { request_key: chave });
    const erro = await expectPgError(() =>
      mkRun(T_A, G_A, b.turn_id, b.claim, control, { request_key: chave }),
    );
    expect(erro.code).toBe('23505');
  });

  it('4. colunas imutáveis do run recusam UPDATE', async () => {
    const { turn_id, claim } = await mkTurn(T_A, G_A);
    const control = await mkControl(T_A, G_A);
    await mkBinding(T_A, G_A, turn_id);
    const run = await mkRun(T_A, G_A, turn_id, claim, control);

    for (const [coluna, valor] of [
      ['request_json', `'{"version":1,"adulterado":true}'::jsonb`],
      ['request_hash', `'${SHA2}'`],
      ['host_context_json', `'{"version":1,"x":1}'::jsonb`],
      ['origin_claim_token', `'${randomUUID()}'::uuid`],
      ['origin_turn_attempt', '2'],
      ['generation_no', '9'],
      ['mode', `'shadow'`],
      ['manifest_digest', `'${SHA2}'`],
      ['control_id', `'${randomUUID()}'::uuid`],
    ] as const) {
      const erro = await expectPgError(() =>
        pool.query(`UPDATE engine_runs SET ${coluna} = ${valor} WHERE id=$1`, [run]),
      );
      expect(erro.message, `coluna ${coluna}`).toMatch(/imutavel|imutável/i);
    }

    // O que PODE mudar continua mudando: fase, contadores e observação.
    await expect(
      pool.query(
        `UPDATE engine_runs SET phase='reconciling', poll_count=poll_count+1, last_observed_at=now() WHERE id=$1`,
        [run],
      ),
    ).resolves.toBeTruthy();
  });

  it('5. `remote_run_id` é atribuído UMA vez; reatribuir bloqueia', async () => {
    const { turn_id, claim } = await mkTurn(T_A, G_A);
    const control = await mkControl(T_A, G_A);
    await mkBinding(T_A, G_A, turn_id);
    const run = await mkRun(T_A, G_A, turn_id, claim, control);

    // Ids ÚNICOS por rodada: `engine_runs_remote_uq` é
    // `(tenant, agent, remote_instance_id, remote_run_id)` e o banco de teste
    // sobrevive entre execuções — um literal fixo passaria na primeira rodada e
    // colidiria na segunda. (Foi exatamente o que aconteceu ao rodar esta spec
    // duas vezes: defeito do teste, não do schema.)
    const remoto = `w-${randomUUID()}`;
    const outro = `w-${randomUUID()}`;

    await pool.query('UPDATE engine_runs SET remote_run_id=$2 WHERE id=$1', [run, remoto]);
    const erro = await expectPgError(() =>
      pool.query('UPDATE engine_runs SET remote_run_id=$2 WHERE id=$1', [run, outro]),
    );
    expect(erro.message).toMatch(/remote_run_id/);
    // Reescrever o MESMO valor é no-op aceitável (redelivery do mesmo aceite).
    await expect(
      pool.query('UPDATE engine_runs SET remote_run_id=$2 WHERE id=$1', [run, remoto]),
    ).resolves.toBeTruthy();
  });

  it('6. terminal aceito não é substituído', async () => {
    const { turn_id, claim } = await mkTurn(T_A, G_A);
    const control = await mkControl(T_A, G_A);
    await mkBinding(T_A, G_A, turn_id);
    const run = await mkRun(T_A, G_A, turn_id, claim, control);

    await pool.query(
      `UPDATE engine_runs SET terminal_json='{"version":1}'::jsonb, terminal_hash=$2, phase='result_ready' WHERE id=$1`,
      [run, SHA],
    );
    const erro = await expectPgError(() =>
      pool.query(
        `UPDATE engine_runs SET terminal_json='{"version":1,"outro":true}'::jsonb, terminal_hash=$2 WHERE id=$1`,
        [run, SHA2],
      ),
    );
    expect(erro.message).toMatch(/terminal/i);
  });

  it('7. `effect_evidence` não regride para `none`', async () => {
    const { turn_id, claim } = await mkTurn(T_A, G_A);
    const control = await mkControl(T_A, G_A);
    await mkBinding(T_A, G_A, turn_id);
    const run = await mkRun(T_A, G_A, turn_id, claim, control);
    const call = await mkCall(T_A, G_A, turn_id, run, { evidence: 'possible' });

    const erro = await expectPgError(() =>
      pool.query(`UPDATE engine_tool_calls SET effect_evidence='none' WHERE id=$1`, [call]),
    );
    expect(erro.message).toMatch(/effect_evidence/);
    // Avançar continua permitido: possible -> unknown -> committed.
    await expect(
      pool.query(`UPDATE engine_tool_calls SET effect_evidence='committed' WHERE id=$1`, [call]),
    ).resolves.toBeTruthy();
  });

  it('8. `engine_run_events` é append-only', async () => {
    const { turn_id, claim } = await mkTurn(T_A, G_A);
    const control = await mkControl(T_A, G_A);
    await mkBinding(T_A, G_A, turn_id);
    const run = await mkRun(T_A, G_A, turn_id, claim, control);

    await pool.query(
      `INSERT INTO engine_run_events (tenant_id, agent_id, run_id, sequence_no, dedupe_key, event_type, actor_kind, metadata_json)
       VALUES ($1,$2,$3,1,'prep-1','prepared','turn_owner','{"k":"v"}'::jsonb)`,
      [T_A, G_A, run],
    );

    const upd = await expectPgError(() =>
      pool.query(`UPDATE engine_run_events SET event_type='closed' WHERE run_id=$1`, [run]),
    );
    expect(upd.message).toMatch(/append-only/i);

    const del = await expectPgError(() =>
      pool.query('DELETE FROM engine_run_events WHERE run_id=$1', [run]),
    );
    expect(del.message).toMatch(/append-only/i);

    // Dedupe por chave: o mesmo evento não entra duas vezes.
    const dup = await expectPgError(() =>
      pool.query(
        `INSERT INTO engine_run_events (tenant_id, agent_id, run_id, sequence_no, dedupe_key, event_type, actor_kind, metadata_json)
         VALUES ($1,$2,$3,2,'prep-1','prepared','turn_owner','{}'::jsonb)`,
        [T_A, G_A, run],
      ),
    );
    expect(dup.code).toBe('23505');
  });

  it('9. CHECKs de coerência reprovam estados impossíveis', async () => {
    const { turn_id, claim } = await mkTurn(T_A, G_A);
    const control = await mkControl(T_A, G_A);
    await mkBinding(T_A, G_A, turn_id);
    const run = await mkRun(T_A, G_A, turn_id, claim, control);

    // `closed` sem motivo/instante/revogação
    const fechado = await expectPgError(() =>
      pool.query(`UPDATE engine_runs SET phase='closed' WHERE id=$1`, [run]),
    );
    expect(fechado.code).toBe('23514');

    // `result_ready` sem terminal
    const pronto = await expectPgError(() =>
      pool.query(`UPDATE engine_runs SET phase='result_ready' WHERE id=$1`, [run]),
    );
    expect(pronto.code).toBe('23514');

    // `handler_started` sem marcador/tokens
    const call = await mkCall(T_A, G_A, turn_id, run);
    const handler = await expectPgError(() =>
      pool.query(`UPDATE engine_tool_calls SET state='handler_started' WHERE id=$1`, [call]),
    );
    expect(handler.code).toBe('23514');

    // `effect_unknown` com evidência diferente de `unknown`
    const incerto = await expectPgError(() =>
      pool.query(
        `UPDATE engine_tool_calls SET state='effect_unknown', finished_at=now(), result_json='{}'::jsonb WHERE id=$1`,
        [call],
      ),
    );
    expect(incerto.code).toBe('23514');
  });

  it('10. identidade da chamada é única por (run, call_id) e por (run, ordinal)', async () => {
    const { turn_id, claim } = await mkTurn(T_A, G_A);
    const control = await mkControl(T_A, G_A);
    await mkBinding(T_A, G_A, turn_id);
    const run = await mkRun(T_A, G_A, turn_id, claim, control);
    await mkCall(T_A, G_A, turn_id, run, { call_id: `${run}:0`, ordinal: 0 });

    const mesmoCallId = await expectPgError(() =>
      mkCall(T_A, G_A, turn_id, run, { call_id: `${run}:0`, ordinal: 1 }),
    );
    expect(mesmoCallId.code).toBe('23505');

    const mesmoOrdinal = await expectPgError(() =>
      mkCall(T_A, G_A, turn_id, run, { call_id: `${run}:1`, ordinal: 0 }),
    );
    expect(mesmoOrdinal.code).toBe('23505');

    // Ordinal seguinte entra normalmente.
    await expect(
      mkCall(T_A, G_A, turn_id, run, { call_id: `${run}:1`, ordinal: 1 }),
    ).resolves.toBeTruthy();
  });

  it('11. aprovação de outro tenant não pode ser vinculada à chamada', async () => {
    const { turn_id, claim } = await mkTurn(T_A, G_A);
    const control = await mkControl(T_A, G_A);
    await mkBinding(T_A, G_A, turn_id);
    const run = await mkRun(T_A, G_A, turn_id, claim, control);
    const call = await mkCall(T_A, G_A, turn_id, run);

    // Colunas conferidas no banco (migration 095), não deduzidas do ORM: as
    // obrigatórias sem default são tenant/agent, requester_pessoa_id, tool,
    // operation_type, intent_payload, intent_hash, approval_class,
    // required_approvals, fingerprint e expires_at. `requester_pessoa_id` NÃO
    // tem FK para `pessoas` — o escopo dela é garantido pelo caminho de
    // aprovação, não pelo banco —, então um uuid sintético basta aqui.
    const approvalB = randomUUID();
    await pool.query(
      `INSERT INTO approval_requests (
         id, tenant_id, agent_id, requester_pessoa_id, tool, operation_type,
         intent_payload, intent_hash, approval_class, required_approvals, fingerprint, expires_at)
       VALUES ($1,$2,$3,$4,'tool_x','create','{}'::jsonb,$5,'single_confirmation',1,$6,
               now() + interval '1 hour')`,
      [approvalB, T_B, G_B, randomUUID(), SHA, `fp-${approvalB}`],
    );

    const erro = await expectPgError(() =>
      pool.query(
        `UPDATE engine_tool_calls SET approval_request_id=$2 WHERE id=$1`,
        [call, approvalB],
      ),
    );
    expect(erro.code).toBe('23503');
  });
});
