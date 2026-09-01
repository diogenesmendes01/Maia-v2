/**
 * Issue #510 (fatia F) — o punhado de coisas que TODO cenário FI repete.
 *
 * Três, e cada uma existe porque errá-la já custou uma suíte:
 *
 *  1. `CARREGADOR_TSX` — `--import tsx`, e NUNCA o CLI do tsx. O CLI spawna um
 *     NETO para aplicar os flags do loader, e o pid que o `ProcessSupervisor`
 *     registra passa a ser o do invólucro: o `SIGKILL` mata a casca enquanto o
 *     processo que segura a posse continua batendo heartbeat. A armadilha está
 *     documentada em `tests/reliability/README.md` (#513, fatia D).
 *
 *  2. `prontidaoDe` — o handshake COM a premissa cobrada (`carga.pid ===
 *     filho.pid`). Sem essa asserção, o item 1 volta em silêncio.
 *
 *  3. `linhasDe` — o parser das linhas estruturadas do filho, tolerante a
 *     chunk partido pelo pipe.
 *
 * `fi-claim-crash-fence.spec.ts` e `fi-outbound-entrega.spec.ts` (fatias B e C)
 * têm cópias locais destas três. Elas NÃO foram migradas para cá nesta fatia de
 * propósito: outra fatia está em voo sobre esses arquivos, e um refactor de
 * conveniência que colida com ela custaria mais do que a duplicação.
 *
 * Este arquivo NÃO é uma spec (não casa com `*.spec.ts`), então o runner não o
 * coleta como suíte vazia.
 */
import { expect } from 'vitest';
import type { SupervisedChild } from '../harness/process-supervisor.js';

/** `--import tsx`: o loader entra no MESMO processo. Ver o cabeçalho. */
export const CARREGADOR_TSX = '--import tsx';

/** Toda linha estruturada de um prefixo, já parseada. */
export function linhasDe(
  filho: SupervisedChild,
  prefixo: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const linha of filho.stdout.split('\n')) {
    const t = linha.trim();
    if (!t.startsWith(prefixo)) continue;
    try {
      out.push(JSON.parse(t.slice(prefixo.length).trim()) as Record<string, unknown>);
    } catch {
      // Linha partida pelo chunk: o próximo pedaço a completa.
    }
  }
  return out;
}

/** A carga do handshake, com a premissa de todo `SIGKILL` desta lane cobrada. */
export async function prontidaoDe(
  filho: SupervisedChild,
  timeoutMs = 45_000,
): Promise<Record<string, unknown> & { acquired?: boolean }> {
  const carga = await filho.esperarPronto(timeoutMs);
  expect(
    carga.pid,
    'o pid anunciado pelo filho não é o pid supervisionado — o SIGKILL mataria um invólucro',
  ).toBe(filho.pid);
  return carga;
}
