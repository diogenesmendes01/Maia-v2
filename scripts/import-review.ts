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
import { eq, and } from 'drizzle-orm';
import { audit } from '@/governance/audit.js';

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

  const entries = await db
    .select()
    .from(import_entries)
    .where(
      and(
        eq(import_entries.import_run_id, run.id),
        // Only operate on unresolved entries.
      ),
    );

  let confirmed = 0;
  let created = 0;
  let candidatesSettled = 0;
  let skipped = 0;

  for (const e of entries) {
    if (e.resolved_at) {
      skipped++;
      continue;
    }
    if (e.status === 'matched' && e.matched_transacao_id) {
      // Mark the transacao as confirmed (extrato bancário is the canonical proof).
      await db
        .update(transacoes)
        .set({ confirmada_em: new Date(), updated_at: new Date() })
        .where(eq(transacoes.id, e.matched_transacao_id));
      await db
        .update(import_entries)
        .set({ resolved_at: new Date() })
        .where(eq(import_entries.id, e.id));
      confirmed++;
      continue;
    }
    if (e.status === 'new') {
      // Create a transacao from the entry (no contraparte resolution; manual review later).
      const tx = await db
        .insert(transacoes)
        .values({
          entidade_id: run.entidade_id,
          conta_id: run.conta_id,
          natureza: e.tipo_oper === 'credit' ? 'receita' : 'despesa',
          valor: e.valor,
          data_competencia: e.data_oper,
          data_pagamento: e.data_oper,
          status: 'paga',
          descricao: e.memo ?? e.contraparte_raw ?? 'extrato',
          contraparte: e.contraparte_raw,
          origem: 'extrato',
          registrado_por: run.pessoa_id,
          metadata: { import_run_id: run.id, fitid: e.fitid },
          confirmada_em: new Date(),
        })
        .returning({ id: transacoes.id });
      await db
        .update(import_entries)
        .set({ resolved_at: new Date(), matched_transacao_id: tx[0]!.id, status: 'matched' })
        .where(eq(import_entries.id, e.id));
      created++;
      continue;
    }
    if (e.status === 'candidate') {
      if (candidatesPolicy === 'accept') {
        const top = (e.candidates as Array<{ transacao_id: string }> | null)?.[0];
        if (top) {
          await db
            .update(transacoes)
            .set({ confirmada_em: new Date(), updated_at: new Date() })
            .where(eq(transacoes.id, top.transacao_id));
          await db
            .update(import_entries)
            .set({
              status: 'matched',
              matched_transacao_id: top.transacao_id,
              resolved_at: new Date(),
            })
            .where(eq(import_entries.id, e.id));
          candidatesSettled++;
        }
      } else if (candidatesPolicy === 'reject') {
        await db
          .update(import_entries)
          .set({ status: 'rejected', resolved_at: new Date() })
          .where(eq(import_entries.id, e.id));
        candidatesSettled++;
      } else {
        skipped++;
      }
    }
  }

  const allResolved = await db
    .select()
    .from(import_entries)
    .where(
      and(eq(import_entries.import_run_id, run.id), eq(import_entries.status, 'candidate')),
    );

  const newStatus = allResolved.length === 0 ? 'aplicado' : 'pending_review';
  await db
    .update(import_runs)
    .set({ status: newStatus, updated_at: new Date() })
    .where(eq(import_runs.id, run.id));

  await audit({
    acao: 'transaction_created',
    pessoa_id: run.pessoa_id,
    alvo_id: run.id,
    metadata: { import_run: true, confirmed, created, candidatesSettled, skipped },
  });

  console.log(
    `applied run ${run.id}: confirmed=${confirmed} created=${created} candidates=${candidatesSettled} skipped=${skipped} status=${newStatus}`,
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
