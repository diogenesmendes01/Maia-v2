import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { pending_questions } from '@/db/schema.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { sendOutboundText, isBaileysConnected } from '@/gateway/baileys.js';
import { audit } from '@/governance/audit.js';
import { quotedReplyContext } from '@/gateway/presence.js';

const SCAN_LIMIT = 50;
const MAX_REMINDERS = 2;

type Row = {
  id: string;
  tipo: string;
  pergunta: string;
  telefone_whatsapp: string;
  outbound_metadata: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
};

export async function runPendingReminder(): Promise<void> {
  if (!config.FEATURE_PENDING_REMINDER) return;
  if (!isBaileysConnected()) {
    logger.debug('pending_reminder.baileys_disconnected_skip');
    return;
  }

  const result = await db.execute<Row>(sql`
    SELECT
      pq.id,
      pq.tipo,
      pq.pergunta,
      p.telefone_whatsapp,
      m.metadata AS outbound_metadata,
      pq.metadata AS metadata
    FROM pending_questions pq
    JOIN pessoas p ON p.id = pq.pessoa_id
    LEFT JOIN mensagens m
      ON m.direcao = 'out'
     AND (m.metadata->>'pending_question_id') = pq.id::text
    WHERE pq.status = 'aberta'
      AND pq.expira_em > now()
      AND pq.tipo != 'edit_review'
      AND pq.created_at < now() - interval '1 hour'
      AND COALESCE((pq.metadata->>'reminder_count')::int, 0) < ${MAX_REMINDERS}
      AND (
        pq.metadata->>'last_reminder_at' IS NULL
        OR (pq.metadata->>'last_reminder_at')::timestamptz < now() - interval '1 hour'
      )
    ORDER BY pq.created_at ASC
    LIMIT ${SCAN_LIMIT}
  `);

  for (const row of result.rows) {
    await processOne(row).catch((err) =>
      logger.warn({ err: (err as Error).message, pq_id: row.id }, 'pending_reminder.row_failed'),
    );
  }
}

async function processOne(row: Row): Promise<void> {
  if (!row.outbound_metadata) {
    await audit({
      acao: 'pending_reminder_skipped_no_outbound',
      alvo_id: row.id,
      metadata: { tipo: row.tipo },
    });
    return;
  }

  const quoted = quotedReplyContext(row.outbound_metadata, row.pergunta);
  if (!quoted) {
    await audit({
      acao: 'pending_reminder_skipped_no_outbound',
      alvo_id: row.id,
      metadata: { reason: 'invalid_metadata' },
    });
    return;
  }

  // Update last_reminder_at + reminder_count BEFORE send (idempotency: never
  // double-send). On send failure the timestamp is already advanced.
  const newCount = ((row.metadata.reminder_count as number | undefined) ?? 0) + 1;
  const newMeta = {
    ...row.metadata,
    last_reminder_at: new Date().toISOString(),
    reminder_count: newCount,
  };
  await db
    .update(pending_questions)
    .set({ metadata: newMeta })
    .where(eq(pending_questions.id, row.id));

  const jid = quoted.key.remoteJid;
  try {
    await sendOutboundText(jid, 'Lembra dessa? Tô aguardando.', { quoted });
    await audit({
      acao: 'pending_reminder_sent',
      alvo_id: row.id,
      metadata: { reminder_count: newCount },
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, pq_id: row.id },
      'pending_reminder.send_failed',
    );
  }
}
