/**
 * Issue #510 — `FakeLlmServer`: LLM roteirizável, sem internet, com ABORTO
 * OBSERVÁVEL.
 *
 * ─── Por que in-process (e não um filho, como o provider) ────────────────────
 *
 * O fake de provider precisa de processo separado porque o cenário MATA o
 * worker e ainda precisa perguntar ao ledger o que aconteceu. O fake de LLM
 * não tem essa exigência: ele é consultado DURANTE o turno, e o que o cenário
 * pergunta a ele ("a requisição foi abortada quando o deadline estourou?")
 * é respondido pelo processo do teste, que nunca morre. Um processo a menos
 * por cenário é ~40ms e um PID a menos para gerenciar.
 *
 * Ele escuta em `127.0.0.1:0` (porta efêmera) e o SUT recebe a URL por env.
 * Nunca chama a internet — não há caminho de saída neste arquivo.
 *
 * ─── A capacidade que não é óbvia: observar o aborto ─────────────────────────
 *
 * FI-21 pergunta se o deadline CANCELA trabalho real, e não só se o cliente
 * para de esperar. A diferença é observável exatamente aqui: quando o cliente
 * derruba o socket, o servidor recebe `close` na resposta ANTES de tê-la
 * terminado. Um cliente que apenas ignora a resposta (sem `AbortSignal`)
 * deixaria a requisição terminar normalmente, e o campo `abortado` ficaria
 * `false`. É por isso que o campo existe, e é por isso que ele é a asserção.
 *
 * ─── Contagem por turno/tentativa, não por conteúdo ──────────────────────────
 *
 * A issue exige contar requests e retries por `turn_id/attempt` "sem depender
 * do conteúdo". O SUT manda os dois em cabeçalhos; o corpo nunca é inspecionado
 * para contagem, e nunca é gravado — o que entra no registro é o TAMANHO, não o
 * texto.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';

export const CABECALHO_TURNO = 'x-maia-turn-id';
export const CABECALHO_TENTATIVA = 'x-maia-attempt';

/** O que o servidor deve fazer na próxima requisição. Consumido em ordem. */
export const respostaRoteirizadaSchema = z.discriminatedUnion('kind', [
  /** JSON válido; o SUT parseia com Zod e segue. */
  z.object({
    kind: z.literal('ok'),
    texto: z.string().default('ok'),
    inputTokens: z.number().int().min(0).default(10),
    outputTokens: z.number().int().min(0).default(5),
    delayMs: z.number().int().min(0).default(0),
  }),
  /** JSON estruturalmente inválido para o schema do SUT — exercita o fail-closed. */
  z.object({ kind: z.literal('invalid'), delayMs: z.number().int().min(0).default(0) }),
  /** Erro retryable (5xx). */
  z.object({ kind: z.literal('error'), status: z.number().int().min(500).max(599).default(503), delayMs: z.number().int().min(0).default(0) }),
  /** Erro terminal (4xx que não adianta repetir). */
  z.object({ kind: z.literal('terminal'), status: z.number().int().min(400).max(499).default(400), delayMs: z.number().int().min(0).default(0) }),
  /** 429 com `retry-after`. */
  z.object({ kind: z.literal('rate_limit'), retryAfterS: z.number().int().min(0).default(1) }),
  /** Stream que entrega N pedaços e PARA no meio, sem fechar direito. */
  z.object({
    kind: z.literal('stream_parcial'),
    pedacos: z.number().int().min(1).default(2),
    intervaloMs: z.number().int().min(0).default(10),
  }),
  /**
   * Nunca responde. Fica pendurado até o cliente abortar ou até `liberar()`.
   * É o comportamento que torna o deadline observável.
   */
  z.object({ kind: z.literal('pendurar') }),
  /**
   * Responde DEPOIS do prazo do cliente — o "resultado tardio" da issue. O
   * cenário prova que uma resposta que chega tarde não ressuscita o turno.
   */
  z.object({ kind: z.literal('tardio'), delayMs: z.number().int().min(1).default(2_000) }),
]);
/**
 * O que o CENÁRIO escreve: os campos com `.default()` são opcionais aqui.
 * `z.input` e não `z.infer`, porque `z.infer` devolve a forma DEPOIS do parse,
 * onde todo default virou campo obrigatório — e um cenário teria de escrever
 * `{ kind: 'ok', texto: 'x', inputTokens: 10, outputTokens: 5, delayMs: 0 }`
 * só para pedir o caminho feliz.
 */
