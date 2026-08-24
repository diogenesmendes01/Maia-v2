/**
 * Issue #510 — `eventually`: espera POR CONDIÇÃO, com prazo e diagnóstico.
 *
 * ─── O que ele substitui, e por quê ──────────────────────────────────────────
 *
 * `await sleep(500)` é duas apostas ao mesmo tempo: que 500ms bastam (senão o
 * teste floca) e que 500ms são necessários (senão a suíte fica lenta à toa). Ele
 * também produz o pior vermelho possível — `expected 0 to be 1`, sem dizer o
 * que o sistema estava fazendo.
 *
 * `eventually` troca as duas apostas por uma condição e um prazo, e o vermelho
 * passa a carregar o ÚLTIMO estado observado, o número de tentativas e o tempo
 * decorrido. A issue #510 exige isso nominalmente ("nunca sleeps cegos",
 * "`eventually` imprime último estado").
 *
 * ─── A parte que é fácil errar ───────────────────────────────────────────────
 *
 * Uma condição que joga NÃO é o mesmo que uma condição falsa. Uma consulta ao
 * banco pode falhar porque o banco caiu — esperar em silêncio até o prazo,
 * nesse caso, esconde a causa. Então a exceção da sonda é guardada e aparece no
 * diagnóstico como `ultimoErro`; a espera continua (a falha pode ser
 * transitória: o worker ainda não abriu a conexão), mas o vermelho final diz o
 * que estava acontecendo de verdade.
 *
 * ─── Aborto ──────────────────────────────────────────────────────────────────
 *
 * `abortSignal` existe para o caso que a issue chama de "child encerrado
 * inesperadamente falha o cenário": o `ProcessSupervisor` aborta a espera no
 * instante em que um filho morre sem permissão, em vez de deixar o cenário
 * consumir o prazo inteiro esperando por um estado que ninguém vai mais
 * produzir.
 */
import { sanitizarTexto, sanitizarValor } from './sanitize.js';

export interface EventuallyOptions {
  /** Rótulo humano — vira a primeira linha do vermelho. Obrigatório. */
  label: string;
  /** Prazo total. Default 5s: um cenário que precisa de mais diz quanto e por quê. */
  timeoutMs?: number;
  /** Intervalo entre sondagens. Default 25ms. */
  intervalMs?: number;
  /**
   * Estado a imprimir no vermelho quando a sonda não devolve nada útil por si.
   * Chamado no MOMENTO DA FALHA, não a cada tentativa.
   */
  describeState?: () => unknown | Promise<unknown>;
  /** Aborta a espera antes do prazo (filho morto, teardown). */
  abortSignal?: AbortSignal;
}

export class EventuallyTimeoutError extends Error {
  readonly diagnostico: {
    label: string;
    timeoutMs: number;
    elapsedMs: number;
    tentativas: number;
    ultimoValor: unknown;
    ultimoErro: string | undefined;
    estado: unknown;
    abortado: boolean;
  };
  constructor(diagnostico: EventuallyTimeoutError['diagnostico']) {
    super(
      [
        `eventually("${diagnostico.label}") ${
          diagnostico.abortado ? 'foi ABORTADO' : `estourou em ${diagnostico.timeoutMs}ms`
        } após ${diagnostico.tentativas} tentativa(s) em ${diagnostico.elapsedMs}ms.`,
        `Último valor observado: ${JSON.stringify(diagnostico.ultimoValor) ?? 'undefined'}.`,
        diagnostico.ultimoErro ? `Último erro da sonda: ${diagnostico.ultimoErro}.` : '',
        diagnostico.estado === undefined
          ? ''
          : `Estado no momento da falha: ${JSON.stringify(diagnostico.estado)}.`,
      ]
        .filter(Boolean)
        .join(' '),
    );
    this.name = 'EventuallyTimeoutError';
    this.diagnostico = diagnostico;
  }
}

