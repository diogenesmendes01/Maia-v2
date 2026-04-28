import { readFile } from 'node:fs/promises';
import { sha256, uuid } from '@/lib/utils.js';
import { parseOFX } from '@/import/ofx-parser.js';
import { parseCSV } from '@/import/csv-parser.js';
import { reconcile } from '@/import/reconciler.js';
import { db } from '@/db/client.js';
import { contas_bancarias, import_runs, import_entries } from '@/db/schema.js';
import { eq } from 'drizzle-orm';

function arg(name: string): string | undefined {
  const flag = `--${name}=`;
  for (const a of process.argv) if (a.startsWith(flag)) return a.slice(flag.length);
  return undefined;
}

async function main() {
  const file = arg('file');
  const conta = arg('conta');
  const pessoa_id = arg('pessoa') ?? 'system';
  if (!file || !conta) {
    console.error('usage: npm run import:ofx -- --file=path.ofx --conta=<conta_id_or_apelido>');
    process.exit(2);
  }
  const buf = await readFile(file);
  const text = buf.toString('utf8');
  const arquivo_sha256 = sha256(buf);

  const { contas_bancarias: tbl } = await import('@/db/schema.js');
  void tbl;
  const contaRows = await db.select().from(contas_bancarias);
  const contaRow =
    contaRows.find((c) => c.id === conta) ?? contaRows.find((c) => c.apelido === conta);
  if (!contaRow) {
    console.error(`conta not found: ${conta}`);
    process.exit(1);
  }

  // Skip if already imported
  const existing = await db
    .select()
    .from(import_runs)
    .where(eq(import_runs.arquivo_sha256, arquivo_sha256));
  const dup = existing.find((r) => r.conta_id === contaRow.id);
  if (dup) {
    console.log(`already imported as run ${dup.id}, status=${dup.status}`);
    process.exit(0);
  }

  const isOfx = /<OFX/i.test(text);
  const parsed = isOfx ? parseOFX(text) : null;
  const csv = isOfx ? null : parseCSV(text);
  const entries = parsed?.entries ?? csv?.entries ?? [];
  const fonte = isOfx ? 'ofx' : 'csv';

  const recon = await reconcile({
    conta_id: contaRow.id,
    entidade_id: contaRow.entidade_id,
    pessoa_id,
    entries,
  });

  const matched = recon.filter((r) => r.status === 'matched').length;
  const candidates = recon.filter((r) => r.status === 'candidate').length;
  const novos = recon.filter((r) => r.status === 'new').length;

  const run_id = uuid();
  await db.insert(import_runs).values({
    id: run_id,
    pessoa_id,
    entidade_id: contaRow.entidade_id,
    conta_id: contaRow.id,
    fonte,
    arquivo_sha256,
    arquivo_nome: file,
    periodo_de: parsed?.periodo_de ?? null,
    periodo_ate: parsed?.periodo_ate ?? null,
    total_lancamentos: entries.length,
    matched,
    candidates,
    novos,
    status: 'pending_review',
    metadata: csv ? { csv_profile: csv.profile } : {},
  });

  if (recon.length > 0) {
    await db.insert(import_entries).values(
      recon.map((r, i) => ({
        import_run_id: run_id,
        ordem: i + 1,
        tipo_oper: r.entry.tipo_oper,
        valor: r.entry.valor.toFixed(2),
        data_oper: r.entry.data_oper,
        fitid: r.entry.fitid ?? null,
        memo: r.entry.memo ?? null,
        contraparte_raw: r.entry.contraparte_raw ?? null,
        status: r.status,
        matched_transacao_id: r.matched?.transacao_id ?? null,
        candidates: r.candidates ?? null,
      })),
    );
  }

  console.log(
    `imported run=${run_id}: total=${entries.length}, matched=${matched}, candidates=${candidates}, new=${novos}`,
  );
  console.log('status: pending_review — abra o app e revise pelo WhatsApp');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