export type RespostaRoteirizada = z.input<typeof respostaRoteirizadaSchema>;

/** O que o SERVIDOR consome: pós-parse, com todo default preenchido. */
export type RespostaResolvida = z.output<typeof respostaRoteirizadaSchema>;

export interface ChamadaDeLlm {
  readonly n: number;
  readonly turnId: string | undefined;
  readonly attempt: number | undefined;
  readonly kind: RespostaResolvida['kind'];
  readonly recebidaEmMs: number;
  /** TAMANHO do corpo, nunca o corpo. Ver cabeçalho. */
  bytesDeEntrada: number;
  /** `true` quando o cliente derrubou a conexão antes de a resposta terminar. */
  abortado: boolean;
  /** `true` quando o servidor conseguiu terminar a resposta. */
  respondida: boolean;
  finalizadaEmMs: number | undefined;
}

export class FakeLlmServer {
  private servidor: Server | undefined;
  private porta = 0;
  private readonly t0 = performance.now();
  private roteiro: RespostaResolvida[] = [];
  private readonly chamadas: ChamadaDeLlm[] = [];
  private readonly pendurados = new Set<ServerResponse>();
  /** Padrão quando o roteiro esvazia — evita que o SUT trave por falta de script. */
  private padrao: RespostaResolvida = { kind: 'ok', texto: 'ok', inputTokens: 10, outputTokens: 5, delayMs: 0 };

  private agora(): number {
    return Math.round((performance.now() - this.t0) * 1000) / 1000;
  }

