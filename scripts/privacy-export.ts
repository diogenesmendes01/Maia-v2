/**
 * `npm run privacy:export -- show --request=<uuid>`
 * `npm run privacy:export -- sweep [--dry-run] `
 *
 * Issue #536 — o TTL do export de privacidade, do lado do operador.
 *
 * `show` responde a pergunta que o pedido passou a saber responder: o artefato
 * ainda existe, já venceu, ou já foi varrido? Antes desta issue a resposta era
 * sempre "aqui está o locator", inclusive para um pacote que o prazo já
 * condenava e para um que o varredor já tinha apagado — o operador ia buscar e
 * não achava, sem saber se aquilo era o TTL funcionando ou o sistema perdendo
 * um arquivo. São diagnósticos opostos.
 *
 * `sweep` roda um passe fora da hora do cron. Ele NÃO é a forma normal de
 * cumprir o TTL (o cron horário é), e existe para dois casos: esvaziar um
 * backlog depois de uma janela em que os workers estiveram parados, e conferir
 * o efeito com `--dry-run` antes de armar o executor num ambiente novo.
 *
 * O LOCATOR NUNCA É IMPRESSO EM `sweep`. A saída deste comando costuma ir para
 * um ticket, e uma lista de locators vencidos é um mapa dos pacotes que ainda
 * estão no disco.
 *
 * Códigos de saída:
 *   0  passe conclusivo (ou consulta respondida)
 *   1  passe não conclusivo (recusa, falha, hold ilegível) ou outro passe detém o lock
 *   2  uso incorreto / pedido inexistente
 */
import { runWithSystemContext } from '@/db/tenant-context.js';
import { readPrivacyExportRow } from '@/db/repositories/ops-repos.js';
import { readExportArtifact } from '@/ops/privacy/export-sweeper.js';
import { runPrivacyExportSweep } from '@/workers/privacy.js';

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function has(flag: string): boolean {
  return process.argv.slice(2).includes(`--${flag}`);
}

async function show(requestId: string): Promise<number> {
  const row = await runWithSystemContext(() => readPrivacyExportRow(requestId));
  if (row === null) {
    console.error('pedido não encontrado');
    return 2;
  }
  // A decisão do que o leitor pode ver é do módulo puro, não deste script: um
  // segundo lugar decidindo isso divergiria do primeiro.
  const view = readExportArtifact(row, new Date());
  console.log(`pedido ${row.request_id}`);
  console.log(`  artefato: ${view.state}`);
  console.log(`  vence em: ${view.expires_at?.toISOString() ?? '—'}`);
  console.log(`  varrido em: ${view.purged_at?.toISOString() ?? '—'}`);
  console.log(`  locator: ${view.locator ?? '— (indisponível neste estado)'}`);
  if (view.state === 'expired') {
    console.log(
      '  o prazo venceu: o pacote não é mais entregável ao titular. O varredor ' +
        'horário remove o arquivo; até lá o locator fica retido de propósito.',
    );
  }
  if (view.state === 'purged') {
    console.log(
      '  o artefato foi REMOVIDO pelo TTL. A trilha está em audit_log, ação ' +
        '`privacy_export_purged`. Reemitir exige um novo pedido de acesso.',
    );
  }
  return 0;
}

async function sweep(dryRun: boolean): Promise<number> {
  // Override POR CHAMADA. Reescrever `process.env` aqui não teria efeito
  // (`config` é validada no boot) e, se tivesse, mudaria o comportamento do
  // cron até o próximo restart.
  const outcome = await runPrivacyExportSweep(dryRun ? { dryRun: true } : {});
  if (outcome.status === 'already_running') {
    console.log('outro passe de varredura detém o lock — nada foi iniciado');
    return 1;
  }
  const r = outcome.result;
  console.log(`passe ${r.status}${dryRun ? ' (DRY-RUN: nada foi apagado)' : ''}`);
  console.log(`  varridos:        ${r.scanned}`);
  console.log(`  elegíveis:       ${r.eligible}`);
  console.log(`  removidos:       ${r.purged} (já ausentes: ${r.already_absent})`);
  console.log(`  congelados:      ${r.skipped_held} (legal hold)`);
  console.log(`  recusados:       ${r.refused}`);
  console.log(`  falharam:        ${r.failed}`);
  if (r.error_code) console.log(`  código:          ${r.error_code}`);

  if (r.refused > 0) {
    console.error(
      'RECUSA do guarda de locator: algum pedido carrega um locator que não ' +
        'corresponde a um artefato desta árvore. NADA foi apagado nesses casos. ' +
        'Veja audit_log, ação `privacy_export_purge_refused`, e o runbook ' +
        'docs/runbooks/privacy-export-ttl.md §4.',
    );
  }
  return r.status === 'completed' ? 0 : 1;
}

async function run(): Promise<number> {
  const command = process.argv[2];
  if (command === 'show') {
    const requestId = arg('request');
    if (!requestId) {
      console.error('uso: show --request=<uuid>');
      return 2;
    }
    return show(requestId);
  }
  if (command === 'sweep') return sweep(has('dry-run'));
  console.error('uso: privacy:export -- show --request=<uuid> | sweep [--dry-run]');
  return 2;
}

run()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // Só o NOME do erro: uma mensagem de driver carrega a URL de conexão com
    // senha (o vazamento real que a #520 encontrou no `pg_dump`).
    console.error(`comando abortou: ${(err as Error).name}`);
    process.exit(1);
  });
