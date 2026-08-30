/**
 * Issue #510 (fatia B) — o filho MÍNIMO que para num failpoint.
 *
 * Ele não fala com banco nem com fila: existe só para que os self-tests do
 * transporte possam afirmar a propriedade que nenhum teste in-process consegue
 * — enquanto o gate não é liberado, o processo NÃO AVANÇA UMA LINHA.
 *
 * As três marcas de stdout são o instrumento:
 *
 *   `##fi-antes##`   impressa ANTES do failpoint;
 *   `##fi-depois##`  impressa DEPOIS — a que nunca aparece num `SIGKILL`;
 *   `##fi-finally##` impressa no `finally` — a que separa `SIGKILL` de `throw`.
 *
 * O `finally` é o DISCRIMINADOR do cenário de morte: sem ele, "o filho não
 * imprimiu `##fi-depois##`" também passaria num fixture que simplesmente não
 * tem nada depois do gate.
 */
import { alcancar } from '../harness/failpoint-client.js';

const LINHA_PRONTO = '##harness-ready##';

function emitir(prefixo: string, carga: Record<string, unknown> = {}): void {
  process.stdout.write(`${prefixo} ${JSON.stringify(carga)}\n`);
}

async function main(): Promise<void> {
  emitir(LINHA_PRONTO, { pid: process.pid });
  try {
    emitir('##fi-antes##', { etapa: 'antes' });
    const acao = await alcancar(
      'after_turn_claim_before_running',
      { etapa: 'antes', pid: process.pid },
      { timeoutMs: 120_000 },
    );
    emitir('##fi-depois##', { acao });
  } finally {
    emitir('##fi-finally##', {});
  }
}

main().catch((erro: unknown) => {
  process.stdout.write(
    `##harness-fatal## ${JSON.stringify({ erro: erro instanceof Error ? erro.message : String(erro) })}\n`,
  );
  process.exitCode = 1;
});
