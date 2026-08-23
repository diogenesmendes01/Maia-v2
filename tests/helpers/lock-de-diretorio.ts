/**
 * Issue #571 (revisão da PR #597) — exclusão mútua ENTRE PROCESSOS, em disco.
 *
 * ## Por que isto existe
 *
 * A reciclagem de um slot de db do Redis (`worktree-scope.ts`) é uma sequência
 * de três passos — observar o dono, apagar o arquivo de posse, criar o próprio —
 * e o `open(…, 'wx')` que fecha o terceiro passo NÃO protege os dois primeiros.
 * O interleaving que a revisão da PR #597 apontou é este:
 *
 *   A: lê o slot 3, conclui "abandonado"
 *   B: lê o slot 3, conclui "abandonado"      (mesma observação, sem lock)
 *   A: unlink(3); open(3,'wx') OK; confirma conteúdo == A; RETORNA 3
 *   B: unlink(3)  ← apaga a posse RECÉM-CRIADA de A, baseado numa observação velha
 *   B: open(3,'wx') OK; confirma conteúdo == B; RETORNA 3
 *
 * A partir daí A e B usam o MESMO db lógico do Redis — exatamente a
 * interferência que a issue existe para eliminar. A confirmação pós-`wx` de
 * `claimSlot` só enxerga trocas ANTERIORES à leitura; contra um reclaimer que
 * age DEPOIS ela é cega.
 *
 * ## O mecanismo
 *
 * `mkdir` é atômico no POSIX (falha com `EEXIST` se o diretório já existe), e
 * não depende de flags de `open` nem de suporte a `O_EXCL` sobre NFS. Um
 * diretório vira, então, um mutex entre processos: quem consegue criá-lo entra
 * na região crítica, quem não consegue espera. A reciclagem inteira — observar,
 * confirmar a geração observada, apagar, reivindicar — roda dentro dele, e o
 * segundo reclaimer reobserva o estado JÁ atualizado pelo primeiro (vê a posse
 * nova, fresca, e desiste) em vez de agir sobre uma leitura obsoleta.
 *
 * ## O que fazemos com um lock preso
 *
 * Um processo morto entre `mkdir` e `rmdir` deixaria o lock para sempre. Por
 * isso ele tem validade (`validadeMs`): passado esse tempo sem toque, o
 * próximo candidato o quebra. A janela é curta de propósito — a região crítica
 * aqui são quatro syscalls, não uma rodada de teste —, e quebrar um lock só
 * reabre a corrida original para os processos que estiverem exatamente naquele
 * instante dentro dela. É um teto de dano, não uma garantia perdida: sem
 * validade, uma máquina de dev com um `SIGKILL` no meio de um teste ficaria
 * incapaz de alocar slot até alguém apagar o diretório à mão.
 */
import { mkdirSync, rmdirSync, statSync } from 'node:fs';

/** Resultado explícito: `ok:false` é "não consegui o lock", não "o corpo falhou". */
export type ResultadoDoLock<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false };

export interface OpcoesDeLock {
  /** Quanto tempo insistir antes de desistir. Default 10s. */
  readonly esperaMaximaMs?: number;
  /** Idade a partir da qual um lock é considerado preso e pode ser quebrado. Default 30s. */
  readonly validadeMs?: number;
  /** Intervalo entre tentativas. Default 25ms. */
  readonly passoMs?: number;
}

/**
 * `sleep` SÍNCRONO de verdade.
 *
 * `resolveWorktreeScope()` é síncrono por contrato — `tests/setup.ts` o chama
 * no corpo do módulo, antes de qualquer `await` existir — então a espera pelo
 * lock não pode ser uma Promise. `Atomics.wait` sobre um `SharedArrayBuffer`
 * bloqueia a thread sem queimar CPU, que é o que um `while (Date.now() < t)`
 * faria.
 */
export function dormirSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Roda `corpo` com posse exclusiva de `caminho` (um diretório usado como
 * mutex), e devolve `{ok:false}` se não conseguiu a posse dentro da espera.
 *
 * O `rmdir` de saída está num `finally`: uma exceção do corpo libera o lock.
 */
export function comLockDeDiretorio<T>(
  caminho: string,
  corpo: () => T,
  opcoes: OpcoesDeLock = {},
): ResultadoDoLock<T> {
  const espera = opcoes.esperaMaximaMs ?? 10_000;
  const validade = opcoes.validadeMs ?? 30_000;
  const passo = opcoes.passoMs ?? 25;
  const limite = Date.now() + espera;

  for (;;) {
    try {
      mkdirSync(caminho);
      break;
    } catch {
      /* ocupado — decide abaixo entre esperar, quebrar ou desistir */
    }
    // O teto de tempo é conferido a CADA volta, inclusive depois de uma quebra:
    // sem isto, um lock recriado sem parar viraria laço infinito.
    if (Date.now() >= limite) return { ok: false };
    try {
      if (Date.now() - statSync(caminho).mtimeMs > validade) {
        rmdirSync(caminho);
        continue;
      }
    } catch {
      /* o lock sumiu entre o `mkdir` e o `stat` — tenta de novo já */
      continue;
    }
    dormirSync(passo);
  }

  try {
    return { ok: true, valor: corpo() };
  } finally {
    try {
      rmdirSync(caminho);
    } catch {
      /* já quebrado por validade; nada a fazer e nada a esconder do corpo */
    }
  }
}
