/** First resolved binding for a persisted stream. No rollover or implicit resume.
 * Caller provides only a turn and its claim; identity comes from scoped rows.
 * Locks: control → turn. No I/O or stream-sequence allocation in this TX.
 */
import { sql } from 'drizzle-orm';
import { db, withTx } from '../client.js';
import { getCurrentAgent, getCurrentTenant } from '../tenant-context.js';
import { lockControlByIdSql } from './conversation-control-sql.js';
import { auditTx } from '@/governance/audit.js';

type Identity = { stream_key: string; channel_id: string; conversa_id: string; pessoa_id: string };
type Result = { kind: 'ok'; control_id: string; control_epoch: string } | { kind: 'refused' };
class Refused extends Error {}
export async function ensureHermesConversationControl(input: {
  turn_id: string;
  claim_token: string;
}): Promise<Result> {
  const tenant_id = getCurrentTenant(),
    agent_id = getCurrentAgent();
  const identitySql = sql`
    SELECT t.stream_key, cv.channel_id, cv.id AS conversa_id, cv.pessoa_id
      FROM agent_turns t
      JOIN mensagens m ON m.tenant_id=t.tenant_id AND m.agent_id=t.agent_id AND m.id=t.representative_message_id
      JOIN conversas cv ON cv.tenant_id=t.tenant_id AND cv.agent_id=t.agent_id AND cv.id=m.conversa_id AND cv.channel_id=m.channel_id
      JOIN pessoas p ON p.tenant_id=t.tenant_id AND p.agent_id=t.agent_id AND p.id=cv.pessoa_id
      JOIN channels ch ON ch.tenant_id=t.tenant_id AND ch.agent_id=t.agent_id AND ch.id=cv.channel_id
     WHERE t.tenant_id=${tenant_id} AND t.agent_id=${agent_id} AND t.id=${input.turn_id}
       AND t.claim_token=${input.claim_token}::uuid AND t.status='running'
       AND t.lease_expires_at > clock_timestamp()
       AND t.stream_key=m.stream_key AND t.stream_key_version=1 AND m.stream_key_version=1
       AND t.stream_key ~ '^v1:[0-9a-f]{64}$' AND m.direcao='in'`;
  const read = async (tx: typeof db) =>
    (await tx.execute(identitySql)).rows[0] as Identity | undefined;
  try {
    return await withTx(async (tx) => {
      const identity = await read(tx);
      if (!identity) throw new Refused();
      const inserted = await tx.execute(sql`
        INSERT INTO conversation_controls(tenant_id,agent_id,stream_key,stream_key_version,channel_id,conversa_id,pessoa_id)
        VALUES(${tenant_id},${agent_id},${identity.stream_key},1,${identity.channel_id},${identity.conversa_id},${identity.pessoa_id})
        ON CONFLICT (tenant_id,agent_id,stream_key) DO NOTHING RETURNING id`);
      const row = (
        await tx.execute(sql`
        SELECT id FROM conversation_controls WHERE tenant_id=${tenant_id} AND agent_id=${agent_id}
          AND stream_key=${identity.stream_key}`)
      ).rows[0] as { id: string } | undefined;
      if (!row) throw new Refused();
      const control = (
        await tx.execute(lockControlByIdSql({ tenant_id, agent_id, control_id: row.id }))
      ).rows[0] as { mode: string; control_epoch: string } | undefined;
      if (!control || control.mode !== 'bot') throw new Refused();
      const bound = (
        await tx.execute(sql`
        SELECT id FROM conversation_controls WHERE tenant_id=${tenant_id} AND agent_id=${agent_id}
          AND id=${row.id} AND channel_id=${identity.channel_id}
          AND conversa_id=${identity.conversa_id} AND pessoa_id=${identity.pessoa_id}`)
      ).rows[0];
      if (!bound) throw new Refused();
      await tx.execute(
        sql`SELECT id FROM agent_turns WHERE tenant_id=${tenant_id} AND agent_id=${agent_id} AND id=${input.turn_id} FOR UPDATE`,
      );
      const current = await read(tx);
      if (!current || JSON.stringify(current) !== JSON.stringify(identity)) throw new Refused();
      if (inserted.rows.length)
        await auditTx(tx, {
          acao: 'conversation_control_created',
          alvo_id: row.id,
          conversa_id: identity.conversa_id,
          pessoa_id: identity.pessoa_id,
          metadata: { turn_id: input.turn_id, control_epoch: control.control_epoch },
        });
      return { kind: 'ok', control_id: row.id, control_epoch: control.control_epoch };
    });
  } catch (error) {
    if (error instanceof Refused) return { kind: 'refused' };
    throw error; // DB failures never mean a missing control or permission.
  }
}
