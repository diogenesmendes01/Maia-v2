/**
 * SC02 — LOADER DURÁVEL DE request/context/manifest NO FLUXO REAL.
 *
 * Spec: `/srv/agents/shared/specs/maia-hermes/84c426077345-SPEC-IMPLEMENTACAO-MAIA-HERMES.md`
 * §4.1 (contratos integrados), §5.1.1/§5.1.2/§5.1.4, §5.3/§5.3.1/§5.3.4,
 * §5.6.1/§5.6.2/§5.6.3/§5.6.4, §5.10.3 (linha de imutabilidade) e §11.2
 * (T05/T07/T08/T09).
 *
 * ─── O que este arquivo prova, e o que ele NÃO substitui ────────────────────
 *
 * O caminho REAL exercitado aqui é o de PRODUÇÃO de um run: admissão
 * (`prepareSyntheticHermesAdmission`) → journal durável
 * (`engine_runs`/`engine_turn_bindings`/`hermes_runtime_manifests`) → loader
 * (`loadHermesLaunchContext`) → `startPrepared` (CAS de submissão + aceite
 * observado). NADA disso é dublê:
 *
 *   - Postgres REAL (fixtures próprias, escopo próprio);
 *   - repositórios e runtime REAIS (`src/db/repositories/*`,
 *     `src/runtime/engines/hermes-runtime.ts`);
 *   - normalizador e parser REAIS (`src/integrations/hermes/history.ts`,
 *     `manifest.ts`), schemas estritos REAIS (`src/runtime/engines/schemas.ts`).
 *
 * Dublês, e só onde a spec permite: o MOTOR remoto (o `AgentEnginePortV1` é a
 * fronteira de transporte — nenhum processo Python é spawnado aqui) e o canal.
 * Nenhum deles substitui o que está sob prova: o que se mede é o que a Maia
 * PERSISTE e RELÊ antes/depois de qualquer I/O.
 *
 * Skipped sem `TEST_DB_URL` (não reporte "0 falhas" de uma rodada sem banco:
 * aqui as specs vão para `skipped`).
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  CanonicalJsonError,
  canonicalDigest,
  canonicalJsonStringify,
} from '@/integrations/hermes/canonical-json.js';
import { engineRunsRepo } from '@/db/repositories/engine-repos.js';
import { ensureHermesConversationControl } from '@/db/repositories/hermes-control-producer.js';
import { loadHermesLaunchContext } from '@/db/repositories/hermes-launch-repo.js';
import { persistSyntheticHermesManifest } from '@/db/repositories/hermes-manifest-repo.js';
import { parseRuntimeManifest } from '@/integrations/hermes/manifest.js';
import { createJournaledHermesRuntime } from '@/runtime/engines/hermes-runtime.js';
import { HERMES_ENGINE_ADAPTER_REVISION } from '@/runtime/engines/hermes-engine.js';
import {
  enginePinV1Schema,
  engineRequestV1Schema,
  hostContextSnapshotV1Schema,
} from '@/runtime/engines/schemas.js';
import { runWithTurnExecution } from '@/runtime/turns/execution-context.js';
import type {
  HermesSupervisorConfigV1,
  HermesSupervisorV1,
  WorkerLaunchSpecV1,
} from '@/integrations/hermes/supervisor.js';
import type { TurnExecutionContext } from '@/runtime/turns/claim.js';
import type { SyntheticCoreRuntime } from '@/runtime/engines/synthetic-core-context.js';
import type { RuntimeManifestV1 } from '@/integrations/hermes/manifest.js';

vi.hoisted(() => {
  for (const [k, v] of Object.entries({
    FEATURE_TURN_STATE_MACHINE: 'true',
    FEATURE_TURN_CLAIM: 'true',
    FEATURE_OUTBOUND_DURABLE_COMMIT: 'true',
  })) {
    process.env[k] = v;
  }
});

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const RUN_ID = randomUUID().slice(0, 8);
const T = `sc02-tenant-${RUN_ID}`;
const A = `sc02-agent-${RUN_ID}`;

const HERMES_SHA = process.env.HERMES_PIN_SHA ?? 'a'.repeat(40);
const ADAPTER_REVISION = 'sc02-adapter-1';
const ADAPTER_DIGEST = canonicalDigest({ adapter: ADAPTER_REVISION, evidence_class: 'synthetic' });
const REMOTE_INSTANCE = 'sc02-remote-instance';

/**
 * O MOTOR é o dublê de transporte. Ele NÃO decide nada do que está sob prova:
 * a admissão, o journal, o loader e o CAS de submissão são os reais. O
 * `start` só precisa devolver um aceite observável.
 */
function fakeRuntime(over: { startImpl?: () => Promise<unknown> } = {}): SyntheticCoreRuntime {
  const started: string[] = [];
  const pin = {
    engine: 'hermes' as const,
    adapter_revision: ADAPTER_REVISION,
    configuration_digest: ADAPTER_DIGEST,
    protocol_version: 1 as const,
  };
  return {
    pin,
    hermesSha: HERMES_SHA,
    remoteInstanceId: REMOTE_INSTANCE,
    shutdown: async () => {},
    engine: {
      pin,
      remoteInstanceId: REMOTE_INSTANCE,
      start: async (request: { run_id: string }) => {
        started.push(request.run_id);
        if (over.startImpl) return over.startImpl();
        return { kind: 'accepted', remote_run_id: `remote-${started.length}` };
      },
      observe: async () => ({ kind: 'unavailable', code: 'unsupported' }),
      cancel: async () => ({ kind: 'unsupported' }),
    },
    started,
  } as unknown as SyntheticCoreRuntime & { started: string[] };
}

type Fixture = {
  turn_id: string;
  claim_token: string;
  message_id: string;
  control_stream_key: string;
  channel_id: string;
  conversa_id: string;
  pessoa_id: string;
  execution: TurnExecutionContext;
};

let pool: pg.Pool;

const scoped = <R>(fn: () => Promise<R>): Promise<R> =>
  runWithTenantContext({ tenant_id: T, agent_id: A }, fn);

async function criarIdentidades(): Promise<void> {
  await pool.query(`INSERT INTO tenants(id,nome) VALUES($1,$1) ON CONFLICT DO NOTHING`, [T]);
  await pool.query(
    `INSERT INTO agents(id,tenant_id,nome) VALUES($1,$2,$1) ON CONFLICT DO NOTHING`,
    [A, T],
  );
}

/**
 * Turno REAL de fixture: inbound persistido, identidade (pessoa/conversa/
 * canal) e stream v1, canário `synthetic` e política `hermes` no canal. O turno
 * nasce `queued`, attempt 0, sem claim/run/binding/control — exatamente a
 * premissa que o AC01 nomeia — e SÓ ENTÃO é reivindicado, como o claim real
 * faz.
 */
async function criarTurno(input: {
  /** Linhas de histórico (ordem cronológica), inseridas ANTES da atual. */
  historico?: Array<{ direcao: 'in' | 'out'; tipo?: string; conteudo: string | null }>;
  /** Conteúdo da mensagem ATUAL (a representativa do turno). */
  atual?: string;
  /** Tipo da mensagem atual (multimodal recusa antes do LLM). */
  atualTipo?: string;
  turnosExistentes?: number;
}): Promise<Fixture> {
  const channel_id = randomUUID();
  const pessoa_id = randomUUID();
  const conversa_id = randomUUID();
  const message_id = randomUUID();
  const turn_id = randomUUID();
  const claim_token = randomUUID();
  const stream_key = `v1:${canonicalDigest({ fixture: turn_id })}`;

  await pool.query(
    `INSERT INTO channels(id,tenant_id,agent_id,channel_type,external_id,display_name,active,is_synthetic)
     VALUES($1,$2,$3,'whatsapp',$4,'SC02',$5,true)`,
    [channel_id, T, A, channel_id.slice(0, 8), false],
  );
  await pool.query(
    `INSERT INTO pessoas(id,tenant_id,agent_id,nome,telefone_whatsapp,tipo,status)
     VALUES($1,$2,$3,'SC02',$4,'dono','ativa')`,
    [pessoa_id, T, A, `+55${BigInt(`0x${pessoa_id.replace(/-/g, '')}`).toString().slice(-11)}`],
  );
  await pool.query(
    `INSERT INTO conversas(id,tenant_id,agent_id,pessoa_id,channel_id,status)
     VALUES($1,$2,$3,$4,$5,'ativa')`,
    [conversa_id, T, A, pessoa_id, channel_id],
  );

  // Histórico: criado_at EXPLÍCITO para que a ordem seja um dado, não um
  // acidente do relógio da rodada.
  let offset = (input.historico?.length ?? 0) + 2;
  for (const h of input.historico ?? []) {
    await pool.query(
      `INSERT INTO mensagens(id,tenant_id,agent_id,conversa_id,channel_id,direcao,tipo,conteudo,metadata,created_at,stream_key,stream_key_version,ingress_seq)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb, now() - ($9 || ' minutes')::interval, $10, 1, $11)`,
      [
        randomUUID(),
        T,
        A,
        conversa_id,
        channel_id,
        h.direcao,
        h.tipo ?? 'texto',
        h.conteudo,
        String(offset),
        stream_key,
        offset,
      ],
    );
    offset -= 1;
  }

  await pool.query(
    `INSERT INTO mensagens(id,tenant_id,agent_id,conversa_id,channel_id,direcao,tipo,conteudo,metadata,created_at,stream_key,stream_key_version,ingress_seq)
     VALUES($1,$2,$3,$4,$5,'in',$6,$7,'{}'::jsonb, now() - interval '1 minute', $8, 1, 1)`,
    [message_id, T, A, conversa_id, channel_id, input.atualTipo ?? 'texto', input.atual ?? 'oi', stream_key],
  );
  await pool.query(
    `UPDATE mensagens SET metadata=jsonb_build_object('remote_jid','sc02@invalid') WHERE id=$1`,
    [message_id],
  );

  await pool.query(
    `INSERT INTO agent_turns(id,tenant_id,agent_id,representative_message_id,status,claim_token,attempt_count,claimed_by,lease_expires_at,conversa_id,channel_id,stream_key,stream_key_version)
     VALUES($1,$2,$3,$4,'queued',NULL,0,NULL,NULL,$5,$6,$7,1)`,
    [turn_id, T, A, message_id, conversa_id, channel_id, stream_key],
  );
  await pool.query(
    `INSERT INTO agent_turn_inputs(tenant_id,agent_id,turn_id,mensagem_id) VALUES($1,$2,$3,$4)`,
    [T, A, turn_id, message_id],
  );
  await pool.query(
    `INSERT INTO agent_canary_policy(tenant_id,agent_id,stage,updated_by)
     VALUES($1,$2,'synthetic','sc02-fixture')
     ON CONFLICT(tenant_id,agent_id) DO UPDATE SET stage='synthetic'`,
    [T, A],
  );
  await pool.query(
    `INSERT INTO agent_engine_policies(tenant_id,agent_id,channel_id,engine,updated_by)
     VALUES($1,$2,$3,'hermes','sc02-fixture')`,
    [T, A, channel_id],
  );

  return {
    turn_id,
    claim_token,
    message_id,
    control_stream_key: stream_key,
    channel_id,
    conversa_id,
    pessoa_id,
    execution: {
      tenant_id: T,
      agent_id: A,
      turn_id,
      attempt: 1,
      claim_token,
      worker_id: 'sc02-worker',
      deadline: new Date(Date.now() + 60_000),
      signal: new AbortController().signal,
    },
  };
}

