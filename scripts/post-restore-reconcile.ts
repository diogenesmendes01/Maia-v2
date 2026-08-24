/**
 * `npm run restore:reconcile -- --backup-id=<uuid> --ledger-source=<live|export>`
 *
 * Issue #536 §3. O passo 6 do runbook (§3) deixa de ser "liste os tombstones
 * posteriores e reaplique cada exclusão" à mão e passa a ser este comando, que
 * usa o MESMO mecanismo de exclusão do workflow LGPD e o MESMO gate
 * (`canReleaseTraffic`) que o drill já avaliava em dry-run.
 *
 * `--ledger-source` é OBRIGATÓRIO e não tem default. Depois de um
 * `pg_restore`, o `data_tombstones` de dentro do banco restaurado é a cópia
 * ANTIGA do ledger: lê-lo produz um plano `ok` e vazio, que libera o tráfego
 * com todo o dado apagado de volta no ar. As linhas são idênticas às de um
 * ledger bom — só quem operou o restore sabe de onde elas vieram.
 *
 *   --ledger-source=live    o ledger foi lido de um banco ainda vivo (rollback)
 *                           ou de um export tirado ANTES do restore
 *   --ledger-source=export  idem, a partir de um export de ledger
 *
 * Códigos de saída:
 *   0  tráfego LIBERADO — todo tombstone pendente foi reaplicado e confirmado
 *   1  BLOQUEADO — o runtime não pode voltar a produção
 *   2  uso incorreto
 */
import { runPostRestoreReconciliationJob } from '@/workers/privacy.js';

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function run(): Promise<number> {
  const backupId = arg('backup-id');
  const source = arg('ledger-source');

  if (!backupId) {
    console.error('uso: --backup-id=<uuid do backup_runs que foi restaurado>');
    return 2;
  }
  if (source !== 'live' && source !== 'export') {
    console.error(
      '--ledger-source é obrigatório e vale `live` ou `export`. Ele afirma que o ledger NÃO ' +
        'veio de dentro do banco restaurado. Sem essa afirmação a reconciliação bloqueia, ' +
        'porque um ledger restaurado produz um plano vazio que parece sucesso — runbook §3.6.',
    );
    return 2;
  }

  const outcome = await runPostRestoreReconciliationJob({
    backup_id: backupId,
    ledger_independent: true,
  });

  if (outcome.status === 'already_running') {
    console.log('outra reconciliação detém o lock — nenhuma segunda foi iniciada');
    return 1;
  }

  const r = outcome.result;
  console.log(
    `reconciliação: aplicados=${r.applied_ids.length} falharam=${r.failed.length} ` +
      `motivo=${r.reason}`,
  );
  for (const [klass, n] of Object.entries(r.reapplied)) {
    console.log(`  ${klass}: ${n} linha(s) reaplicada(s)`);
  }
  for (const f of r.failed) {
    // Classe e código. O sujeito é pseudônimo e mesmo assim não é impresso.
    console.error(`  FALHOU ${f.data_class}: ${f.code}`);
  }

  if (r.release) {
    console.log('LIBERADO: todo tombstone pendente foi reaplicado e confirmado.');
    return 0;
  }
  console.error(
    `BLOQUEADO (${r.reason}): o runtime NÃO pode voltar a produção. ` +
      'Ver runbook §3.6 — liberar tráfego agora ressuscita dado que um titular mandou apagar.',
  );
  return 1;
}

run()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // Nunca ecoar o erro cru: mensagens de driver carregam a URL de conexão
    // com senha, exatamente como o stderr do `pg_dump`.
    console.error(`reconciliação abortou: ${(err as Error).name}`);
    process.exit(1);
  });
