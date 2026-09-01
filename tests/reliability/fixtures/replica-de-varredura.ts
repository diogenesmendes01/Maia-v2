/**
 * Issue #510 (fatia F) — uma RÉPLICA DA VARREDURA DE RECUPERAÇÃO do outbox.
 *
 * ─── O que ela roda, e por que não é uma reimplementação ────────────────────
 *
 * `runOutboundRecoveryForScope` (`src/workers/outbound-recovery.ts`) é o corpo
 * do worker `outbound_recovery` — exportado pela própria produção "para que o
 * teste de integração entre pelo MESMO caminho da produção, com o contexto de
 * tenant já aberto pelo chamador". É ele que rearma o entregável, reconcilia o
 * incerto e manda para a DLQ o que estourou o teto.
 *
 * O filho NÃO decide nada: ele abre o contexto do tenant e chama a função. Se
 * ele montasse o próprio `UPDATE`, FI-08 continuaria verde depois de alguém
 * apagar o `AND status IN (…)` de `deadLetterTx` — provaria o SQL do fixture.
 *
 * ─── Por que o LOTE é lido e ANUNCIADO antes da barreira ────────────────────
 *
 * "Dois sweepers sobre o mesmo lote" é a premissa de FI-08, e uma premissa não
 * verificada é como um cenário de concorrência vira vácuo: se a réplica B
 * chegasse depois de A ter terminado, ela veria lista VAZIA, não faria nada, e
 * "uma auditoria por linha" passaria sem que corrida nenhuma tivesse
 * acontecido. Por isso cada réplica LÊ o lote, ANUNCIA os ids que viu, e só
 * então espera na barreira — o cenário cobra que os dois anúncios sejam o mesmo
 * conjunto antes de dar a largada.
 *
 * A leitura é a de produção (`outboundRecoveryRepo.listDeliverable`), é
 * somente-leitura e não consome nada: a varredura relista por conta própria
 * logo depois.
 *
 * ─── Protocolo de saída (stdout, uma linha por evento) ──────────────────────
 *
 *   ##fi-lote## {…}         os ids que ESTA réplica viu, antes da largada
 *   ##fi-varredura## {…}    as estatísticas devolvidas pela varredura
 *   ##harness-ready## {…}   handshake, DEPOIS da varredura (com as estatísticas)
 */
import { runWithTenantContext } from '@/db/tenant-context.js';
import { outboundRecoveryRepo } from '@/db/repositories/outbound-recovery-repo.js';
import { runOutboundRecoveryForScope } from '@/workers/outbound-recovery.js';
import { barreira } from '../harness/failpoint-client.js';

const LINHA_PRONTO = '##harness-ready##';
const LINHA_FATAL = '##harness-fatal##';

function emitir(prefixo: string, carga: Record<string, unknown>): void {
  process.stdout.write(`${prefixo} ${JSON.stringify(carga)}\n`);
}

function exigir(nome: string): string {
  const v = process.env[nome];
  if (!v) throw new Error(`${nome} ausente — o filho não sabe que escopo varrer`);
  return v;
}

function numero(nome: string, padrao: number): number {
  const v = process.env[nome];
  if (v === undefined || v === '') return padrao;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${nome}="${v}" não é número`);
  return n;
}

const tenant_id = exigir('TEST_FI_TENANT_ID');
const agent_id = exigir('TEST_FI_AGENT_ID');
const nomeDaBarreira = process.env.TEST_FI_BARREIRA ?? '';
/** Quantas varreduras rodar. >1 prova que o segundo tick é inerte. */
const ciclos = numero('TEST_FI_CICLOS', 1);

const noEscopo = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id, agent_id }, fn);

const dormir = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

let parar = false;
process.on('SIGTERM', () => {
  parar = true;
  process.exit(0);
});

async function main(): Promise<void> {
  const lote = await noEscopo(() => outboundRecoveryRepo.listDeliverable(200));
  emitir('##fi-lote##', {
    pid: process.pid,
    ids: lote.map((c) => c.outbound_id).sort(),
    estados: lote.map((c) => `${c.outbound_id}:${c.status}:${c.attempt}`).sort(),
  });

  // A LARGADA. Sem ela, a "corrida" seria decidida por quem terminou de
  // importar o grafo de módulos primeiro — o que não é corrida, é sorteio.
  if (nomeDaBarreira !== '') await barreira(nomeDaBarreira);

  // Nenhum failpoint aqui, e a ausência é decisão: o catálogo é a lista FECHADA
  // dos pontos que a PRODUÇÃO tem, e a varredura não tem nenhum deles no
  // caminho. Emprestar um nome de outro ponto ("before_successor_promotion",
  // que é da promoção de stream) para ganhar um gate faria o artefato do
  // cenário mentir sobre onde o processo estava parado. O que a corrida precisa
  // — largar as duas réplicas juntas — a barreira já dá.
  const rodadas: unknown[] = [];
  for (let i = 0; i < ciclos; i += 1) {
    const stats = await noEscopo(() => runOutboundRecoveryForScope({ tenant_id, agent_id }));
    emitir('##fi-varredura##', { ciclo: i + 1, ...stats });
    rodadas.push(stats);
  }

  emitir(LINHA_PRONTO, { pid: process.pid, ciclos, rodadas });

  while (!parar) await dormir(200);
}

main().catch((erro: unknown) => {
  emitir(LINHA_FATAL, {
    erro: erro instanceof Error ? erro.message : String(erro),
    nome: erro instanceof Error ? erro.name : 'desconhecido',
  });
  process.exitCode = 1;
});
