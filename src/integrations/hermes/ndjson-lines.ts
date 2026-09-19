/**
 * P07 (spec §6.4.2) — leitura incremental e LIMITADA do pipe do worker.
 *
 * "NDJSON UTF-8, um objeto por linha, leitura incremental limitada." O limite é
 * o ponto: um filho que escreve sem `\n` não pode fazer a Maia acumular memória
 * até cair. Linha acima do teto é violação de protocolo (`overflow`), e depois
 * dela o leitor para de aceitar bytes — quem chama encerra o canal.
 *
 * Bytes que não são UTF-8 válido viram linha `invalid_utf8`, em vez de serem
 * trocados por U+FFFD em silêncio: o parser do frame recusaria de qualquer
 * jeito, mas com um motivo errado.
 */

export type NdjsonLineEvent =
  | { kind: 'line'; text: string }
  | { kind: 'invalid_utf8' }
  | { kind: 'overflow'; bytes: number };

export class NdjsonLineSplitter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private stopped = false;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(private readonly maxLineBytes: number) {
    if (!Number.isInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new TypeError('NdjsonLineSplitter: maxLineBytes precisa ser inteiro positivo');
    }
  }

  /** `true` depois de um `overflow`: nenhum byte adicional é aceito. */
  get closed(): boolean {
    return this.stopped;
  }

  feed(chunk: Buffer): NdjsonLineEvent[] {
    if (this.stopped) return [];
    const events: NdjsonLineEvent[] = [];
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      const piece = chunk.subarray(start, end);
      this.pendingBytes += piece.length;
      // O teto vale para a linha SEM o `\n`, igual a `parseWorkerFrame`.
      if (this.pendingBytes > this.maxLineBytes) {
        events.push({ kind: 'overflow', bytes: this.pendingBytes });
        this.stopped = true;
        this.pending = [];
        this.pendingBytes = 0;
        return events;
      }
      if (piece.length > 0) this.pending.push(piece);
      if (nl === -1) break;
      events.push(this.takeLine());
      start = nl + 1;
    }
    return events;
  }

  /** Fim do stream: bytes sem `\n` final contam como última linha. */
  end(): NdjsonLineEvent[] {
    if (this.stopped || this.pendingBytes === 0) return [];
    const last = this.takeLine();
    this.stopped = true;
    return [last];
  }

  private takeLine(): NdjsonLineEvent {
    const bytes = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    try {
      const text = this.decoder.decode(bytes).replace(/\r$/, '');
      return { kind: 'line', text };
    } catch {
      return { kind: 'invalid_utf8' };
    }
  }
}