/** O claim real, aplicado ao turno `queued`: posse com lease viva. */
async function reivindicar(f: Fixture): Promise<TurnExecutionContext> {
  await pool.query(
    `UPDATE agent_turns SET status='running', claim_token=$2, attempt_count=$3,
       claimed_by=$4, lease_expires_at=now() + interval '10 minutes' WHERE id=$1`,
    [f.turn_id, f.claim_token, f.execution.attempt, f.execution.worker_id],
  );
  return f.execution;
}

async function admitir(f: Fixture, runtime = fakeRuntime()): Promise<string | null> {
  const { prepareSyntheticHermesAdmission } = await import(
    '@/db/repositories/hermes-admission-repo.js'
  );
  return scoped(() =>
    prepareSyntheticHermesAdmission({
      message_id: f.message_id,
      execution: f.execution,
      runtime,
    }),
  );
}

type RunRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  turn_id: string;
  generation_no: number;
  origin_turn_attempt: number;
  origin_claim_token: string;
  origin_worker_id: string;
  control_id: string;
  control_epoch: string;
  mode: string;
  manifest_digest: string;
  phase: string;
  row_version: string;
  request_key: string;
  remote_instance_id: string;
  remote_run_id: string | null;
  request_json: { run_id: string; request_key: string; context: { messages: unknown[]; system: string } };
  request_hash: string;
  host_context_json: { control_epoch: string; representative_message_id: string };
  host_context_hash: string;
  submit_count: number;
  last_event_sequence: string;
  capabilities_revoked_at: string | null;
};

async function lerRun(run_id: string): Promise<RunRow> {
  const r = await pool.query<RunRow>(
    `SELECT * FROM engine_runs WHERE tenant_id=$1 AND agent_id=$2 AND id=$3`,
    [T, A, run_id],
  );
  expect(r.rowCount, 'run do ACEITE tem de existir').toBe(1);
  return r.rows[0]!;
}

async function contar(sql: string, params: unknown[]): Promise<number> {
  const r = await pool.query<{ n: string }>(sql, params);
  return Number(r.rows[0]!.n);
}

