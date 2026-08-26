/**
 * Issue #510 — `ArtifactCollector`: o que sobra quando um cenário reprova.
 *
 * ─── Para que serve ──────────────────────────────────────────────────────────
 *
 * Um cenário de fault injection reprova no CI, num container que já não existe,
 * com processos que já morreram. Sem artefato, o que resta é `expected 1 to be
 * 2` e uma tarde perdida. Com artefato, resta a TIMELINE (em que ordem os
 * failpoints foram alcançados, quando cada processo morreu e com que sinal), o
 * stdout/stderr de cada filho e os snapshots que o oracle leu.
 *
 * ─── O invariante deste módulo ───────────────────────────────────────────────
 *
 * NADA é gravado sem passar por `sanitize.ts`. Não existe rota que escape: as
 * três entradas públicas (`evento`, `saidaDeProcesso`, `snapshot`) sanitizam na
 * ENTRADA, e `escrever()` sanitiza de novo na saída. A dupla passagem é de
 * propósito — as regras são idempotentes, e o custo de rodá-las duas vezes é
 * irrelevante perto do custo de um telefone de cliente num log público.
 *
 * ─── Tempo monotônico ────────────────────────────────────────────────────────
 *
 * A timeline usa `performance.now()` a partir do instante de criação do
 * coletor, não `Date.now()`. Ajuste de relógio no runner (NTP, container
 * migrando) reordenaria eventos gravados com relógio de parede; o relógio
 * monotônico não anda para trás. O timestamp de parede aparece UMA vez, no
 * cabeçalho, como referência humana.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonSanitizado, sanitizarTexto, sanitizarValor } from './sanitize.js';

/**
 * Contador de gravações DESTE processo.
 *
 * Sem ele, dois artefatos escritos no mesmo milissegundo recebiam o mesmo nome
 * e o segundo sobrescrevia o primeiro — o self-test pegou exatamente isso, com
 * dois `escrever()` consecutivos. Num cenário FI, os dois artefatos perdidos
 * seriam os de duas réplicas que falharam juntas, que é justamente o par que
 * importa comparar.
 */
let sequenciaDeGravacao = 0;

/** `tests/reliability/artifacts/` — ignorado pelo git (ver `.gitignore`). */
export function diretorioPadraoDeArtefatos(): string {
  const aqui = dirname(fileURLToPath(import.meta.url));
  return resolve(aqui, '..', 'artifacts');
}

export interface EventoDeTimeline {
  readonly tMs: number;
  readonly tipo: string;
  readonly detalhe: unknown;
}

export interface SaidaDeProcesso {
  readonly label: string;
  readonly pid: number | undefined;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}

export interface CabecalhoDeArtefato {
  /** FI-ID quando houver; nesta fatia, o nome do self-test. */
  readonly cenario: string;
  readonly seed: string;
  readonly commit: string | undefined;
  readonly iniciadoEm: string;
}

export class ArtifactCollector {
  private readonly t0 = performance.now();
  private readonly eventos: EventoDeTimeline[] = [];
  private readonly processos = new Map<string, SaidaDeProcesso>();
  private readonly snapshots: Array<{ nome: string; conteudo: unknown; tMs: number }> = [];
  private readonly cabecalho: CabecalhoDeArtefato;

  constructor(cenario: string, seed: string, commit = process.env.GITHUB_SHA) {
    this.cabecalho = {
      cenario,
      seed,
      commit,
      iniciadoEm: new Date().toISOString(),
    };
  }

  private agora(): number {
    return Math.round((performance.now() - this.t0) * 1000) / 1000;
  }

  /** Um ponto na timeline. `detalhe` é sanitizado na entrada. */
  evento(tipo: string, detalhe: unknown = {}): void {
    this.eventos.push({ tMs: this.agora(), tipo, detalhe: sanitizarValor(detalhe) });
  }

  /** Registra um filho. Chamado pelo `ProcessSupervisor` no spawn. */
  registrarProcesso(label: string, pid: number | undefined): void {
    if (!this.processos.has(label)) {
      this.processos.set(label, { label, pid, stdout: '', stderr: '', exitCode: null, signal: null });
    }
    this.evento('process.spawn', { label, pid });
  }

  /** Acumula saída de um filho, já sanitizada. */
  saidaDeProcesso(label: string, fluxo: 'stdout' | 'stderr', pedaco: string): void {
    const p = this.processos.get(label);
    if (!p) {
      this.registrarProcesso(label, undefined);
    }
    const alvo = this.processos.get(label) as SaidaDeProcesso;
    alvo[fluxo] += sanitizarTexto(pedaco);
  }

  saidaDeProcessoEncerrado(label: string, exitCode: number | null, signal: string | null): void {
    const p = this.processos.get(label);
    if (p) {
      p.exitCode = exitCode;
      p.signal = signal;
    }
    this.evento('process.exit', { label, exitCode, signal });
  }

  /** Snapshot de estado durável (linhas de turno, ledger do fake, counts da fila). */
  snapshot(nome: string, conteudo: unknown): void {
    this.snapshots.push({ nome, conteudo: sanitizarValor(conteudo), tMs: this.agora() });
    this.evento('snapshot', { nome });
  }

  /** A timeline como o relatório do cenário a imprime. Já sanitizada. */
  timeline(): readonly EventoDeTimeline[] {
    return [...this.eventos];
  }

  /** Tudo que este coletor sabe, num objeto serializável e sanitizado. */
  relatorio(): Record<string, unknown> {
    return sanitizarValor({
      ...this.cabecalho,
      duracaoMs: this.agora(),
      timeline: this.eventos,
      processos: [...this.processos.values()],
      snapshots: this.snapshots,
    }) as Record<string, unknown>;
  }

  /**
   * Grava em disco e devolve o caminho. Chamado no `afterEach` quando o caso
   * reprovou — nunca no caminho verde, para que o CI não colecione megabytes de
   * artefato de rodada que passou.
   *
   * O nome do arquivo carrega cenário e timestamp, então duas reprovações do
   * mesmo cenário não se sobrescrevem.
   */
  escrever(diretorio = diretorioPadraoDeArtefatos()): string {
    mkdirSync(diretorio, { recursive: true });
    const slug = this.cabecalho.cenario.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
    sequenciaDeGravacao += 1;
    const arquivo = join(
      diretorio,
      `${slug}-${Date.now()}-${process.pid}-${sequenciaDeGravacao}.json`,
    );
    writeFileSync(arquivo, jsonSanitizado(this.relatorio()), 'utf8');
    return arquivo;
  }
}
