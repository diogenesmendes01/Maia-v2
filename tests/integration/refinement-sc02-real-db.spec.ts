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
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import type { TurnExecutionContext } from '@/runtime/turns/claim.js';
import type { SyntheticCoreRuntime } from '@/runtime/engines/synthetic-core-context.js';
import type { HermesLaunchContext } from '@/db/repositories/hermes-launch-repo.js';
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