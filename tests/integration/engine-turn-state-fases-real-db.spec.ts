/**
 * P02 (spec §5.2, segundo seam) — `findTurnEngineState` contra Postgres REAL.
 *
 * ─── Por que este arquivo existe ───────────────────────────────────────────
 *
 * `routeExistingEngineRun` tem treze casos unitários e o PRODUTOR da entrada
 * dele não tinha nenhum. A consequência não foi teórica: a consulta filtrava
 * por `LISTA_FASES_ABERTAS`, que deliberadamente NÃO cobre `blocked` (ela
 * existe para casar com o predicado dos índices parciais da varredura de
 * manutenção), então um run bloqueado respondia `binding_without_open_run`, a
 * rota devolvia `run_pipeline`, e o turno reexecutava pendências, procedures e
 * skills — parte delas commitando efeito — até morrer em `run_already_open` no
 * prepare.
 *
 * O ramo `await_operator` da rota era código MORTO por este caminho, e os
 * casos que o cobrem passavam porque montam o `TurnEngineState` à mão. É a
 * forma clássica de teste vacuoso: a função pura está provada e o produtor
 * nunca emite a entrada que a exercita.
 *
 * Estes casos fecham isso na única camada onde ele podia ser visto — a que
 * fala com o banco.
 *
 * ─── O que cada um prende ──────────────────────────────────────────────────
 *
 *  1. sem binding: `no_binding`, e o pipeline roda (comportamento de sempre);
 *  2. binding com run `running`: `open_run`, e a rota recusa reexecutar;
 *  3. **binding com run `blocked`: `open_run`** — o caso que não existia;
 *  4. binding com run `closed`: `binding_without_open_run`, porque aí
 *     reexecutar é seguro quanto ao ledger. É a contra-prova: sem ela, trocar
 *     o filtro por "qualquer fase" passaria nos três anteriores e quebraria a
 *     retomada normal do turno.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';

import { runWithTenantContext } from '@/db/tenant-context.js';
import { engineRunsRepo } from '@/db/repositories/engine-repos.js';
import { routeExistingEngineRun } from '@/runtime/engines/route-existing-run.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 'primary';
const AGENT = 'primary';

let pool: pg.Pool;
let conversaId: string;
let inboundId: string;
let turnId: string;
let controlId: string;
let streamKey: string;

const hex64 = (semente: string): string => createHash('sha256').update(semente).digest('hex');

function comoEscopo<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, fn);
}

async function criarBinding(): Promise<void> {
  await pool.query(
    `INSERT INTO engine_turn_bindings
       (tenant_id, agent_id, turn_id, engine, adapter_revision, configuration_digest,
        protocol_version, max_generations)
     VALUES ($1, $2, $3, 'hermes', 'rev-1', $4, 1, 3)`,
    [TENANT, AGENT, turnId, hex64('config')],
  );
}

async function criarRun(phase: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO engine_runs
       (tenant_id, agent_id, turn_id, generation_no, origin_turn_attempt, origin_claim_token,
        origin_worker_id, control_id, control_epoch, mode, manifest_digest, phase,
        request_key, remote_instance_id, request_json, request_hash,
        host_context_json, host_context_hash, deadline_at)
     VALUES ($1, $2, $3, 1, 1, $4, 'spec-worker', $5, 0, 'live', $6, $7,
             $8, 'spec-instance', '{}'::jsonb, $9, '{}'::jsonb, $10, now() + interval '1 hour')
     RETURNING id`,
    [
      TENANT,
      AGENT,
      turnId,
      randomUUID(),
      controlId,
      hex64('manifest'),
      phase,
      randomUUID(),
      hex64('request'),
      hex64('host'),
    ],
  );
  return r.rows[0]!.id;
}

d('findTurnEngineState — o PRODUTOR do segundo seam (Postgres real)', () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 10 });
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.end();
  });

  beforeEach(async () => {
    streamKey = `wa:seam:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const c = await pool.connect();
    try {
      const canal = await c.query<{ id: string }>(
        `INSERT INTO channels (tenant_id, agent_id, channel_type, external_id, active)
         VALUES ($1, $2, 'web', $3, true) RETURNING id`,
        [TENANT, AGENT, `seam-${streamKey}`],
      );
      const p = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1, $2, 'Sonda seam', $3, 'dono', 'ativa') RETURNING id`,
        [TENANT, AGENT, `+55119${Date.now().toString().slice(-8)}`],
      );
      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status)
         VALUES ($1, $2, $3, 'ativa') RETURNING id`,
        [TENANT, AGENT, p.rows[0]!.id],
      );
      conversaId = conv.rows[0]!.id;
      const m = await c.query<{ id: string }>(
        `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
         VALUES ($1, $2, $3, 'in', 'texto', 'oi', '{}'::jsonb) RETURNING id`,
        [TENANT, AGENT, conversaId],
      );
      inboundId = m.rows[0]!.id;
      const t = await c.query<{ id: string }>(
        `INSERT INTO agent_turns
           (tenant_id, agent_id, representative_message_id, conversa_id, status,
            attempt_count, state_version, stream_key, stream_key_version)
         VALUES ($1, $2, $3, $4, 'running', 1, 1, $5, 1) RETURNING id`,
        [TENANT, AGENT, inboundId, conversaId, streamKey],
      );
      turnId = t.rows[0]!.id;
      // `engine_runs.control_id` é NOT NULL com FK para `conversation_controls`
      // (140). Sem esta linha nenhum run existe — é a mesma dependência que
      // impede o pin de ser escrito em produção hoje.
      const ctrl = await c.query<{ id: string }>(
        `INSERT INTO conversation_controls
           (tenant_id, agent_id, stream_key, stream_key_version, channel_id, conversa_id,
            mode, control_epoch)
         VALUES ($1, $2, $3, 1, $4, $5, 'bot', 0) RETURNING id`,
        [TENANT, AGENT, streamKey, canal.rows[0]!.id, conversaId],
      );
      controlId = ctrl.rows[0]!.id;
    } finally {
      c.release();
    }
  });

  it('1. sem binding: `no_binding`, e a rota manda rodar o pipeline', async () => {
    const estado = await comoEscopo(() => engineRunsRepo.findTurnEngineState({ turn_id: turnId }));
    expect(estado.kind).toBe('no_binding');
    expect(routeExistingEngineRun(estado)).toEqual({ kind: 'run_pipeline' });
  });

  it('2. run `running`: `open_run`, e a rota RECUSA reexecutar', async () => {
    await criarBinding();
    await criarRun('running');
    const estado = await comoEscopo(() => engineRunsRepo.findTurnEngineState({ turn_id: turnId }));
    expect(estado.kind).toBe('open_run');
    const rota = routeExistingEngineRun(estado);
    expect(rota.kind).toBe('reconcile_run');
  });

  it('3. run `blocked`: `open_run` — o caso que a lista errada escondia', async () => {
    // Antes do conserto isto respondia `binding_without_open_run`, a rota
    // devolvia `run_pipeline`, e o turno reexecutava tudo até morrer no
    // prepare. O ramo `await_operator` era inalcançável por aqui.
    await criarBinding();
    await criarRun('blocked');
    const estado = await comoEscopo(() => engineRunsRepo.findTurnEngineState({ turn_id: turnId }));
    expect(estado.kind).toBe('open_run');
    expect(estado.kind === 'open_run' && estado.run.phase).toBe('blocked');
    expect(routeExistingEngineRun(estado)).toMatchObject({
      kind: 'await_operator',
      reason: 'blocked',
    });
  });

  it('4. CONTRA-PROVA: run `closed` volta a ser `binding_without_open_run`', async () => {
    // Sem este caso, trocar o filtro por "qualquer fase" passaria nos três
    // anteriores e quebraria a retomada normal: um turno cujo run já fechou
    // nunca mais rodaria o pipeline.
    await criarBinding();
    await criarRun('closed');
    const estado = await comoEscopo(() => engineRunsRepo.findTurnEngineState({ turn_id: turnId }));
    expect(estado.kind).toBe('binding_without_open_run');
    expect(routeExistingEngineRun(estado)).toEqual({ kind: 'run_pipeline' });
  });
});
