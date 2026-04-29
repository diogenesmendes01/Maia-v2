/**
 * Spec 13 reconciliation UX (CLI). After `npm run import:ofx` creates an
 * import_run with status='pending_review', this script lists pending runs
 * and applies them.
 *
 *   npm run import:list                 # list pending runs
 *   npm run import:show -- --run=<id>   # detail: per-entry status
 *   npm run import:apply -- --run=<id>  # auto-apply matched + create new
 *                                       # candidates remain pending unless
 *                                       # --candidates=accept|reject is passed
 */
import { db } from '@/db/client.js';
import { import_runs, import_entries, transacoes } from '@/db/schema.js';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { audit } from '@/governance/audit.js';
import type { ImportEntry } from '@/db/schema.js';

function arg(name: string): string | undefined {
  const flag = `--${name}=`;
  for (const a of process.argv) if (a.startsWith(flag)) return a.slice(flag.length);
  return undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function listRuns(): Promise<void> {
  const rows = await db
    .select()
    .from(import_runs)
    .where(eq(import_runs.status, 'pending_review'))
    .orderBy(import_runs.created_at);
  if (rows.length === 0) {
    console.log('no pending runs');
    return;
  }
  console.log('pending import runs:');
  for (const r of rows) {
    console.log(
      `  ${r.id}  ${r.fonte}  ${r.arquivo_nome ?? '?'}  total=${r.total_lancamentos} matched=${r.matched} cand=${r.candidates} new=${r.novos}`,
    );
  }
}

async function showRun(run_id: string): Promise<void> {
  const run = (await db.select().from(import_runs).where(eq(import_runs.id, run_id)).limit(1))[0];
  if (!run) {
    console.error(`run ${run_id} not found`);
    process.exit(1);
  }
  console.log(`run ${run.id} — status=${run.status}`);
  console.log(`  conta=${run.conta_id} entidade=${run.entidade_id}`);
  console.log(`  total=${run.total_lancamentos} matched=${run.matched} cand=${run.candidates} new=${run.novos}`);
  const entries = await db
    .select()
    .from(import_entries)
    .where(eq(import_entries.import_run_id, run.id))
    .orderBy(import_entries.ordem);
  console.log(`entries (${entries.length}):`);
  for (const e of entries) {
    const tag = e.status.padEnd(10);
    const sign = e.tipo_oper === 'credit' ? '+' : '-';
    console.log(
      `  #${String(e.ordem).padStart(3)} ${tag} ${e.data_oper} ${sign}R$ ${e.valor}  ${e.memo ?? e.contraparte_raw ?? ''}`,
    );
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ApplyTotals = { confirmed: number; created: number; candidatesSettled: number; skipped: number };

async function applyMatchedTo(
  tx: Tx,
  e: ImportEntry,
  transacao_id: string,
  run_id: string,
): Promise<void> {
  // Per spec 13: when a bank statement entry confirms an existing transacao,
  // overwrite data_pagamento with the bank's date, set status to its terminal
  // value, and merge the FITID into metadata so future imports can dedup.
  const status = e.tipo_oper === 'credit' ? 'recebida' : 'paga';
  await tx
    .update(transacoes)
    .set({
      data_pagamento: e.data_oper,
      status,
      confirmada_em: new Date(),
      updated_at: new Date(),
      metadata: sql`coalesce(${transacoes.metadata}, '{}'::jsonb) || ${JSON.stringify({
        fitid: e.fitid ?? null,
        import_run_id: run_id,
      })}::jsonb`,
    })
    .where(eq(transacoes.id, transacao_id));
}

async function applyRun(
  run_id: string,
  candidatesPolicy: 'accept' | 'reject' | 'skip',
): Promise<void> {
  const run = (await db.select().from(import_runs).where(eq(import_runs.id, run_id)).limit(1))[0];
  if (!run) {
    console.error(`run ${run_id} not found`);
    process.exit(1);
  }
  if (run.status !== 'pending_review') {
    console.error(`run is ${run.status}, cannot apply`);
    process.exit(1);
  }

  // Wrap the entire apply in a single DB transaction so a partial failure
  // doesn't leave entries half-applied (e.g., a transacao inserted but
  // import_entries.resolved_at not set, which would cause the next run to
  // duplicate it).
  const totals: ApplyTotals = await db.transaction(async (tx) => {
    const entries = await tx
      .select()
      .from(import_entries)
      .where(eq(import_entries.import_run_id, run.id));

    const t: ApplyTotals = { confirmed: 0, created: 0, candidatesSettled: 0, skipped: 0 };

    for (const e of entries) {
      if (e.resolved_at) {
        t.skipped++;
        continue;
      }

      if (e.status === 'matched') {
        if (!e.matched_transacao_id) {
          // Inconsistent — matched without a transacao_id. Leave for review.
          t.skipped++;
          continue;
        }
        await applyMatchedTo(tx, e, e.matched_transacao_id, run.id);
        await tx
          .update(import_entries)
          .set({ resolved_at: new Date() })
          .where(eq(import_entries.id, e.id));
        t.confirmed++;
        continue;
      }

      if (e.status === 'new') {
        const status = e.tipo_oper === 'credit' ? 'recebida' : 'paga';
        const inserted = await tx
          .insert(transacoes)
          .values({
            entidade_id: run.entidade_id,
            conta_id: run.conta_id,
            natureza: e.tipo_oper === 'credit' ? 'receita' : 'despesa',
            valor: e.valor,
            data_competencia: e.data_oper,
            data_pagamento: e.data_oper,
            status,
            descricao: e.memo ?? e.contraparte_raw ?? 'extrato',
            contraparte: e.contraparte_raw,
            origem: 'extrato',
            registrado_por: run.pessoa_id,
            metadata: { import_run_id: run.id, fitid: e.fitid ?? null },
            confirmada_em: new Date(),
          })
          .returning({ id: transacoes.id });
        await tx
          .update(import_entries)
          .set({
            resolved_at: new Date(),
            matched_transacao_id: inserted[0]!.id,
            status: 'matched',
          })
          .where(eq(import_entries.id, e.id));
        t.created++;
        continue;
      }

      if (e.status === 'candidate') {
        if (candidatesPolicy === 'accept') {
          const top = (e.candidates as Array<{ transacao_id: string }> | null)?.[0];
          if (!top) {
            t.skipped++;
            continue;
          }
          await applyMatchedTo(tx, e, top.transacao_id, run.id);
          await tx
            .update(import_entries)
            .set({
              status: 'matched',
              matched_transacao_id: top.transacao_id,
              resolved_at: new Date(),
            })
            .where(eq(import_entries.id, e.id));
          t.candidatesSettled++;
        } else if (candidatesPolicy === 'reject') {
          await tx
            .update(import_entries)
            .set({ status: 'rejected', resolved_at: new Date() })
            .where(eq(import_entries.id, e.id));
          t.candidatesSettled++;
        } else {
          t.skipped++;
        }
        continue;
      }

      // status='rejected' or unknown — already terminal, just count.
      t.skipped++;
    }

    // Run is `aplicado` only when *every* entry has resolved_at set —
    // not just when no candidates remain. A matched entry that failed to
    // apply (e.g., missing matched_transacao_id) must keep the run in
    // pending_review so the operator can fix it.
    const unresolved = await tx
      .select({ id: import_entries.id })
      .from(import_entries)
      .where(and(eq(import_entries.import_run_id, run.id), isNull(import_entries.resolved_at)));

    const newStatus = unresolved.length === 0 ? 'aplicado' : 'pending_review';
    await tx
      .update(import_runs)
      .set({ status: newStatus, updated_at: new Date() })
      .where(eq(import_runs.id, run.id));

    return t;
  });

  await audit({
    acao: 'transaction_created',
    pessoa_id: run.pessoa_id,
    alvo_id: run.id,
    metadata: {
      import_run: true,
      confirmed: totals.confirmed,
      created: totals.created,
      candidatesSettled: totals.candidatesSettled,
      skipped: totals.skipped,
    },
  });

  // Re-read final status for the log line — the transaction has committed.
  const after = (await db.select().from(import_runs).where(eq(import_runs.id, run.id)).limit(1))[0];
  console.log(
    `applied run ${run.id}: confirmed=${totals.confirmed} created=${totals.created} candidates=${totals.candidatesSettled} skipped=${totals.skipped} status=${after?.status ?? '?'}`,
  );
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'list' || flag('list')) {
    await listRuns();
    process.exit(0);
  }
  const run_id = arg('run');
  if (!run_id) {
    console.error('usage: npm run import:list | import:show -- --run=<id> | import:apply -- --run=<id> [--candidates=accept|reject]');
    process.exit(2);
  }
  if (cmd === 'show' || flag('show')) {
    await showRun(run_id);
    process.exit(0);
  }
  if (cmd === 'apply' || flag('apply')) {
    const policy = (arg('candidates') ?? 'skip') as 'accept' | 'reject' | 'skip';
    if (!['accept', 'reject', 'skip'].includes(policy)) {
      console.error(`invalid --candidates: ${policy}`);
      process.exit(2);
    }
    await applyRun(run_id, policy);
    process.exit(0);
  }
  console.error('unknown command');
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
