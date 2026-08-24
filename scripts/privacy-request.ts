/**
 * `npm run privacy:execute -- --request=<uuid> --phone=+55...`
 * `npm run privacy:execute -- --request=<uuid> --person-id=<uuid>`
 *
 * Issue #536 §2 — executa um pedido de privacidade JÁ APROVADO.
 *
 * O identificador do titular vem do operador porque `privacy_requests.
 * subject_ref` é pseudônimo de mão única: o banco reconhece o titular, não o
 * enumera. O executor confere o identificador informado contra o `subject_ref`
 * gravado e RECUSA quando não bate — sem essa conferência, um erro de digitação
 * executaria uma exclusão irreversível em nome de outra pessoa.
 *
 * Este comando NÃO aprova nada. Um pedido que não esteja `approved`, com
 * aprovador e identidade registrados, é recusado — a aprovação humana é o que
 * separa uma exclusão irreversível de um bug com permissão de escrita.
 *
 * Códigos de saída:
 *   0  concluído (exclusão executada, ou export cifrado emitido)
 *   1  negado (legal hold), falhou, ou outra execução detém o lock
 *   2  uso incorreto / pedido inexistente
 */
import { runPrivacyRequestJob } from '@/workers/privacy.js';
import type { SubjectIdentifier } from '@/ops/privacy/workflow.js';

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function run(): Promise<number> {
  const requestId = arg('request');
  const phone = arg('phone');
  const personId = arg('person-id');

  if (!requestId || (!phone && !personId) || (phone && personId)) {
    console.error('uso: --request=<uuid> e EXATAMENTE um de --phone=+55... | --person-id=<uuid>');
    return 2;
  }

  const identifier: SubjectIdentifier = phone
    ? { kind: 'phone_e164', value: phone }
    : { kind: 'person_id', value: personId as string };

  const outcome = await runPrivacyRequestJob(requestId, identifier);

  if (outcome.status === 'not_found') {
    console.error('pedido não encontrado');
    return 2;
  }
  if (outcome.status === 'already_running') {
    console.log('outra execução de retenção/privacidade detém o lock — nada foi iniciado');
    return 1;
  }

  const r = outcome.result;
  // Contagens e códigos. O identificador do titular NÃO é impresso: esta saída
  // vai para o terminal do operador e, muitas vezes, para um ticket.
  console.log(`pedido ${r.request_id}: ${r.status}${r.reason_code ? ` (${r.reason_code})` : ''}`);
  for (const [klass, n] of Object.entries(r.purged)) {
    console.log(`  ${klass}: ${n}`);
  }
  for (const e of r.exceptions) {
    console.log(`  EXCEÇÃO ${e.data_class}: ${e.reason}`);
  }
  if (r.export_issued) {
    console.log('export cifrado emitido — o locator está em privacy_requests.export_locator.');
  }

  if (r.status === 'completed') return 0;
  console.error(
    r.reason_code === 'legal_hold'
      ? 'NEGADO por legal hold ativo: nada foi apagado. Um hold vence o apagamento — ' +
          'libere o hold pelo procedimento próprio antes de reabrir o pedido.'
      : `FALHOU (${r.reason_code}). Os tombstones já gravados FICAM e descrevem a intenção; ` +
          'a reaplicação pós-restore termina o serviço. Inspecione privacy_requests.evidence.',
  );
  return 1;
}

run()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`execução abortou: ${(err as Error).name}`);
    process.exit(1);
  });