  async iniciar(): Promise<string> {
    this.servidor = createServer((req, res) => {
      this.atender(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.servidor?.once('error', reject);
      this.servidor?.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.servidor?.address();
    this.porta = typeof addr === 'object' && addr ? addr.port : 0;
    if (this.porta === 0) throw new Error('FakeLlmServer não conseguiu porta efêmera.');
    return this.baseUrl;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.porta}`;
  }

  /** Enfileira o roteiro. Substitui o anterior. */
  roteirizar(respostas: readonly RespostaRoteirizada[]): void {
    this.roteiro = respostas.map((r) => respostaRoteirizadaSchema.parse(r));
  }

  /** Comportamento quando o roteiro acaba. */
  definirPadrao(resposta: RespostaRoteirizada): void {
    this.padrao = respostaRoteirizadaSchema.parse(resposta);
  }

  /** Todas as chamadas, em ordem de chegada. */
  historico(): readonly ChamadaDeLlm[] {
    return [...this.chamadas];
  }

  /** Chamadas abortadas pelo cliente — a asserção de FI-21. */
  abortos(): readonly ChamadaDeLlm[] {
    return this.chamadas.filter((c) => c.abortado);
  }

  /** Quantas chamadas para um par turno/tentativa. Conta por cabeçalho, não por conteúdo. */
  chamadasDe(turnId: string, attempt?: number): number {
    return this.chamadas.filter(
      (c) => c.turnId === turnId && (attempt === undefined || c.attempt === attempt),
    ).length;
  }

  /** Solta quem está pendurado com um 200 — para o teardown não travar. */
  liberarPendurados(): void {
    for (const res of this.pendurados) {
      if (!res.writableEnded) res.end(JSON.stringify({ liberado: true }));
    }
    this.pendurados.clear();
  }

  async parar(): Promise<void> {
    this.liberarPendurados();
    const s = this.servidor;
    this.servidor = undefined;
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      // `closeAllConnections` mata keep-alive pendurado; sem ele o `close`
      // espera por sockets que ninguém vai fechar e o teardown pendura.
      s.closeAllConnections?.();
    });
  }

  private atender(req: IncomingMessage, res: ServerResponse): void {
    const roteirizada = this.roteiro.shift() ?? this.padrao;
    const turnId = cabecalho(req, CABECALHO_TURNO);
    const attemptBruto = cabecalho(req, CABECALHO_TENTATIVA);
    const attempt = attemptBruto === undefined ? undefined : Number.parseInt(attemptBruto, 10);

    const chamada: ChamadaDeLlm = {
      n: this.chamadas.length + 1,
      turnId,
      attempt: attempt === undefined || Number.isNaN(attempt) ? undefined : attempt,
      kind: roteirizada.kind,
      recebidaEmMs: this.agora(),
      bytesDeEntrada: 0,
      abortado: false,
      respondida: false,
      finalizadaEmMs: undefined,
    };
    this.chamadas.push(chamada);

    // Só o TAMANHO do corpo entra no registro; o corpo em si é descartado sem
    // nunca ser lido como texto. Ver o cabeçalho do módulo.
    req.on('data', (c: Buffer) => {
      chamada.bytesDeEntrada += c.length;
    });

    // O ÚNICO detector de aborto: `close` na resposta antes de `writableEnded`.
    // Um cliente que só ignora a resposta não dispara isto — que é exatamente
    // a distinção que FI-21 precisa fazer.
    res.on('close', () => {
      if (!res.writableEnded) {
        chamada.abortado = true;
        chamada.finalizadaEmMs = this.agora();
        this.pendurados.delete(res);
      }
    });

    const finalizar = (status: number, corpo: unknown, headers: Record<string, string> = {}): void => {
      if (res.writableEnded || res.destroyed) return;
      const texto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(texto);
      chamada.respondida = true;
      chamada.finalizadaEmMs = this.agora();
    };

    const depois = (ms: number, fn: () => void): void => {
      if (ms <= 0) {
        fn();
        return;
      }
      const t = setTimeout(fn, ms);
      t.unref?.();
    };

    switch (roteirizada.kind) {
      case 'ok':
        depois(roteirizada.delayMs, () =>
          finalizar(200, {
            content: [{ type: 'text', text: roteirizada.texto }],
            usage: { input_tokens: roteirizada.inputTokens, output_tokens: roteirizada.outputTokens },
            stop_reason: 'end_turn',
          }),
        );
        return;
      case 'invalid':
        // Forma que NENHUM schema de saída do SUT aceita: sem `content`, com
        // um campo inesperado no lugar. Prova o fail-closed do parse.
        depois(roteirizada.delayMs, () => finalizar(200, { nao_e_isso: true }));
        return;
      case 'error':
        depois(roteirizada.delayMs, () => finalizar(roteirizada.status, { error: { type: 'overloaded_error' } }));
        return;
      case 'terminal':
        depois(roteirizada.delayMs, () => finalizar(roteirizada.status, { error: { type: 'invalid_request_error' } }));
        return;
      case 'rate_limit':
        finalizar(429, { error: { type: 'rate_limit_error' } }, { 'retry-after': String(roteirizada.retryAfterS) });
        return;
      case 'stream_parcial': {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        let i = 0;
        const passo = (): void => {
          if (res.writableEnded || res.destroyed) return;
          if (i >= roteirizada.pedacos) {
            // PARA no meio de propósito: sem `[DONE]`, sem `end()`. O cliente
            // fica esperando, e é isso que o cenário quer exercitar.
            return;
          }
          res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: i })}\n\n`);
          i += 1;
          depois(roteirizada.intervaloMs, passo);
        };
        passo();
        return;
      }
      case 'pendurar':
        this.pendurados.add(res);
        return;
      case 'tardio':
        depois(roteirizada.delayMs, () =>
          finalizar(200, {
            content: [{ type: 'text', text: 'tardio' }],
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: 'end_turn',
          }),
        );
        return;
      default: {
        const _exaustivo: never = roteirizada;
        finalizar(500, { error: 'roteiro desconhecido', _exaustivo });
      }
    }
  }
}

function cabecalho(req: IncomingMessage, nome: string): string | undefined {
  const v = req.headers[nome];
  if (Array.isArray(v)) return v[0];
  return v;
}
