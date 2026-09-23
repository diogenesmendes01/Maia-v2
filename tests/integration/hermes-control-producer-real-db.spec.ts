import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { ensureHermesConversationControl } from '@/db/repositories/hermes-control-producer.js';

const d =
  process.env.TEST_DB_URL && process.env.TEST_DB_URL === process.env.DATABASE_URL
    ? describe
    : describe.skip;
const tenant_id = `producer-${randomUUID()}`;
const agent_id = `producer-${randomUUID()}`;
const scoped = <T>(fn: () => Promise<T>) => runWithTenantContext({ tenant_id, agent_id }, fn);
let pool: pg.Pool;
async function fixture() {
  const channel = randomUUID(),
    person = randomUUID(),
    conversation = randomUUID();
  const message = randomUUID(),
    turn = randomUUID(),
    claim = randomUUID();
  // Persisted canonical stream format; no external channel transport is used.
  const stream = `v1:${randomUUID().replaceAll('-', '').repeat(2)}`;
  await pool.query(
    "INSERT INTO channels(id,tenant_id,agent_id,external_id,channel_type) VALUES($1::uuid,$2,$3,$1::text,'whatsapp')",
    [channel, tenant_id, agent_id],
  );
  await pool.query(
    "INSERT INTO pessoas(id,tenant_id,agent_id,nome,telefone_whatsapp,tipo) VALUES($1::uuid,$2,$3,'Synthetic',$1::text,'dono')",
    [person, tenant_id, agent_id],
  );
  await pool.query(
    'INSERT INTO conversas(id,tenant_id,agent_id,pessoa_id,channel_id) VALUES($1,$2,$3,$4,$5)',
    [conversation, tenant_id, agent_id, person, channel],
  );
  await pool.query(
    "INSERT INTO mensagens(id,tenant_id,agent_id,conversa_id,channel_id,direcao,tipo,conteudo,stream_key,stream_key_version,ingress_seq) VALUES($1,$2,$3,$4,$5,'in','texto','synthetic',$6,1,1)",
    [message, tenant_id, agent_id, conversation, channel, stream],
  );
  await pool.query(
    "INSERT INTO agent_turns(id,tenant_id,agent_id,representative_message_id,status,claim_token,attempt_count,claimed_by,lease_expires_at,stream_key,stream_key_version) VALUES($1,$2,$3,$4,'running',$5,1,'synthetic',now()+interval '5 minutes',$6,1)",
    [turn, tenant_id, agent_id, message, claim, stream],
  );
  return { turn_id: turn, claim_token: claim, stream, conversation, person, channel };
}
d('Hermes conversation control producer — PostgreSQL', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 2 });
    await pool.query('INSERT INTO tenants(id,nome) VALUES($1,$1)', [tenant_id]);
    await pool.query('INSERT INTO agents(id,tenant_id,nome) VALUES($1,$2,$1)', [
      agent_id,
      tenant_id,
    ]);
  });
  afterAll(async () => {
    await pool?.end();
  });
  it('produces one stable control from resolved persisted identity under concurrent retries', async () => {
    const f = await fixture();
    const results = await Promise.all(
      [0, 1].map(() => scoped(() => ensureHermesConversationControl(f))),
    );
    expect(results[0]).toMatchObject({ kind: 'ok', control_epoch: '0' });
    expect(results[1]).toEqual(results[0]);
    const rows = (
      await pool.query(
        'SELECT * FROM conversation_controls WHERE tenant_id=$1 AND agent_id=$2 AND stream_key=$3',
        [tenant_id, agent_id, f.stream],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversa_id: f.conversation,
      pessoa_id: f.person,
      channel_id: f.channel,
      mode: 'bot',
    });
    const audits = (
      await pool.query(
        "SELECT id FROM audit_log WHERE tenant_id=$1 AND agent_id=$2 AND acao='conversation_control_created' AND alvo_id=$3",
        [tenant_id, agent_id, rows[0].id],
      )
    ).rows;
    expect(audits).toHaveLength(1);
  });
  it('refuses stale claims, missing scope, and unresolved identity without creating controls', async () => {
    const f = await fixture();
    expect(
      await scoped(() => ensureHermesConversationControl({ ...f, claim_token: randomUUID() })),
    ).toEqual({ kind: 'refused' });
    expect(
      await runWithTenantContext({ tenant_id, agent_id: 'another-agent' }, () =>
        ensureHermesConversationControl(f),
      ),
    ).toEqual({ kind: 'refused' });
    await pool.query(
      'UPDATE mensagens SET conversa_id=NULL WHERE id=(SELECT representative_message_id FROM agent_turns WHERE id=$1)',
      [f.turn_id],
    );
    expect(await scoped(() => ensureHermesConversationControl(f))).toEqual({ kind: 'refused' });
    expect(
      (
        await pool.query(
          'SELECT id FROM conversation_controls WHERE tenant_id=$1 AND agent_id=$2 AND stream_key=$3',
          [tenant_id, agent_id, f.stream],
        )
      ).rows,
    ).toHaveLength(0);
  });
  it('never resets a paused control', async () => {
    const f = await fixture();
    const first = await scoped(() => ensureHermesConversationControl(f));
    expect(first.kind).toBe('ok');
    await pool.query(
      "UPDATE conversation_controls SET mode='human',owner_app_user_id='synthetic-operator',paused_at=now(),control_epoch=1 WHERE tenant_id=$1 AND agent_id=$2 AND stream_key=$3",
      [tenant_id, agent_id, f.stream],
    );
    expect(await scoped(() => ensureHermesConversationControl(f))).toEqual({ kind: 'refused' });
    const row = (
      await pool.query(
        'SELECT mode,control_epoch::text FROM conversation_controls WHERE tenant_id=$1 AND agent_id=$2 AND stream_key=$3',
        [tenant_id, agent_id, f.stream],
      )
    ).rows[0];
    expect(row).toEqual({ mode: 'human', control_epoch: '1' });
  });
});
