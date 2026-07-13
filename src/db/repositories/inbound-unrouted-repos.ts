/**
 * §1.4 do roteamento multi-linha (spec 2026-07-09 Draft v4) — repo do staging
 * de inbound NÃO-ROTEADO (modo strict).
 *
 * EXCEÇÃO CONSCIENTE de tenant (documentada na spec e em
 * governance-observability): estas rows existem JUSTAMENTE porque nenhum
 * (tenant, agent) resolveu — o payload fica FORA de qualquer tenant,
 * mitigado por cifragem AES-GCM (staging-crypto), TTL de 72h e acesso
 * restrito a este repo + worker de replay. Nenhum método aqui usa
 * applyTenantGuard, por construção.
 */
import { sql, eq, and, lt, gt } from 'drizzle-orm';
import { db } from '../client.js';
import { inbound_unrouted } from '../schema.js';
import type { InboundUnroutedRow } from '../schema.js';

const TTL_HOURS = 72;

export const inboundUnroutedRepo = {
  /**
   * Grava (ou reencontra) a row do par (linha, whatsapp_id). Idempotente por
   * construção (§1.4): o retry do evento Baileys colide no UNIQUE e recebe a
   * MESMA row de volta (`ON CONFLICT ... DO UPDATE` no-op + RETURNING) — o
   * chamador re-arma o job com o jobId estável em AMBOS os casos, então o
   * retry nunca conclui sem garantir job vivo.
   */
  async stage(input: {
    line_external_id: string;
    whatsapp_message_id: string;
    envelope: Buffer;
    enc_key_id: string;
  }): Promise<{ id: string; already_staged: boolean }> {
    const result = await db.execute<{ id: string; inserted: boolean }>(sql`
      INSERT INTO inbound_unrouted
        (line_external_id, whatsapp_message_id, envelope, enc_key_id, status, expires_at)
      VALUES
        (${input.line_external_id}, ${input.whatsapp_message_id}, ${input.envelope},
         ${input.enc_key_id}, 'pending', now() + interval '${sql.raw(String(TTL_HOURS))} hours')
      ON CONFLICT (line_external_id, whatsapp_message_id)
        DO UPDATE SET line_external_id = EXCLUDED.line_external_id
      RETURNING id, (xmax = 0) AS inserted
    `);
    const row = result.rows[0]!;
    return { id: row.id, already_staged: !row.inserted };
  },

  async findById(id: string): Promise<InboundUnroutedRow | null> {
    const rows = await db
      .select()
      .from(inbound_unrouted)
      .where(eq(inbound_unrouted.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * CAS de handoff: só uma entrega vence (replay vs. um segundo replay). O
   * caminho VIVO nunca toca esta tabela — a corrida live/replay resolve no
   * dedup por canal de `mensagens` (§1.7), nunca em entrega dupla.
   */
  async markHandedOff(id: string): Promise<boolean> {
    const rows = await db
      .update(inbound_unrouted)
      .set({ status: 'handed_off', handed_off_at: new Date() })
      .where(and(eq(inbound_unrouted.id, id), eq(inbound_unrouted.status, 'pending')))
      .returning({ id: inbound_unrouted.id });
    return rows.length > 0;
  },

  async bumpAttempts(id: string): Promise<void> {
    await db
      .update(inbound_unrouted)
      .set({ attempts: sql`${inbound_unrouted.attempts} + 1` })
      .where(eq(inbound_unrouted.id, id));
  },

  /**
   * Recovery sweep (§1.4): rows pending "órfãs" — velhas o suficiente para o
   * caminho feliz já ter armado o job. O re-add com jobId estável é
   * idempotente, então varrer uma row cujo job está vivo é inofensivo.
   */
  async listPendingStale(olderThanMs: number, limit: number): Promise<
    Array<{ id: string; line_external_id: string; whatsapp_message_id: string }>
  > {
    const cutoff = new Date(Date.now() - olderThanMs);
    return db
      .select({
        id: inbound_unrouted.id,
        line_external_id: inbound_unrouted.line_external_id,
        whatsapp_message_id: inbound_unrouted.whatsapp_message_id,
      })
      .from(inbound_unrouted)
      .where(
        and(
          eq(inbound_unrouted.status, 'pending'),
          lt(inbound_unrouted.received_at, cutoff),
          gt(inbound_unrouted.expires_at, new Date()),
        ),
      )
      .orderBy(inbound_unrouted.received_at)
      .limit(limit);
  },

  /** TTL de 72h: expira pendentes vencidas (sweeper). */
  async expireOverdue(limit: number): Promise<Array<{ id: string; enc_key_id: string }>> {
    const result = await db.execute<{ id: string; enc_key_id: string }>(sql`
      WITH vencidas AS (
        SELECT id FROM inbound_unrouted
         WHERE status = 'pending' AND expires_at <= now()
         ORDER BY expires_at
         LIMIT ${limit}
      )
      UPDATE inbound_unrouted u
         SET status = 'expired'
        FROM vencidas
       WHERE u.id = vencidas.id
       RETURNING u.id, u.enc_key_id
    `);
    return [...result.rows];
  },

  /**
   * Canário da regra operacional de rotação (§1.4): uma chave só sai do
   * keyring quando NENHUMA row pending a referencia. O sweeper compara este
   * conjunto com o keyring corrente e grita se alguém removeu cedo demais.
   */
  async listPendingKeyIds(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ enc_key_id: inbound_unrouted.enc_key_id })
      .from(inbound_unrouted)
      .where(
        and(
          eq(inbound_unrouted.status, 'pending'),
          gt(inbound_unrouted.expires_at, new Date()),
        ),
      );
    return rows.map((r) => r.enc_key_id);
  },
};
