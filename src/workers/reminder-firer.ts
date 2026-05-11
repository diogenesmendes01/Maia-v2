import { sql, eq, and, desc } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { mensagens } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { sendOutboundText, isBaileysConnected } from '@/gateway/baileys.js';
import { pessoasRepo, mensagensRepo, factsRepo } from '@/db/repositories.js';

const SCAN_LIMIT = 50;

type DueRow = {
  id: string;
  escopo: string;
  chave: string;
  valor: Record<string, unknown>;
};

/**
 * Resolve the JID to reach a pessoa. Prefers the `metadata.remote_jid` of
 * the most recent inbound message we received from them — which correctly
 * preserves `@lid` privacy thread routing — and falls back to the
 * phone-derived `phone@s.whatsapp.net` when no inbound exists yet.
 */
async function jidForPessoa(telefone: string): Promise<string> {
  try {
    const rows = await db
      .select({ metadata: mensagens.metadata })
      .from(mensagens)
      .where(
        and(eq(mensagens.direcao, 'in'), sql`metadata->>'telefone' = ${telefone}`),
      )
      .orderBy(desc(mensagens.created_at))
      .limit(1);
    const rj = (rows[0]?.metadata as Record<string, unknown> | null)?.['remote_jid'];
    if (typeof rj === 'string' && rj.length > 0) return rj;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tel: '[REDACTED]' },
      'reminder_firer.jid_lookup_failed_falling_back',
    );
  }
  return telefone.replace('+', '') + '@s.whatsapp.net';
}

/**
 * Cron handler. Scans `agent_facts` for reminder rows whose `valor.quando`
 * has passed and `valor.fired_at` is still null, then fires each via
 * WhatsApp. Idempotency: `fired_at` is written BEFORE the send, so a send
 * crash leaves the row inert (DLQ + audit catch the failure).
 *
 * Graceful skip when Baileys is disconnected — the next tick (≤60s after
 * reconnect) drains the backlog in chronological order.
 */
export async function runReminderFirer(): Promise<void> {
  if (!isBaileysConnected()) {
    logger.debug('reminder_firer.baileys_disconnected_skip');
    return;
  }

  const result = await db.execute<DueRow>(sql`
    SELECT id, escopo, chave, valor
    FROM agent_facts
    WHERE chave LIKE 'reminder.%'
      AND (valor->>'fired_at') IS NULL
      AND (valor->>'quando')::timestamptz <= now()
    ORDER BY (valor->>'quando')::timestamptz ASC
    LIMIT ${SCAN_LIMIT}
  `);

  for (const row of result.rows) {
    await fireOne(row).catch((err) =>
      logger.warn(
        { err: (err as Error).message, fact_id: row.id },
        'reminder_firer.row_failed',
      ),
    );
  }
}

async function fireOne(row: DueRow): Promise<void> {
  const reminder_id = (row.valor['id'] as string | undefined) ?? row.chave.replace(/^reminder\./, '');
  const pessoa_id = row.valor['pessoa_id'] as string | undefined;
  const quando = row.valor['quando'] as string | undefined;
  const texto = row.valor['texto'] as string | undefined;
  if (!pessoa_id || !quando || !texto) {
    await markFired(row, { skip_reason: 'malformed_valor' });
    await audit({
      acao: 'reminder_skipped',
      alvo_id: row.id,
      metadata: { reminder_id, skip_reason: 'malformed_valor' },
    });
    return;
  }

  const pessoa = await pessoasRepo.findById(pessoa_id);
  if (!pessoa || pessoa.status !== 'ativa') {
    await markFired(row, { skip_reason: pessoa ? `status_${pessoa.status}` : 'pessoa_missing' });
    await audit({
      acao: 'reminder_skipped',
      pessoa_id: pessoa?.id ?? null,
      alvo_id: row.id,
      metadata: {
        reminder_id,
        skip_reason: pessoa ? `status_${pessoa.status}` : 'pessoa_missing',
      },
    });
    return;
  }

  // Mark fired BEFORE send. If send fails, the row is already inert and
  // the failure surfaces via audit + DLQ — never double-fire on retry.
  const lateMs = Date.now() - new Date(quando).getTime();
  const late_minutes = Math.max(0, Math.floor(lateMs / 60_000));
  await markFired(row, { late_minutes });

  const jid = await jidForPessoa(pessoa.telefone_whatsapp);
  const body = `🔔 Lembrete: ${texto}`;

  try {
    const wid = await sendOutboundText(jid, body);
    await mensagensRepo.create({
      conversa_id: null,
      direcao: 'out',
      tipo: 'texto',
      conteudo: body,
      midia_url: null,
      metadata: { whatsapp_id: wid, remote_jid: jid, reminder_id },
      processada_em: new Date(),
      ferramentas_chamadas: [],
      tokens_usados: null,
    });
    await audit({
      acao: 'reminder_fired',
      pessoa_id: pessoa.id,
      alvo_id: row.id,
      metadata: { reminder_id, late_minutes },
    });
  } catch (err) {
    await audit({
      acao: 'reminder_send_failed',
      pessoa_id: pessoa.id,
      alvo_id: row.id,
      metadata: { reminder_id, error: (err as Error).message },
    });
    logger.warn(
      { err: (err as Error).message, reminder_id, pessoa_id: pessoa.id },
      'reminder_firer.send_failed',
    );
  }
}

async function markFired(row: DueRow, extra: Record<string, unknown>): Promise<void> {
  const valor = { ...row.valor, fired_at: new Date().toISOString(), ...extra };
  await factsRepo.upsert({
    escopo: row.escopo,
    chave: row.chave,
    valor,
    fonte: 'configurado',
  });
}