d('SC02 — loader durável de request/context/manifest no fluxo real', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 2 });
    await criarIdentidades();
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  /**
   * AC01 · T09 — turno `queued`, attempt zero, SEM run/control/binding.
   *
   * A admissão é a única porta que CRIA o controle de conversa confiável
   * (§8.2.1: `conversation_controls` nasce com identidade de stream resolvida
   * do banco) e que persiste request/context/manifest ANTES de qualquer I/O do
   * motor. A prova é o estado PERSISTIDO, não o valor de retorno:
   *
   *   - zero `engine_runs`/`engine_turn_bindings` ANTES (a premissa do card);
   *   - exatamente UM controle, `mode='bot'`, epoch 0, com a identidade real;
   *   - run em `prepared` com `request_key`/`request_json.run_id` coerentes com
   *     a própria linha, `generation_no=1`, `origin_turn_attempt=1`;
   *   - binding `hermes` com a revisão/digest do runtime;
   *   - manifest persistido com `digest = run.manifest_digest`;
   *   - ZERO tentativa de inferência: nada foi submetido.
   */
  it('AC01/T09 — admissão de turno queued cria controle confiável e persiste request/context/manifest antes do start', async () => {
    const f = await criarTurno({ atual: 'oi' });

    // Premissa do AC: nada durável existe ainda.
    expect(await contar(`SELECT count(*)::text AS n FROM engine_runs WHERE turn_id=$1`, [f.turn_id])).toBe(0);
    expect(
      await contar(`SELECT count(*)::text AS n FROM engine_turn_bindings WHERE turn_id=$1`, [f.turn_id]),
    ).toBe(0);
    expect(
      await contar(`SELECT count(*)::text AS n FROM conversation_controls WHERE stream_key=$1`, [
        f.control_stream_key,
      ]),
    ).toBe(0);

    const execution = await reivindicar(f);
    const run_id = await admitir(f);
    expect(run_id, 'a admissão tem de devolver o run_id do run preparado').toMatch(
      /^[0-9a-f-]{36}$/,
    );

    const run = await lerRun(run_id!);
    expect(run.phase).toBe('prepared');
    expect(run.mode).toBe('live');
    expect(run.generation_no).toBe(1);
    expect(run.origin_turn_attempt).toBe(execution.attempt);
    expect(run.origin_claim_token).toBe(execution.claim_token);
    expect(run.origin_worker_id).toBe(execution.worker_id);
    expect(run.request_json.run_id).toBe(run.id);
    expect(run.request_json.request_key).toBe(run.request_key);
    expect(run.request_hash).toBe(canonicalDigest(run.request_json));
    expect(run.host_context_hash).toBe(canonicalDigest(run.host_context_json));
    expect(run.host_context_json.representative_message_id).toBe(f.message_id);
    expect(run.remote_run_id, 'nada foi submetido ainda').toBeNull();
    expect(run.submit_count).toBe(0);
    expect(run.capabilities_revoked_at).toBeNull();

    const controle = await pool.query<{ id: string; mode: string; control_epoch: string }>(
      `SELECT id, mode, control_epoch::text FROM conversation_controls
        WHERE tenant_id=$1 AND agent_id=$2 AND stream_key=$3`,
      [T, A, f.control_stream_key],
    );
    expect(controle.rowCount).toBe(1);
    expect(controle.rows[0]!.mode).toBe('bot');
    expect(controle.rows[0]!.control_epoch).toBe('0');
    expect(run.control_id).toBe(controle.rows[0]!.id);
    expect(run.control_epoch).toBe(controle.rows[0]!.control_epoch);
    expect(run.host_context_json.control_epoch).toBe(controle.rows[0]!.control_epoch);

    const binding = await pool.query<{
      engine: string;
      adapter_revision: string;
      configuration_digest: string;
      protocol_version: number;
      max_generations: number;
    }>(`SELECT engine, adapter_revision, configuration_digest, protocol_version, max_generations
          FROM engine_turn_bindings WHERE tenant_id=$1 AND agent_id=$2 AND turn_id=$3`, [
      T,
      A,
      f.turn_id,
    ]);
    expect(binding.rowCount).toBe(1);
    expect(binding.rows[0]).toMatchObject({
      engine: 'hermes',
      adapter_revision: ADAPTER_REVISION,
      configuration_digest: ADAPTER_DIGEST,
      protocol_version: 1,
    });

    const manifest = await pool.query<{ digest: string; manifest_json: RuntimeManifestV1 }>(
      `SELECT digest, manifest_json FROM hermes_runtime_manifests
        WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3`,
      [T, A, run.id],
    );
    expect(manifest.rowCount).toBe(1);
    expect(manifest.rows[0]!.digest).toBe(run.manifest_digest);
    expect(canonicalDigest(manifest.rows[0]!.manifest_json)).toBe(run.manifest_digest);
    expect(manifest.rows[0]!.manifest_json.run_id).toBe(run.id);
    expect(manifest.rows[0]!.manifest_json.context_digest).toBe(
      canonicalDigest(run.request_json.context),
    );
    expect(manifest.rows[0]!.manifest_json.runtime_pin.hermes_sha).toBe(HERMES_SHA);

    // Nada de inferência: o start não aconteceu.
    expect(
      await contar(`SELECT count(*)::text AS n FROM engine_inference_attempts WHERE run_id=$1`, [
        run.id,
      ]),
    ).toBe(0);
    expect(
      await contar(`SELECT count(*)::text AS n FROM outbound_messages WHERE turn_id=$1`, [f.turn_id]),
    ).toBe(0);
  }, 60_000);

  /**
   * AC03 · §4.1 "Compatibilidade de contexto" — o histórico é REAL, vem das
   * LINHAS PERSISTIDAS, preserva ordem e remove a mensagem atual por ID.
   *
   * O caso que separa "por ID" de "por texto": duas mensagens de cliente com o
   * MESMO texto e IDs diferentes. A heurística por texto removeria a errada (ou
   * as duas). Aqui a única excluída é a representativa do turno — a outra
   * permanece no histórico, na posição dela.
   */
  it('AC03 — histórico durável preserva ordem e exclui a mensagem atual por ID, não por texto', async () => {
    const f = await criarTurno({
      historico: [
        { direcao: 'in', conteudo: 'oi' },
        { direcao: 'out', conteudo: 'olá, como posso ajudar?' },
        { direcao: 'in', conteudo: 'oi' },
      ],
      atual: 'oi',
    });
    await reivindicar(f);
    const run_id = await admitir(f);
    expect(run_id).not.toBeNull();

    const run = await lerRun(run_id!);
    const messages = run.request_json.context.messages as Array<{ role: string; content: string }>;

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(messages.map((m) => m.content)).toEqual(['oi', 'olá, como posso ajudar?', 'oi', 'oi']);
    // Duas ocorrências do MESMO texto continuam distintas: nada foi deduplicado
    // por conteúdo, e a atual entrou UMA vez.
    expect(messages.filter((m) => m.content === 'oi')).toHaveLength(3);
  }, 60_000);

  /**
   * AC03 · §4.1 — multimodal NÃO suportado RECUSA antes do LLM.
   *
   * Uma linha de histórico de áudio/imagem/documento não é "ignorada": o
   * contexto do piloto é textual, e projetar só o texto extraído de uma mídia
   * que ninguém autorizou seria inventar continuidade. A admissão recusa e
   * nenhum run/binding/manifest é persistido.
   */
  it('AC03 — histórico com mídia recusa a admissão inteira (multimodal fora do piloto)', async () => {
    const f = await criarTurno({
      historico: [
        { direcao: 'in', conteudo: 'segue o comprovante' },
        { direcao: 'in', tipo: 'imagem', conteudo: null },
      ],
      atual: 'ok',
    });
    await reivindicar(f);
    const run_id = await admitir(f);
    expect(run_id, 'mídia não suportada não pode virar contexto textual').toBeNull();
    expect(await contar(`SELECT count(*)::text AS n FROM engine_runs WHERE turn_id=$1`, [f.turn_id])).toBe(0);
    expect(
      await contar(`SELECT count(*)::text AS n FROM engine_turn_bindings WHERE turn_id=$1`, [f.turn_id]),
    ).toBe(0);
  }, 60_000);

  /**
   * AC02 · SPEC-L1401 — snapshot é CÓPIA JSON validada; request/pin imutáveis.
   *
   * Três asserções, e cada uma fecha um caminho diferente:
   *  1. o que está no banco é JSON PURO (round-trip idêntico) e não carrega
   *     `signal`, função nem segredo;
   *  2. um `UPDATE` DIRETO (o caminho do psql, onde ninguém lê o repositório)
   *     de `request_json`/`request_key` é recusado pelo BANCO;
   *  3. um `UPDATE` direto do PIN (`engine_turn_bindings.engine`) também é
   *     recusado — o pin é imutável (§5.7.1), não "não atualizado pelo código".
   */
  it('AC02/SPEC-L1401 — snapshot é cópia JSON validada e UPDATE direto de request/pin é recusado', async () => {
    const f = await criarTurno({ atual: 'oi' });
    await reivindicar(f);
    const run_id = (await admitir(f))!;
    const run = await lerRun(run_id);

    // (1) cópia JSON validada: o round-trip não perde nem inventa nada.
    expect(JSON.parse(JSON.stringify(run.request_json))).toEqual(run.request_json);
    expect(JSON.parse(JSON.stringify(run.host_context_json))).toEqual(run.host_context_json);
    const texto = JSON.stringify(run.request_json) + JSON.stringify(run.host_context_json);
    for (const proibido of ['signal', 'invokeTool', 'api_key', 'credential', 'Bearer ']) {
      expect(texto, `snapshot não pode carregar ${proibido}`).not.toContain(proibido);
    }

    // (2) request imutável no BANCO.
    await expect(
      pool.query(`UPDATE engine_runs SET request_json = request_json || '{"x":1}'::jsonb WHERE id=$1`, [
        run.id,
      ]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      pool.query(`UPDATE engine_runs SET request_key = gen_random_uuid() WHERE id=$1`, [run.id]),
    ).rejects.toMatchObject({ code: '23001' });

    // (3) pin imutável no BANCO.
    await expect(
      pool.query(`UPDATE engine_turn_bindings SET engine='maia_react' WHERE turn_id=$1`, [f.turn_id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      pool.query(`UPDATE engine_turn_bindings SET adapter_revision='outra' WHERE turn_id=$1`, [
        f.turn_id,
      ]),
    ).rejects.toMatchObject({ code: '23001' });

    // Os bytes seguem os originais.
    const depois = await lerRun(run.id);
    expect(depois.request_json).toEqual(run.request_json);
    expect(depois.request_key).toBe(run.request_key);
    expect(depois.request_hash).toBe(run.request_hash);
    const b = await pool.query<{ engine: string; adapter_revision: string }>(
      `SELECT engine, adapter_revision FROM engine_turn_bindings WHERE turn_id=$1`,
      [f.turn_id],
    );
    expect(b.rows[0]).toMatchObject({ engine: 'hermes', adapter_revision: ADAPTER_REVISION });
  }, 60_000);

  /**
   * AC02 · T09 — REPLAY não cria segunda execução nem troca a chave.
   *
   * Um segundo chamador (mesmo turno, mesmo dono) não pode preparar um segundo
   * run: o journal já tem um run ABERTO para o turno, a `request_key` é a
   * mesma e o `request_json` continua byte a byte o original. "Mesmo
   * `execution_id`, payload diferente ⇒ conflito; nenhum segundo processo."
   */
  it('AC02/T09 — replay do mesmo turno não abre segundo run nem troca request/chave', async () => {
    const f = await criarTurno({ atual: 'primeiro' });
    await reivindicar(f);
    const primeiro = await admitir(f);
    expect(primeiro).not.toBeNull();
    const antes = await lerRun(primeiro!);

    const segundo = await admitir(f);
    expect(segundo, 'run aberto para o turno: nada de segunda execução').toBeNull();
    expect(
      await contar(`SELECT count(*)::text AS n FROM engine_runs WHERE turn_id=$1`, [f.turn_id]),
    ).toBe(1);

    const depois = await lerRun(primeiro!);
    expect(depois.request_key).toBe(antes.request_key);
    expect(depois.request_hash).toBe(antes.request_hash);
    expect(JSON.stringify(depois.request_json)).toBe(JSON.stringify(antes.request_json));
    expect(depois.generation_no).toBe(antes.generation_no);
  }, 60_000);

  /**
   * AC04 · T07 — limite de contexto RECUSA antes do LLM; não trunca.
   *
   * Um histórico acima do teto da V1 (§5.3.4) não pode ser persistido: se
   * entrasse, o motor receberia um contexto que alguém cortou em silêncio. A
   * recusa é determinística e não deixa run, binding nem manifest.
   */
  it('AC04/T07 — histórico acima do teto recusa a admissão inteira (nunca trunca)', async () => {
    const f = await criarTurno({
      historico: [{ direcao: 'in', conteudo: 'x'.repeat(300_000) }],
      atual: 'oi',
    });
    await reivindicar(f);
    const run_id = await admitir(f);
    expect(run_id, 'contexto acima do teto não pode virar request').toBeNull();
    expect(await contar(`SELECT count(*)::text AS n FROM engine_runs WHERE turn_id=$1`, [f.turn_id])).toBe(0);
    expect(
      await contar(`SELECT count(*)::text AS n FROM engine_turn_bindings WHERE turn_id=$1`, [f.turn_id]),
    ).toBe(0);
    expect(
      await contar(
        `SELECT count(*)::text AS n FROM engine_inference_attempts WHERE tenant_id=$1 AND agent_id=$2`,
        [T, A],
      ),
    ).toBe(0);
  }, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════
// Rodada 2 — o que a rodada 1 deixou SEM prova: AC05, AC09, AC10, AC11 e a
// matriz de constraints de AC07/AC08. O tier de dublê continua o MESMO: só o
// MOTOR remoto é fronteira de transporte (`launch`), nunca reimplementado.
// ════════════════════════════════════════════════════════════════════════════

/** Config do supervisor como DADO: nenhum processo é criado por este lane. */
const SUPERVISOR_CONFIG: HermesSupervisorConfigV1 = {
  python_executable: process.env.HERMES_PIN_PYTHON ?? '/bin/false',
  worker_args: ['-m', 'services.hermes_worker.main'],
  worker_cwd: process.cwd(),
  python_path: [],
  hermes_sha: HERMES_SHA,
  expected_bridge_revision: null,
  platform_env: {},
  home_root: '/tmp',
  ready_timeout_ms: 5_000,
  cancel_grace_ms: 0,
  exit_wait_ms: 1_000,
  post_result_exit_ms: 1_000,
  hook_timeout_ms: 5_000,
  watchdog_interval_ms: 60_000,
  session_retention_ms: 0,
};

type EngineDouble = {
  /** `startPrepared` REAL: o que é dublado é o transporte, não a decisão. */
  runtime: ReturnType<typeof createJournaledHermesRuntime>;
  launches: WorkerLaunchSpecV1[];
  admirable: SyntheticCoreRuntime;
};

/**
 * `createJournaledHermesRuntime` (REAL) com um supervisor que NÃO cria processo.
 *
 * `resolveRunContext`, o loader, o manifest RELIDO do PostgreSQL, o grant de
 * inferência e o CAS do journal continuam os reais — é justamente o caminho
 * que o AC10 nomeia. O que o dublê substitui é a fronteira de transporte: o
 * `launch` que, em produção, faria o `spawn` do worker.
 */
function engineDouble(
  over: {
    outcome?: 'accepted' | 'spawn_failed';
    onLaunch?: (spec: WorkerLaunchSpecV1) => Promise<void>;
  } = {},
): EngineDouble {
  const launches: WorkerLaunchSpecV1[] = [];
  const incarnation = randomUUID();
  const supervisor = {
    incarnation,
    config: SUPERVISOR_CONFIG,
    async launch(spec: WorkerLaunchSpecV1) {
      launches.push(spec);
      if (over.onLaunch) await over.onLaunch(spec);
      if (over.outcome === 'spawn_failed') {
        return { kind: 'refused' as const, reason: 'spawn_failed' as const };
      }
      const worker_instance_id = randomUUID();
      return {
        kind: 'launched' as const,
        session: {
          run_id: spec.start.run_id,
          worker_instance_id,
          ready: Promise.resolve({ kind: 'accepted' as const }),
          exited: new Promise<never>(() => {}),
          released: new Promise<void>(() => {}),
          cancellation: null,
          snapshot: () => ({}) as never,
          requestCancel: async () => 'already_exited' as const,
        },
      };
    },
    get: () => undefined,
    shutdown: async () => {},
    activeCount: () => 0,
  } as unknown as HermesSupervisorV1;
  const runtime = createJournaledHermesRuntime({
    supervisor,
    inference: {
      base_url: 'http://127.0.0.1:9/internal/hermes-inference/v1',
      model: 'sc02-stub-model',
      provider: 'openai',
    },
  });
  const admirable = {
    pin: runtime.pin,
    hermesSha: HERMES_SHA,
    remoteInstanceId: runtime.remoteInstanceId,
    shutdown: runtime.shutdown,
    engine: runtime.engine,
  } as unknown as SyntheticCoreRuntime;
  return { runtime, launches, admirable };
}

type ManualRun = {
  run_id: string;
  request_key: string;
  control_id: string;
  execution: TurnExecutionContext;
};

/**
 * Run escrito DIRETO no banco, sem passar pelo repositório.
 *
 * É o caminho do incidente no `psql` — aquele em que ninguém lê o código — e o
 * que o loader tem de recusar quando o conteúdo não fecha consigo mesmo.
 */
type ControlResult =
  | { kind: 'ok'; control_id: string; control_epoch: string }
  | { kind: 'refused' };

async function persistirRunManual(
  over: {
    request_json?: Record<string, unknown>;
    request_json_text?: string;
    request_hash?: string;
    host_context_json?: Record<string, unknown>;
    host_context_hash?: string;
    request_key?: string;
  } = {},
): Promise<ManualRun> {
  const f = await criarTurno({ atual: 'manual' });
  const execution = await reivindicar(f);
  const control: ControlResult = await scoped(() =>
    ensureHermesConversationControl({ turn_id: f.turn_id, claim_token: f.claim_token }),
  );
  if (control.kind !== 'ok') throw new Error('controle manual não criado');
  const ident = (
    await pool.query<{
      channel_id: string;
      stream_key: string;
      pessoa_id: string;
      conversa_id: string;
      control_epoch: string;
    }>(
      `SELECT channel_id, stream_key, pessoa_id, conversa_id, control_epoch::text
         FROM conversation_controls WHERE id=$1`,
      [control.control_id],
    )
  ).rows[0]!;

  const run_id = randomUUID();
  const request_key = over.request_key ?? randomUUID();
  const request_json = over.request_json ?? {
    version: 1,
    run_id,
    request_key,
    task: 'reasoner',
    isolation: 'one_run_no_shared_memory',
    context: { system: 'SC02 manual', messages: [{ role: 'user', content: 'manual' }], tools: [] },
    limits: {
      max_iterations: 5,
      max_output_tokens_per_call: 1024,
      max_tool_calls: 1,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      max_cost_microusd: '1000',
    },
  };
  const host_context_json = over.host_context_json ?? {
    version: 1,
    tenant_id: T,
    agent_id: A,
    turn_id: f.turn_id,
    pessoa_id: ident.pessoa_id,
    conversa_id: ident.conversa_id,
    channel_id: ident.channel_id,
    representative_message_id: f.message_id,
    input_message_ids: [f.message_id],
    stream_key: ident.stream_key,
    control_id: control.control_id,
    control_epoch: ident.control_epoch,
    remote_jid: 'sc02@invalid',
    trace_id: randomUUID(),
    active_role_id: null,
    active_execution_id: null,
    outbound_prefix: null,
    allowed_entity_ids: [],
    allowed_tool_names: [],
    policy_digest: canonicalDigest({ evidence_class: 'synthetic' }),
    source_versions: [],
  };
  await pool.query(
    `INSERT INTO engine_turn_bindings(tenant_id,agent_id,turn_id,engine,adapter_revision,configuration_digest,protocol_version,max_generations)
     VALUES($1,$2,$3,'hermes','manual-1',$4,1,1)`,
    [T, A, f.turn_id, ADAPTER_DIGEST],
  );
  await pool.query(
    `INSERT INTO engine_runs(id,tenant_id,agent_id,turn_id,generation_no,origin_turn_attempt,origin_claim_token,
       origin_worker_id,control_id,control_epoch,mode,manifest_digest,phase,row_version,request_key,remote_instance_id,
       request_json,request_hash,host_context_json,host_context_hash,deadline_at,reconcile_deadline_at,last_event_sequence)
     VALUES($1,$2,$3,$4,1,1,$5,$6,$7,$8::bigint,'live',$9,'prepared',0,$10,'manual-instance',
       $11::jsonb,$12,$13::jsonb,$14, now() + interval '5 minutes', now() + interval '6 minutes', 0)`,
    [
      run_id,
      T,
      A,
      f.turn_id,
      f.claim_token,
      execution.worker_id,
      control.control_id,
      ident.control_epoch,
      canonicalDigest({ manual: true }),
      request_key,
      over.request_json_text ?? JSON.stringify(request_json),
      over.request_hash ??
        (over.request_json_text ? 'a'.repeat(64) : canonicalDigest(request_json)),
      JSON.stringify(host_context_json),
      over.host_context_hash ?? canonicalDigest(host_context_json),
    ],
  );
  return { run_id, request_key, control_id: control.control_id, execution };
}

/** O `request` canônico do contrato, para os testes de schema. */
function requestV1(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    run_id: randomUUID(),
    request_key: randomUUID(),
    task: 'reasoner',
    isolation: 'one_run_no_shared_memory',
    context: { system: 'SC02', messages: [{ role: 'user', content: 'oi' }], tools: [] },
    limits: {
      max_iterations: 5,
      max_output_tokens_per_call: 1024,
      max_tool_calls: 1,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      max_cost_microusd: '1000',
    },
    ...over,
  };
}

/** O `host` canônico do contrato, para os testes de schema. */
function hostV1(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    tenant_id: 't',
    agent_id: 'a',
    turn_id: randomUUID(),
    pessoa_id: randomUUID(),
    conversa_id: randomUUID(),
    channel_id: randomUUID(),
    representative_message_id: randomUUID(),
    input_message_ids: [randomUUID()],
    stream_key: 'v1:abc',
    control_id: randomUUID(),
    control_epoch: '0',
    remote_jid: 'sc02@invalid',
    trace_id: 'trace',
    active_role_id: null,
    active_execution_id: null,
    outbound_prefix: null,
    allowed_entity_ids: [],
    allowed_tool_names: [],
    policy_digest: 'a'.repeat(64),
    source_versions: [],
    ...over,
  };
}

d('SC02 rodada 2 — loader fail-closed, ledger e start com CAS (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await criarIdentidades();
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  /**
   * AC05 — o loader FALHA FECHADO.
   *
   * A pergunta não é "o caminho feliz carrega": é "o que o loader devolve
   * quando UMA das identidades do vínculo não é a do chamador". Cada caso
   * abaixo muda exatamente uma dimensão do vínculo e exige `null` — nunca o
   * contexto da linha, nunca um sujeito `owner`, nunca um escopo `default`.
   */
  it('AC05 — loader recusa outro claim, outro sujeito, outro canal, outro escopo e lookup ausente', async () => {
    const f = await criarTurno({ atual: 'oi' });
    await reivindicar(f);
    const run_id = (await admitir(f))!;
    expect(run_id).not.toBeNull();
    const run = await lerRun(run_id);
    const controleId = (
      await pool.query<{ id: string }>(
        `SELECT id FROM conversation_controls WHERE tenant_id=$1 AND agent_id=$2 AND stream_key=$3`,
        [T, A, f.control_stream_key],
      )
    ).rows[0]!.id;

    // PREMISSA: o vínculo REAL carrega para o dono de origem.
    expect(await scoped(() => loadHermesLaunchContext(run.id, f.execution))).not.toBeNull();

    const outro = await criarTurno({ atual: 'outro' });
    await reivindicar(outro);

    // (1) claim de OUTRO turno contra este run.
    expect(
      await scoped(() =>
        loadHermesLaunchContext(run.id, {
          ...f.execution,
          claim_token: outro.execution.claim_token,
        }),
      ),
    ).toBeNull();
    // (2) turno de OUTRO sujeito.
    expect(await scoped(() => loadHermesLaunchContext(run.id, outro.execution))).toBeNull();
    // (3) worker e (4) tentativa divergentes.
    expect(
      await scoped(() =>
        loadHermesLaunchContext(run.id, { ...f.execution, worker_id: 'worker-de-outro' }),
      ),
    ).toBeNull();
    expect(
      await scoped(() =>
        loadHermesLaunchContext(run.id, { ...f.execution, attempt: f.execution.attempt + 1 }),
      ),
    ).toBeNull();
    // (5) ALS de outro tenant e (6) de outro agente.
    expect(
      await runWithTenantContext({ tenant_id: `${T}-outro`, agent_id: A }, () =>
        loadHermesLaunchContext(run.id, f.execution),
      ),
    ).toBeNull();
    expect(
      await runWithTenantContext({ tenant_id: T, agent_id: `${A}-outro` }, () =>
        loadHermesLaunchContext(run.id, f.execution),
      ),
    ).toBeNull();
    // (7) posse abortada.
    const abort = new AbortController();
    abort.abort();
    expect(
      await scoped(() =>
        loadHermesLaunchContext(run.id, { ...f.execution, signal: abort.signal }),
      ),
    ).toBeNull();
    // (8) LOOKUP AUSENTE: não cai para owner nem para default.
    expect(await scoped(() => loadHermesLaunchContext(randomUUID(), f.execution))).toBeNull();
    // (9) controle tomado (modo humano, com dono nomeado — owner_chk da 140).
    await pool.query(
      `UPDATE conversation_controls SET mode='human', owner_app_user_id='sc02-operador', paused_at=now() WHERE id=$1`,
      [controleId],
    );
    expect(await scoped(() => loadHermesLaunchContext(run.id, f.execution))).toBeNull();
    await pool.query(`UPDATE conversation_controls SET mode='bot' WHERE id=$1`, [controleId]);
    expect(await scoped(() => loadHermesLaunchContext(run.id, f.execution))).not.toBeNull();

    // (10) outro CANAL: o vínculo do controle deixa de casar com a conversa.
    const fCanal = await criarTurno({ atual: 'canal' });
    await reivindicar(fCanal);
    const runCanal = (await admitir(fCanal))!;
    const outroCanal = await criarTurno({ atual: 'outro canal' });
    await pool.query(`UPDATE conversas SET channel_id=$2 WHERE id=$1`, [
      fCanal.conversa_id,
      outroCanal.channel_id,
    ]);
    expect(await scoped(() => loadHermesLaunchContext(runCanal, fCanal.execution))).toBeNull();

    // (11) outro SUJEITO na conversa do vínculo.
    const fPessoa = await criarTurno({ atual: 'sujeito' });
    await reivindicar(fPessoa);
    const runPessoa = (await admitir(fPessoa))!;
    await pool.query(`UPDATE conversas SET pessoa_id=$2 WHERE id=$1`, [
      fPessoa.conversa_id,
      outro.pessoa_id,
    ]);
    expect(await scoped(() => loadHermesLaunchContext(runPessoa, fPessoa.execution))).toBeNull();
  }, 120_000);

  /**
   * AC05/T09 — o loader RECOMPUTA o digest; não confia na linha.
   *
   * Uma linha cujo `request_hash`/`host_context_hash` não corresponde ao JSON
   * persistido é uma linha que mente sobre a própria identidade. Aceitá-la por
   * "o hash está no formato certo" transformaria o digest em enfeite.
   */
  it('AC05/T09 — o loader recusa a linha cujo hash não corresponde ao JSON persistido', async () => {
    const ok = await persistirRunManual();
    expect(await scoped(() => loadHermesLaunchContext(ok.run_id, ok.execution))).not.toBeNull();

    const requestAdulterado = await persistirRunManual({
      request_hash: canonicalDigest({ nao: 'e o request' }),
    });
    expect(
      await scoped(() => loadHermesLaunchContext(requestAdulterado.run_id, requestAdulterado.execution)),
    ).toBeNull();

    const hostAdulterado = await persistirRunManual({
      host_context_hash: canonicalDigest({ nao: 'e o host' }),
    });
    expect(
      await scoped(() => loadHermesLaunchContext(hostAdulterado.run_id, hostAdulterado.execution)),
    ).toBeNull();
  }, 120_000);
});

d('SC02 rodada 2 — matriz de constraints, ledger e CAS do start (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await criarIdentidades();
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  /**
   * AC07/AC08 — a matriz de constraints do §5.6.1/§5.6.2, medida contra o
   * BANCO (não contra o repositório): é o `psql` do incidente que estas
   * constraints existem para parar.
   *
   * `23001` = `restrict_violation` (trigger de imutabilidade/append-only).
   * `23514` = `check_violation`. `23503` = `foreign_key_violation`.
   * `23505` = `unique_violation`.
   */
  it('AC08 — identidades distintas e imutáveis, fase/terminal/tamanho e FK de escopo', async () => {
    const f = await criarTurno({ atual: 'constraints' });
    await reivindicar(f);
    const run_id = (await admitir(f))!;
    const antes = await lerRun(run_id);

    // (1) IDENTIDADES: turn/attempt/token/worker/generation/request/pin.
    const imutaveis: Array<[string, string]> = [
      ['generation_no', '2'],
      ['origin_turn_attempt', '9'],
      ['origin_claim_token', `'${randomUUID()}'`],
      ['remote_instance_id', "'outra-instancia'"],
      ['manifest_digest', `'${'b'.repeat(64)}'`],
      ['mode', "'shadow'"],
      ['control_id', `'${randomUUID()}'`],
      ['request_json', `'{"x":1}'::jsonb`],
      ['request_key', `'${randomUUID()}'`],
      ['host_context_json', `'{"x":1}'::jsonb`],
    ];
    for (const [coluna, valor] of imutaveis) {
      await expect(
        pool.query(`UPDATE engine_runs SET ${coluna}=${valor} WHERE id=$1`, [antes.id]),
        `${coluna} tem de ser imutável no banco`,
      ).rejects.toMatchObject({ code: '23001' });
    }

    /**
     * `origin_worker_id` NÃO está na lista de colunas imutáveis do trigger da
     * 140 — e não precisa estar: ele não carrega autoridade. Quem autoriza é
     * `origin_claim_token` (imutável), e o LOADER exige a coincidência dos três
     * (token, tentativa, worker). Reescrever o worker no `psql` só faz o run
     * deixar de carregar para quem escreveu.
     */
    await pool.query(`UPDATE engine_runs SET origin_worker_id='outro-dono' WHERE id=$1`, [
      antes.id,
    ]);
    expect(
      await scoped(() => loadHermesLaunchContext(antes.id, f.execution)),
      'worker divergente não carrega o run — não há herança de posse',
    ).toBeNull();
    await pool.query(`UPDATE engine_runs SET origin_worker_id=$2 WHERE id=$1`, [
      antes.id,
      f.execution.worker_id,
    ]);
    expect(await scoped(() => loadHermesLaunchContext(antes.id, f.execution))).not.toBeNull();

    // (2) VOCABULÁRIO de fase.
    await expect(
      pool.query(`UPDATE engine_runs SET phase='nope' WHERE id=$1`, [antes.id]),
    ).rejects.toMatchObject({ code: '23514' });

    // (3) TERMINAL incompleto não é aceito como `result_ready`.
    await expect(
      pool.query(`UPDATE engine_runs SET phase='result_ready' WHERE id=$1`, [antes.id]),
    ).rejects.toMatchObject({ code: '23514' });

    // (4) `remote_run_id`: NULL → valor UMA vez; a segunda troca é recusada.
    await pool.query(`UPDATE engine_runs SET remote_run_id='remote-once' WHERE id=$1`, [antes.id]);
    await expect(
      pool.query(`UPDATE engine_runs SET remote_run_id='remote-twice' WHERE id=$1`, [antes.id]),
    ).rejects.toMatchObject({ code: '23001' });

    // (5) O ledger é APPEND-ONLY.
    await expect(
      pool.query(`UPDATE engine_run_events SET metadata_json='{}'::jsonb WHERE run_id=$1`, [antes.id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      pool.query(`DELETE FROM engine_run_events WHERE run_id=$1`, [antes.id]),
    ).rejects.toMatchObject({ code: '23001' });
    const eventos = await pool.query<{ n: string; min_seq: string; max_seq: string }>(
      `SELECT count(*)::text AS n, min(sequence_no)::text AS min_seq, max(sequence_no)::text AS max_seq
         FROM engine_run_events WHERE run_id=$1`,
      [antes.id],
    );
    expect(eventos.rows[0]).toEqual({ n: '1', min_seq: '1', max_seq: '1' });

    // (6) ESCPO CRUZADO: a FK COMPOSTA recusa um run para um escopo que não existe.
    await expect(
      pool.query(
        `INSERT INTO engine_runs(id,tenant_id,agent_id,turn_id,generation_no,origin_turn_attempt,
           origin_claim_token,origin_worker_id,control_id,control_epoch,mode,manifest_digest,phase,row_version,
           request_key,remote_instance_id,request_json,request_hash,host_context_json,host_context_hash,
           deadline_at,reconcile_deadline_at,last_event_sequence)
         SELECT gen_random_uuid(), $1, 'outro-agente-sc02', turn_id, 1, origin_turn_attempt,
           origin_claim_token, origin_worker_id, control_id, control_epoch, mode, manifest_digest, 'prepared', 0,
           gen_random_uuid(), remote_instance_id, request_json, request_hash, host_context_json, host_context_hash,
           deadline_at, reconcile_deadline_at, 0
           FROM engine_runs WHERE id=$2`,
        [T, antes.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    // (7) ÚNICO parcial de run ABERTO por turno.
    const idx = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='engine_runs_one_open_turn_uq'`,
    );
    expect(idx.rowCount).toBe(1);
    expect(idx.rows[0]!.indexdef).toContain('UNIQUE');
    expect(idx.rows[0]!.indexdef).toContain('phase');

    // (8) TAMANHO: um request acima do teto da coluna é recusado pelo CHECK.
    const enorme = JSON.stringify({
      ...requestV1(),
      context: { system: 'SC02', messages: [{ role: 'user', content: 'x'.repeat(1_200_000) }], tools: [] },
    });
    await expect(persistirRunManual({ request_json_text: enorme })).rejects.toMatchObject({
      code: '23514',
    });

    // (9) MESMA execução (`request_key`) não abre um segundo run.
    const manual = await persistirRunManual();
    await expect(persistirRunManual({ request_key: manual.request_key })).rejects.toMatchObject({
      code: '23505',
    });

    // (10) Nenhuma recusa acima escreveu nada.
    const depois = await lerRun(antes.id);
    expect(depois.row_version).toBe(antes.row_version);
    expect(depois.submit_count).toBe(0);
    expect(depois.request_hash).toBe(antes.request_hash);
    expect(depois.request_json).toEqual(antes.request_json);
  }, 180_000);

  /**
   * AC07 — os LEDGERS são os que já existem; nenhuma segunda outbox de envio é
   * criada, e a migration do card é APPEND-ONLY (função + trigger, sem tabela).
   */
  it('AC07 — ledgers existentes, sem segunda outbox e migration append-only', async () => {
    const tabelas = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public'
        AND tablename IN ('outbound_messages','outbox_messages','engine_runs','engine_run_events',
                          'engine_inference_attempts','engine_turn_bindings','hermes_runtime_manifests',
                          'conversation_controls')
        ORDER BY tablename`,
    );
    expect(tabelas.rows.map((r) => r.tablename)).toEqual([
      'conversation_controls',
      'engine_inference_attempts',
      'engine_run_events',
      'engine_runs',
      'engine_turn_bindings',
      'hermes_runtime_manifests',
      'outbound_messages',
      'outbox_messages',
    ]);

    const sql150 = readFileSync('migrations/150_engine_turn_bindings_immutable.sql', 'utf8');
    expect(sql150).not.toMatch(/CREATE\s+TABLE/i);
    expect(sql150).toMatch(/CREATE OR REPLACE FUNCTION engine_turn_bindings_immutable_columns/);
    expect(sql150).toMatch(/BEFORE UPDATE ON engine_turn_bindings/);

    // O fluxo provado não escreve em NENHUMA outbox nem cria sessão de engine.
    const sessoesAntes = await contar(`SELECT count(*)::text AS n FROM app_sessions`, []);
    const f = await criarTurno({ atual: 'ledger' });
    await reivindicar(f);
    const run_id = (await admitir(f))!;
    expect(
      await contar(`SELECT count(*)::text AS n FROM outbound_messages WHERE turn_id=$1`, [f.turn_id]),
    ).toBe(0);
    expect(
      await contar(
        `SELECT count(*)::text AS n FROM outbox_messages WHERE tenant_id=$1 AND agent_id=$2`,
        [T, A],
      ),
    ).toBe(0);
    expect(
      await contar(`SELECT count(*)::text AS n FROM engine_inference_attempts WHERE run_id=$1`, [
        run_id,
      ]),
    ).toBe(0);

    // As OUTRAS outboxes/ledgers do repo seguem intocadas neste escopo — nenhuma
    // "segunda outbox de envio" nasce do fluxo do engine.
    const outrasOutboxes: Array<[string, string]> = [
      [
        'idempotency_effect_outbox',
        `SELECT count(*)::text AS n FROM idempotency_effect_outbox WHERE tenant_id=$1 AND agent_id=$2`,
      ],
      [
        'runtime_trace_body_outbox',
        `SELECT count(*)::text AS n FROM runtime_trace_body_outbox WHERE tenant_id=$1 AND agent_id=$2`,
      ],
      [
        'approval_requests',
        `SELECT count(*)::text AS n FROM approval_requests WHERE tenant_id=$1 AND agent_id=$2`,
      ],
      [
        'pending_questions',
        `SELECT count(*)::text AS n FROM pending_questions WHERE tenant_id=$1 AND agent_id=$2`,
      ],
      [
        'playground_sessions',
        `SELECT count(*)::text AS n FROM playground_sessions WHERE tenant_id=$1 AND agent_id=$2`,
      ],
    ];
    for (const [nome, sql] of outrasOutboxes) {
      expect(await contar(sql, [T, A]), `${nome} não pode receber linha deste fluxo`).toBe(0);
    }
    expect(
      await contar(`SELECT count(*)::text AS n FROM app_sessions`, []),
      'sessão global de engine não é criada',
    ).toBe(sessoesAntes);
  }, 120_000);

  /**
   * AC10/T09 — `startPrepared` com o runtime REAL e o transporte dublado.
   *
   * Prova: o CAS de submissão vem antes do I/O, o aceite é gravado UMA vez
   * (`submit_count=1`, `remote_run_id` uma vez), a cadeia de eventos é
   * `prepared → submit_started → submit_observed` e um SEGUNDO start não abre
   * segundo processo: ele é mandado para reconciliação.
   */
  it('AC10/T09 — startPrepared: CAS antes do I/O, aceite uma vez e segundo start sem segundo processo', async () => {
    const dbl = engineDouble();
    expect(dbl.runtime.pin.adapter_revision).toBe(HERMES_ENGINE_ADAPTER_REVISION);

    const f = await criarTurno({ atual: 'start' });
    await reivindicar(f);
    const run_id = (await admitir(f, dbl.admirable))!;
    expect(run_id).not.toBeNull();

    const started = await scoped(() =>
      runWithTurnExecution(f.execution, () => dbl.runtime.startPrepared(run_id)),
    );
    expect(started).toMatchObject({ kind: 'accepted' });
    expect(dbl.launches).toHaveLength(1);

    const run = await lerRun(run_id);
    expect(run.phase).toBe('running');
    expect(run.submit_count).toBe(1);
    expect(run.remote_instance_id).toBe(dbl.runtime.remoteInstanceId);
    expect(run.remote_run_id).not.toBeNull();
    expect(run.capabilities_revoked_at).toBeNull();

    const eventos = await pool.query<{ event_type: string; dedupe_key: string }>(
      `SELECT event_type, dedupe_key FROM engine_run_events WHERE run_id=$1 ORDER BY sequence_no`,
      [run_id],
    );
    expect(eventos.rows.map((r) => r.event_type)).toEqual([
      'prepared',
      'submit_started',
      'submit_observed',
    ]);
    expect(eventos.rows.map((r) => r.dedupe_key)).toEqual([
      'prepared',
      'submit_started:1',
      'submit_observed:1:accepted',
    ]);

    // O que o transporte recebeu é o REQUEST e o MANIFEST persistidos.
    const enviado = dbl.launches[0]!.start;
    expect(enviado.run_id).toBe(run_id);
    expect(enviado.request_key).toBe(run.request_key);
    expect(enviado.context).toEqual({
      system: (run.request_json.context as { system: string }).system,
      user_message: 'start',
      history: [],
    });
    expect(enviado.manifest.tools).toEqual([]);

    // SEGUNDO start: o journal manda reconciliar — nunca um segundo processo.
    const segundo = await scoped(() =>
      runWithTurnExecution(f.execution, () => dbl.runtime.startPrepared(run_id)),
    );
    expect(segundo).toEqual({ kind: 'unknown', code: 'run_requires_reconciliation' });
    expect(dbl.launches).toHaveLength(1);
    const depois = await lerRun(run_id);
    expect(depois.submit_count).toBe(1);
    expect(depois.remote_run_id).toBe(run.remote_run_id);
  }, 120_000);

  /**
   * AC10 — a INTENÇÃO de submit é durável ANTES do I/O, e nenhuma TX nossa
   * atravessa a chamada externa.
   *
   * O motor recusa (o `launch` falha). O que se mede depois: o run continua em
   * `submitting` com `submit_count=1` (a intenção ficou gravada), as capacidades
   * foram revogadas, e o processo NÃO é reutilizado — um novo `startPrepared`
   * manda reconciliar. Durante o `launch`, um `FOR UPDATE NOWAIT` de OUTRA
   * conexão na linha do run tem de funcionar: se um TX nosso estivesse aberto,
   * a linha estaria travada e a prova falharia.
   */
  it('AC10 — recusa do motor deixa a intenção durável e revoga, sem TX aberta no I/O', async () => {
    const probe = new pg.Client({ connectionString: process.env.TEST_DB_URL });
    await probe.connect();
    let lockFreeDuringIo: boolean | null = null;
    try {
      const dbl = engineDouble({
        outcome: 'spawn_failed',
        onLaunch: async (spec) => {
          try {
            const r = await probe.query(
              `SELECT id FROM engine_runs WHERE tenant_id=$1 AND agent_id=$2 AND id=$3 FOR UPDATE NOWAIT`,
              [T, A, spec.start.run_id],
            );
            lockFreeDuringIo = r.rowCount === 1;
          } catch {
            lockFreeDuringIo = false;
          }
        },
      });

      const f = await criarTurno({ atual: 'recusa' });
      await reivindicar(f);
      const run_id = (await admitir(f, dbl.admirable))!;

      // SENSIBILIDADE DO MEDIDOR: com a linha realmente TRAVADA, o `NOWAIT`
      // do probe falha. Sem esta prova, `lockFreeDuringIo === true` não
      // distinguiria "sem TX" de "a query nunca checou nada".
      const travas = new pg.Client({ connectionString: process.env.TEST_DB_URL });
      await travas.connect();
      try {
        await travas.query('BEGIN');
        await travas.query(
          `SELECT id FROM engine_runs WHERE tenant_id=$1 AND agent_id=$2 AND id=$3 FOR UPDATE`,
          [T, A, run_id],
        );
        let medidorAcusa = false;
        try {
          await probe.query(
            `SELECT id FROM engine_runs WHERE tenant_id=$1 AND agent_id=$2 AND id=$3 FOR UPDATE NOWAIT`,
            [T, A, run_id],
          );
        } catch {
          medidorAcusa = true;
        }
        expect(
          medidorAcusa,
          'o medidor precisa acusar linha travada — senão lockFreeDuringIo não prova ausência de TX',
        ).toBe(true);
      } finally {
        await travas.query('ROLLBACK').catch(() => {});
        await travas.end().catch(() => {});
      }

      const res = await scoped(() =>
        runWithTurnExecution(f.execution, () => dbl.runtime.startPrepared(run_id)),
      );
      expect(res).toEqual({
        kind: 'rejected',
        definitely_not_accepted: true,
        code: 'launch_spawn_failed',
      });
      expect(
        lockFreeDuringIo,
        'o I/O do motor não pode acontecer dentro de uma TX do journal',
      ).toBe(true);
      expect(dbl.launches).toHaveLength(1);

      const run = await lerRun(run_id);
      expect(run.phase).toBe('submitting');
      expect(run.submit_count).toBe(1);
      expect(run.remote_run_id).toBeNull();
      expect(run.capabilities_revoked_at).not.toBeNull();

      // Sem retry inventado: um novo start é recusado por reconciliação.
      const segundo = await scoped(() =>
        runWithTurnExecution(f.execution, () => dbl.runtime.startPrepared(run_id)),
      );
      expect(segundo).toEqual({ kind: 'unknown', code: 'run_requires_reconciliation' });
      expect(dbl.launches).toHaveLength(1);
    } finally {
      await probe.end().catch(() => {});
    }
  }, 120_000);

  /**
   * AC09 — `remote_run_id` só NULL→valor UMA vez, dedupe sob lock incrementa a
   * sequência UMA vez, metadata minimizada (ids e códigos, nunca conteúdo).
   */
  it('AC09 — aceite uma vez, conflito de id bloqueia o run e metadata é só id/código', async () => {
    const dbl = engineDouble();
    const f = await criarTurno({ atual: 'ack' });
    await reivindicar(f);
    const run_id = (await admitir(f, dbl.admirable))!;
    await scoped(() => runWithTurnExecution(f.execution, () => dbl.runtime.startPrepared(run_id)));
    const aceito = await lerRun(run_id);
    expect(aceito.remote_run_id).not.toBeNull();
    const sequencia = aceito.last_event_sequence;

    // (1) redelivery do MESMO aceite: idempotente, sem nova sequência.
    const mesmo = await scoped(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: f.turn_id,
        origin_claim_token: f.claim_token,
        observation: { kind: 'accepted', remote_run_id: aceito.remote_run_id! },
      }),
    );
    expect(mesmo).toMatchObject({ ok: true });
    expect((await lerRun(run_id)).last_event_sequence).toBe(sequencia);

    // (2) OUTRO id para a MESMA execução: bloqueia, nunca sobrescreve.
    const outro = await scoped(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: f.turn_id,
        origin_claim_token: f.claim_token,
        observation: { kind: 'accepted', remote_run_id: 'outro-processo' },
      }),
    );
    expect(outro).toMatchObject({ ok: false, reason: 'remote_id_conflict' });
    const bloqueado = await lerRun(run_id);
    expect(bloqueado.phase).toBe('blocked');
    expect(bloqueado.remote_run_id).toBe(aceito.remote_run_id);

    // (3) UMA linha por desfecho, e a metadata só carrega ids/códigos.
    const observados = await pool.query<{ dedupe_key: string; metadata_json: unknown }>(
      `SELECT dedupe_key, metadata_json FROM engine_run_events
        WHERE run_id=$1 AND event_type='submit_observed' ORDER BY sequence_no`,
      [run_id],
    );
    expect(observados.rows.map((r) => r.dedupe_key)).toEqual([
      'submit_observed:1:accepted',
      expect.stringMatching(/^submit_observed:conflict:[0-9a-f]{32}$/) as unknown as string,
    ]);
    expect(Object.keys(observados.rows[0]!.metadata_json as object).sort()).toEqual([
      'kind',
      'remote_run_id',
    ]);
    expect(Object.keys(observados.rows[1]!.metadata_json as object).sort()).toEqual([
      'current_remote_run_id',
      'kind',
      'observed_remote_run_id',
    ]);
    const texto = JSON.stringify(observados.rows.map((r) => r.metadata_json));
    expect(texto).not.toContain('SC02 manual');

    // (4) O ancor da mensagem é validado no MESMO escopo: representativa de
    // OUTRA conversa recusa a admissão inteira, sem persistir nada.
    const outroTurno = await criarTurno({ atual: 'ancora' });
    await reivindicar(outroTurno);
    const mensagemDeOutraConversa = randomUUID();
    await pool.query(
      `INSERT INTO mensagens(id,tenant_id,agent_id,conversa_id,channel_id,direcao,tipo,conteudo,metadata,created_at,stream_key,stream_key_version,ingress_seq)
       VALUES($1,$2,$3,$4,$5,'in','texto','ancora','{}'::jsonb, now(), $6, 1, 900001)`,
      [mensagemDeOutraConversa, T, A, f.conversa_id, f.channel_id, f.control_stream_key],
    );
    await pool.query(`UPDATE agent_turns SET representative_message_id=$2 WHERE id=$1`, [
      outroTurno.turn_id,
      mensagemDeOutraConversa,
    ]);
    const recusado = await admitir(outroTurno);
    expect(recusado).toBeNull();
    expect(
      await contar(`SELECT count(*)::text AS n FROM engine_runs WHERE turn_id=$1`, [
        outroTurno.turn_id,
      ]),
    ).toBe(0);
  }, 120_000);

  /**
   * AC11 — o fence avalia o TEMPO depois da espera pelo lock, e toda recusa é
   * TIPADA e sem escrita.
   *
   * `now()` é o instante do INÍCIO da TX, congelado ANTES da espera; a lease é
   * lida com `clock_timestamp()`. Este teste constrói exatamente essa janela:
   * um dono externo trava a linha do turno, o repositório passa a ESPERAR pelo
   * lock, e — enquanto ele espera — a lease vence.
   */
  it('AC11 — lease avaliada DEPOIS da espera de lock recusa como stale_claim, sem escrita', async () => {
    const f = await criarTurno({ atual: 'lock' });
    await reivindicar(f);
    const run_id = (await admitir(f))!;
    const antes = await lerRun(run_id);

    const holder = new pg.Client({ connectionString: process.env.TEST_DB_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT id FROM agent_turns WHERE tenant_id=$1 AND agent_id=$2 AND id=$3 FOR UPDATE`,
        [T, A, f.turn_id],
      );

      const pendente = scoped(() =>
        engineRunsRepo.markSubmitting({
          run_id,
          turn_id: f.turn_id,
          origin_claim_token: f.claim_token,
          expected_row_version: antes.row_version,
        }),
      );

      // (a) o chamador está REALMENTE esperando o lock do turno.
      let esperando = false;
      for (let i = 0; i < 100 && !esperando; i++) {
        const w = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        esperando = w.rows[0]!.n !== '0';
        if (!esperando) await new Promise((r) => setTimeout(r, 50));
      }
      expect(esperando, 'markSubmitting tem de esperar o lock do turno').toBe(true);

      // (b) enquanto espera, o dono da linha faz a lease VENCER.
      await holder.query(
        `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id=$1`,
        [f.turn_id],
      );
      await holder.query('COMMIT');

      const res = await pendente;
      expect(res).toMatchObject({ ok: false, reason: 'stale_claim' });

      const depois = await lerRun(run_id);
      expect(depois.phase).toBe('prepared');
      expect(depois.row_version).toBe(antes.row_version);
      expect(depois.submit_count).toBe(0);
      expect(
        await contar(`SELECT count(*)::text AS n FROM engine_run_events WHERE run_id=$1`, [run_id]),
      ).toBe(1);
    } finally {
      await holder.end().catch(() => {});
    }

    // (c) SEM RETRY COM TOKEN NOVO: outro dono vivo do turno também não pode
    // submeter o run de origem ANTIGA (o token do run é imutável).
    const tokenNovo = randomUUID();
    await pool.query(
      `UPDATE agent_turns SET claim_token=$2, lease_expires_at=now() + interval '5 minutes'
        WHERE id=$1`,
      [f.turn_id, tokenNovo],
    );
    const comNovoToken = await scoped(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: f.turn_id,
        origin_claim_token: tokenNovo,
        expected_row_version: antes.row_version,
      }),
    );
    expect(comNovoToken).toMatchObject({ ok: false, reason: 'stale_claim' });
    const ainda = await lerRun(run_id);
    expect(ainda.phase).toBe('prepared');
    expect(ainda.submit_count).toBe(0);
  }, 120_000);

  /**
   * AC11 — posse VIVA mas turno fora de `running` é `state_mismatch` tipado,
   * não `stale_claim`: a distinção diz ao chamador "o turno andou", não "você
   * não é mais o dono".
   */
  it('AC11 — turno fora de running com posse viva é state_mismatch tipado, sem escrita', async () => {
    const f = await criarTurno({ atual: 'state' });
    await reivindicar(f);
    const run_id = (await admitir(f))!;
    const antes = await lerRun(run_id);

    await pool.query(`UPDATE agent_turns SET status='retryable' WHERE id=$1`, [f.turn_id]);
    const res = await scoped(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: f.turn_id,
        origin_claim_token: f.claim_token,
        expected_row_version: antes.row_version,
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'state_mismatch' });

    const depois = await lerRun(run_id);
    expect(depois.phase).toBe('prepared');
    expect(depois.row_version).toBe(antes.row_version);
    expect(depois.submit_count).toBe(0);
    expect(
      await contar(`SELECT count(*)::text AS n FROM engine_run_events WHERE run_id=$1`, [run_id]),
    ).toBe(1);
  }, 120_000);

  /**
   * AC11 — os orçamentos de QUERY/LOCK do exemplo do §5.6.4 são fixtures do
   * exemplo, não defaults operacionais: o banco do card não impõe
   * `lock_timeout`/`statement_timeout`.
   */
  it('AC11 — o banco do card não impõe orçamento de lock/query (sem default operacional)', async () => {
    const lt = await pool.query<{ lock_timeout: string }>('SHOW lock_timeout');
    const st = await pool.query<{ statement_timeout: string }>('SHOW statement_timeout');
    expect(lt.rows[0]!.lock_timeout).toBe('0');
    expect(st.rows[0]!.statement_timeout).toBe('0');
  }, 60_000);

  /**
   * SPEC-L2842 — os contratos do card NÃO são só interfaces TypeScript: os
   * schemas executáveis e as recusas NEGATIVAS existem no mesmo SHA.
   */
  it('SPEC-L2842/AC04 — manifesto persistido: refs não autorizadas, tools vazias e digest sintético explícito', async () => {
    const f = await criarTurno({ atual: 'manifest' });
    await reivindicar(f);
    const run_id = (await admitir(f))!;
    const run = await lerRun(run_id);
    const linha = await pool.query<{ manifest_json: Record<string, unknown> }>(
      `SELECT manifest_json FROM hermes_runtime_manifests WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3`,
      [T, A, run_id],
    );
    const parsed = parseRuntimeManifest(linha.rows[0]!.manifest_json);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') throw new Error('manifest persistido inválido');
    const manifest = parsed.manifest;

    // Nenhuma publicação/bundle foi consumido: a lista é VAZIA, não "o que der".
    expect(manifest.publication_refs).toEqual([]);
    expect(manifest.tools).toEqual([]);
    expect((run.request_json.context as unknown as { tools: unknown[] }).tools).toEqual([]);

    // O digest de imagem é um RÓTULO SINTÉTICO explícito — não um digest real
    // inventado a partir de colunas.
    expect(manifest.runtime_pin.image_digest).toBe(
      canonicalDigest({ evidence_class: 'synthetic', source_checkout: HERMES_SHA }),
    );
    expect(manifest.runtime_pin.dependency_lock_digest).toBe(
      canonicalDigest({ evidence_class: 'synthetic', unattested: true }),
    );
    expect(manifest.runtime_pin.image_digest).not.toBe(
      manifest.runtime_pin.dependency_lock_digest,
    );

    // O pin do engine é o vocabulário fechado e os epochs são decimais.
    expect(enginePinV1Schema.safeParse(manifest.runtime_pin.hermes_sha).success).toBe(false);
    expect(manifest.control_epoch).toBe('0');
    expect(manifest.exposure_epoch).toBe('0');
  }, 120_000);

  /**
   * AC04/SPEC-L2842 — a cláusula de AUTORIZAÇÃO: o manifesto sintético não
   * consome bundle que ninguém publicou e não carrega tool de negócio. O
   * manifesto adulterado PARSEIA (senão a recusa seria do schema, não da
   * autorização) e a recusa deixa a linha original intacta.
   */
  it('AC04/SPEC-L2842 — ref de publicação não autorizada é RECUSADA e nada é persistido', async () => {
    const f = await criarTurno({ atual: 'ref-nao-autorizada' });
    await reivindicar(f);
    const run_id = (await admitir(f))!;

    const lerManifesto = async () => {
      const r = await pool.query<{ manifest_json: Record<string, unknown> }>(
        `SELECT manifest_json FROM hermes_runtime_manifests WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3`,
        [T, A, run_id],
      );
      return { linhas: r.rowCount, json: r.rows[0]!.manifest_json };
    };
    const original = await lerManifesto();
    expect(original.linhas).toBe(1);
    expect(original.json.publication_refs).toEqual([]);

    // (1) Bundle que ninguém publicou: a interface RECUSA em vez de consumir.
    const comRef = { ...original.json, publication_refs: ['bundle:nao-publicado'] };
    expect(parseRuntimeManifest(comRef).kind, 'adulterar precisa PARSEAR').toBe('ok');
    expect(await scoped(() => persistSyntheticHermesManifest(comRef, f.execution))).toEqual({
      kind: 'refused',
    });

    // (2) Tool de negócio: recusada já no CONTRATO (allowlist do §7.10.3) e
    // também pela cláusula de autorização do produtor.
    const comTool = { ...original.json, tools: ['consultar_saldo'] };
    expect(parseRuntimeManifest(comTool).kind, 'tool fora da allowlist é recusada no parse').toBe(
      'rejected',
    );
    expect(await scoped(() => persistSyntheticHermesManifest(comTool, f.execution))).toEqual({
      kind: 'refused',
    });

    // (3) Nada foi escrito: uma linha, e é a original, byte a byte.
    const depois = await lerManifesto();
    expect(depois.linhas).toBe(1);
    expect(depois.json).toEqual(original.json);
    expect(
      await contar(`SELECT count(*)::text AS n FROM engine_inference_attempts WHERE run_id=$1`, [
        run_id,
      ]),
      'nenhuma inferência foi disparada',
    ).toBe(0);
  }, 120_000);

  /**
   * SPEC-L1401 — as cláusulas de imutabilidade que a rodada 1 não provou:
   * terminal conflituoso (`engine_runs`) rejeitado, repetir o IDÊNTICO é no-op
   * e os args da tool call (`engine_tool_calls`) também são imutáveis, com
   * `effect_evidence` monotônico.
   */
  it('SPEC-L1401 — terminal e args de tool são imutáveis; repetir o idêntico é no-op', async () => {
    const f = await criarTurno({ atual: 'l1401' });
    await reivindicar(f);
    const run_id = (await admitir(f))!;

    const terminal = JSON.stringify({ resultado: 'sintetico' });
    const terminalHash = canonicalDigest({ resultado: 'sintetico' });
    const aceitarTerminal = () =>
      pool.query(`UPDATE engine_runs SET terminal_json=$2::jsonb, terminal_hash=$3 WHERE id=$1`, [
        run_id,
        terminal,
        terminalHash,
      ]);

    // NULL -> valor (uma vez) e, repetido BYTE A BYTE, é no-op.
    await aceitarTerminal();
    await aceitarTerminal();

    // Terminal DIFERENTE para a mesma execução é conflito, não sobrescrita.
    await expect(
      pool.query(`UPDATE engine_runs SET terminal_hash=$2 WHERE id=$1`, [
        run_id,
        canonicalDigest({ outro: 'terminal' }),
      ]),
      'terminal já aceito não pode ser substituído',
    ).rejects.toMatchObject({ code: '23001' });

    // `call args` (SPEC-L1401) vivem em `engine_tool_calls`.
    await pool.query(
      `INSERT INTO engine_tool_calls(id,tenant_id,agent_id,run_id,turn_id,call_id,ordinal,tool_name,args_json,args_hash,request_id,state,effect_evidence)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,'run:1',0,'ler_memoria','{"x":1}'::jsonb,$5,gen_random_uuid(),'received','possible')`,
      [T, A, run_id, f.turn_id, 'a'.repeat(64)],
    );
    await expect(
      pool.query(`UPDATE engine_tool_calls SET args_json='{"x":2}'::jsonb WHERE run_id=$1`, [
        run_id,
      ]),
      'args_json é imutável',
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      pool.query(`UPDATE engine_tool_calls SET effect_evidence='none' WHERE run_id=$1`, [run_id]),
      'effect_evidence não regride para none',
    ).rejects.toMatchObject({ code: '23001' });

    // Repetir os MESMOS args é no-op — a recusa acima não é "UPDATE proibido".
    await pool.query(`UPDATE engine_tool_calls SET args_json='{"x":1}'::jsonb WHERE run_id=$1`, [
      run_id,
    ]);
    expect(
      await contar(`SELECT count(*)::text AS n FROM engine_inference_attempts WHERE run_id=$1`, [
        run_id,
      ]),
      'nenhuma inferência foi disparada por nenhuma destas escritas',
    ).toBe(0);
  }, 120_000);

  /**
   * SPEC-L1401 — o defeito que a revisão QA reproduziu: o terminal aceito era
   * imutável só pelo `terminal_hash`. Reescrever `terminal_json` mantendo o
   * hash antigo passava (`UPDATE 1`), e o journal passava a guardar um terminal
   * que ninguém aceitou — invisível para qualquer leitor que compare hash, que
   * é justamente o que o hash deveria estar guardando.
   *
   * Prova-se aqui que o CONTEÚDO é o imutável e o hash é a prova de qual
   * conteúdo foi aceito, não uma licença para trocar o conteúdo:
   *
   *  (a) trocar o conteúdo com o hash intacto é conflito — cláusula que este
   *      caso dirige (falha antes da migration, passa depois);
   *  (b) repetir o terminal IDÊNTICO continua no-op, porque a recusa é do
   *      CONFLITO e não "UPDATE proibido";
   *  (c) aceito não volta a NULL;
   *  (d) a linha segue byte a byte com o terminal original e nada de
   *      inferência foi disparado por nenhuma destas escritas.
   */
  it('SPEC-L1401 — terminal aceito é imutável no CONTEÚDO, não só no hash', async () => {
    const f = await criarTurno({ atual: 'l1401-conteudo' });
    await reivindicar(f);
    const run_id = (await admitir(f))!;

    const terminal = { resultado: 'sintetico' };
    const terminalJson = JSON.stringify(terminal);
    const terminalHash = canonicalDigest(terminal);
    await pool.query(
      `UPDATE engine_runs SET terminal_json=$2::jsonb, terminal_hash=$3 WHERE id=$1`,
      [run_id, terminalJson, terminalHash],
    );

    // (a) O conteúdo MUDA e o hash NÃO: ainda assim é conflito.
    await expect(
      pool.query(`UPDATE engine_runs SET terminal_json=$2::jsonb WHERE id=$1`, [
        run_id,
        JSON.stringify({ resultado: 'ADULTERADO' }),
      ]),
      'terminal já aceito não pode ser reescrito nem mantendo o hash',
    ).rejects.toMatchObject({ code: '23001' });

    // (b) Repetir o IDÊNTICO é no-op — a recusa acima não é "UPDATE proibido".
    const repetido = await pool.query(
      `UPDATE engine_runs SET terminal_json=$2::jsonb, terminal_hash=$3 WHERE id=$1`,
      [run_id, terminalJson, terminalHash],
    );
    expect(repetido.rowCount, 'repetir o terminal idêntico continua no-op').toBe(1);

    // (c) Aceito não volta a NULL.
    await expect(
      pool.query(`UPDATE engine_runs SET terminal_json=NULL, terminal_hash=NULL WHERE id=$1`, [
        run_id,
      ]),
      'terminal aceito não pode ser apagado',
    ).rejects.toMatchObject({ code: '23001' });

    // (d) A linha continua com o terminal ORIGINAL: nenhuma recusa escreveu.
    const { rows } = await pool.query(
      `SELECT terminal_json, terminal_hash FROM engine_runs WHERE id=$1`,
      [run_id],
    );
    expect(rows[0].terminal_json).toEqual(terminal);
    expect(rows[0].terminal_hash).toBe(terminalHash);
    expect(
      await contar(`SELECT count(*)::text AS n FROM engine_inference_attempts WHERE run_id=$1`, [
        run_id,
      ]),
      'nenhuma inferência foi disparada por nenhuma destas escritas',
    ).toBe(0);
  }, 120_000);

  /**
   * AC07/SPEC-L1401 — a guarda é do BANCO, e o `_down` é um rollback REAL.
   *
   * Roda num SCHEMA DESCARTÁVEL do banco do card (não toca o journal real):
   * aplica a 151 do ARQUIVO, prova a recusa, aplica o `_down`, prova que a
   * MESMA escrita passa a ser aceita — isto é, quem recusava era o objeto que
   * a 151 cria — e reaplica o `up` para provar que a recusa volta.
   *
   * Sem o passo do `_down` a prova seria ambígua: a recusa poderia vir de
   * qualquer trigger preexistente do banco, e não do que esta migration
   * acrescenta.
   */
  it('AC07/SPEC-L1401 — a guarda do terminal vive no banco e o down a remove de verdade', async () => {
    const client = new pg.Client({ connectionString: process.env.TEST_DB_URL });
    const schema = `sc02_terminal_${randomUUID().replaceAll('-', '')}`;
    const up = readFileSync('migrations/151_engine_runs_terminal_immutable.sql', 'utf8');
    const down = readFileSync('migrations/151_engine_runs_terminal_immutable_down.sql', 'utf8');
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema},public`);
      // Tabela mínima: a 151 só lê o par do terminal (não é fixture de runtime).
      await client.query(
        'CREATE TABLE engine_runs(id uuid PRIMARY KEY, terminal_json jsonb, terminal_hash text)',
      );
      await client.query(up);

      const run = randomUUID();
      await client.query(
        `INSERT INTO engine_runs(id, terminal_json, terminal_hash) VALUES($1, $2::jsonb, $3)`,
        [run, JSON.stringify({ resultado: 'sintetico' }), 'b'.repeat(64)],
      );

      const adulterar = (valor: string) =>
        client.query(`UPDATE engine_runs SET terminal_json=$2::jsonb WHERE id=$1`, [
          run,
          JSON.stringify({ resultado: valor }),
        ]);

      // Com a 151: conflito, mesmo com o hash intacto.
      await expect(
        adulterar('ADULTERADO'),
        'com a 151 aplicada, o conteúdo do terminal aceito não muda',
      ).rejects.toMatchObject({ code: '23001' });

      // Sem a 151 (o `down` real): a MESMA escrita passa — a recusa anterior era do objeto criado aqui.
      await client.query(down);
      expect(
        (await adulterar('ADULTERADO')).rowCount,
        'o down remove mesmo a guarda',
      ).toBe(1);

      // E o `up` de volta recusa de novo: a migration é reaplicável.
      await client.query(up);
      await expect(
        adulterar('ADULTERADO-2'),
        'reaplicar o up reinstala a recusa',
      ).rejects.toMatchObject({ code: '23001' });
    } finally {
      await client.query('ROLLBACK');
      await client.query('SET search_path TO public');
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  }, 120_000);
});