/**
 * Sonda até `probe` devolver um valor "presente" (nem `undefined`, nem `null`,
 * nem `false`) ou até o prazo. Devolve o valor.
 *
 * Um `false` conta como "ainda não", o que deixa `eventually(() => x === 3)`
 * funcionar sem cerimônia. Quem PRECISA distinguir `false` de "ainda não"
 * devolve um objeto (`{ valor: false }`).
 */
export async function eventually<T>(
  probe: () => T | Promise<T>,
  opts: EventuallyOptions,
): Promise<NonNullable<T>> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 25;
  const inicio = Date.now();
  let tentativas = 0;
  let ultimoValor: unknown;
  let ultimoErro: string | undefined;

  for (;;) {
    if (opts.abortSignal?.aborted) {
      throw new EventuallyTimeoutError(
        await montarDiagnostico(opts, timeoutMs, inicio, tentativas, ultimoValor, ultimoErro, true),
      );
    }

    tentativas += 1;
    try {
      const valor = await probe();
      ultimoValor = valor;
      ultimoErro = undefined;
      if (valor !== undefined && valor !== null && valor !== false) {
        return valor as NonNullable<T>;
      }
    } catch (erro) {
      ultimoErro = sanitizarTexto(erro instanceof Error ? erro.message : String(erro));
    }

    if (Date.now() - inicio >= timeoutMs) {
      throw new EventuallyTimeoutError(
        await montarDiagnostico(opts, timeoutMs, inicio, tentativas, ultimoValor, ultimoErro, false),
      );
    }

    // O único `setTimeout` do módulo, e ele NÃO é uma espera cega: é o passo
    // entre duas sondagens de uma condição que já foi consultada.
    await new Promise<void>((r) => {
      const t = setTimeout(r, intervalMs);
      t.unref?.();
    });
  }
}

async function montarDiagnostico(
  opts: EventuallyOptions,
  timeoutMs: number,
  inicio: number,
  tentativas: number,
  ultimoValor: unknown,
  ultimoErro: string | undefined,
  abortado: boolean,
): Promise<EventuallyTimeoutError['diagnostico']> {
  let estado: unknown;
  if (opts.describeState) {
    try {
      estado = sanitizarValor(await opts.describeState());
    } catch (erro) {
      estado = `describeState() falhou: ${sanitizarTexto(
        erro instanceof Error ? erro.message : String(erro),
      )}`;
    }
  }
  return {
    label: opts.label,
    timeoutMs,
    elapsedMs: Date.now() - inicio,
    tentativas,
    ultimoValor: sanitizarValor(ultimoValor),
    ultimoErro,
    estado,
    abortado,
  };
}

/**
 * "Nada mudou durante a janela" — o helper que a issue manda usar SÓ onde é
 * inevitável, e com justificativa.
 *
 * É inevitável quando a invariante é negativa: "o worker fenced NÃO gravou".
 * Não existe evento de "não aconteceu"; a única prova é observar por uma janela
 * e afirmar a estabilidade. Este é o único ponto do harness onde tempo de
 * relógio entra numa asserção — e ele falha CEDO, no instante em que o valor
 * muda, em vez de esperar a janela inteira para reprovar.
 */
export async function estavelDurante<T>(
  probe: () => T | Promise<T>,
  opts: { label: string; janelaMs: number; intervalMs?: number; justificativa: string },
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 25;
  const inicial = await probe();
  const serializado = JSON.stringify(sanitizarValor(inicial));
  const fim = Date.now() + opts.janelaMs;

  while (Date.now() < fim) {
    await new Promise<void>((r) => {
      const t = setTimeout(r, intervalMs);
      t.unref?.();
    });
    const atual = await probe();
    const atualSerializado = JSON.stringify(sanitizarValor(atual));
    if (atualSerializado !== serializado) {
      throw new Error(
        `estavelDurante("${opts.label}") observou MUDANÇA dentro da janela de ${opts.janelaMs}ms. ` +
          `Antes: ${serializado}. Depois: ${atualSerializado}. ` +
          `Justificativa da janela: ${opts.justificativa}.`,
      );
    }
  }
  return inicial;
}