describe('SC02 — contratos estritos do wire (§5.3.1/§4.1) e canonicidade (T05/T07/T08)', () => {
  it('T05/AC06 — omissão, campo EXTRA e UUID inválido são recusados pelo schema estrito', () => {
    expect(engineRequestV1Schema.safeParse(requestV1()).success).toBe(true);

    // (1) CAMPO EXTRA no topo e dentro do contexto: autoridade acidental barrada.
    expect(engineRequestV1Schema.safeParse(requestV1({ extra: 1 })).success).toBe(false);
    const comExtraNoContexto = requestV1();
    (comExtraNoContexto.context as Record<string, unknown>).approved = true;
    expect(engineRequestV1Schema.safeParse(comExtraNoContexto).success).toBe(false);

    // (2) OMISSÃO de campo obrigatório.
    const semLimites = requestV1();
    delete semLimites.limits;
    expect(engineRequestV1Schema.safeParse(semLimites).success).toBe(false);

    // (3) UUID inválido e vocabulário fechado.
    expect(engineRequestV1Schema.safeParse(requestV1({ run_id: 'nao-e-uuid' })).success).toBe(false);
    expect(engineRequestV1Schema.safeParse(requestV1({ task: 'chat' })).success).toBe(false);
    expect(engineRequestV1Schema.safeParse(requestV1({ isolation: 'shared' })).success).toBe(false);

    // (4) O snapshot de host: extra, epoch decimal e ids não vazios.
    expect(hostContextSnapshotV1Schema.safeParse(hostV1()).success).toBe(true);
    expect(hostContextSnapshotV1Schema.safeParse(hostV1({ extra: true })).success).toBe(false);
    expect(
      hostContextSnapshotV1Schema.safeParse(hostV1({ control_epoch: '007' })).success,
    ).toBe(false);
    expect(hostContextSnapshotV1Schema.safeParse(hostV1({ control_epoch: '1' })).success).toBe(true);
    expect(hostContextSnapshotV1Schema.safeParse(hostV1({ input_message_ids: [] })).success).toBe(
      false,
    );
    expect(hostContextSnapshotV1Schema.safeParse(hostV1({ channel_id: 'x' })).success).toBe(false);

    // (5) O pin: só `maia_react`/`hermes`, protocolo 1, digest sha256.
    expect(
      enginePinV1Schema.safeParse({
        engine: 'outro',
        adapter_revision: 'r',
        configuration_digest: 'a'.repeat(64),
        protocol_version: 1,
      }).success,
    ).toBe(false);
    expect(
      enginePinV1Schema.safeParse({
        engine: 'maia_react',
        adapter_revision: 'r',
        configuration_digest: 'a'.repeat(64),
        protocol_version: 1,
      }).success,
    ).toBe(true);
    expect(
      enginePinV1Schema.safeParse({
        engine: 'hermes',
        adapter_revision: 'r',
        configuration_digest: 'A'.repeat(64),
        protocol_version: 1,
      }).success,
    ).toBe(false);
  });

  it('T08 — reordenar o payload mantém o fingerprint; mutá-lo troca o fingerprint', () => {
    const a = { b: { d: 3, c: [1, 2] }, a: 1 };
    const reordenado = { a: 1, b: { c: [1, 2], d: 3 } };
    expect(canonicalDigest(a)).toBe(canonicalDigest(reordenado));

    const mutado = { a: 1, b: { c: [1, 2], d: 4 } };
    expect(canonicalDigest(a)).not.toBe(canonicalDigest(mutado));
    expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: 2 }));
  });

  it('T07/§5.3.4 — JSON não serializável é erro TIPADO, não conversão silenciosa', () => {
    const casos: Array<[unknown, string]> = [
      [{ x: undefined }, 'unsupported_type'],
      [{ x: () => 1 }, 'unsupported_type'],
      [{ x: new Map() }, 'unsupported_type'],
      [{ x: new Date() }, 'unsupported_type'],
      [{ x: Number.NaN }, 'non_finite'],
      [{ x: Number.POSITIVE_INFINITY }, 'non_finite'],
    ];
    for (const [valor, codigo] of casos) {
      let capturado: unknown = null;
      try {
        canonicalJsonStringify(valor);
      } catch (error) {
        capturado = error;
      }
      expect(capturado, `${codigo}: tem de lançar`).toBeInstanceOf(CanonicalJsonError);
      expect((capturado as CanonicalJsonError).code).toBe(codigo);
    }
    const ciclo: Record<string, unknown> = {};
    ciclo.self = ciclo;
    expect(() => canonicalJsonStringify(ciclo)).toThrow(CanonicalJsonError);
  });
});