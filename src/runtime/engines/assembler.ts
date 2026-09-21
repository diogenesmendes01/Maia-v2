/**
 * P02 (spec §5.2, §5.3.4, §5.9.2.1) — `EngineResultAssembler`.
 *
 * ─── O problema que este módulo resolve ─────────────────────────────────────
 *
 * A proposta terminal de um motor é uma AFIRMAÇÃO, não um fato. O motor local
 * roda no nosso processo e o remoto roda noutro, mas a diferença não importa
 * para o desenho: nos dois casos quem diz "chamei estas ferramentas" é o lado
 * que raciocina, e ele não tem como provar efeito. O que prova é o receipt que
 * a Maia gravou ao despachar cada chamada — o journal.
 *
 * Então o assembler NUNCA lê `proposal.observed_tool_call_ids` como fonte. Ele
 * deriva tudo (tools chamadas, sumários, sensibilidade, último pending, último
 * PDF) dos receipts em ordem, e usa a lista afirmada apenas para CONFRONTAR. Se
 * o motor afirma uma chamada que não está no journal, isso não é ruído: é um
 * motor relatando efeito que a Maia não autorizou, e vira divergência.
 *
 * ─── O que ele deliberadamente não faz ──────────────────────────────────────
 *
 * Não entrega, não decide outcome de turno e não fala com banco. Ele é puro:
 * recebe proposta + receipts, devolve um resultado confiável. Quem despacha é
 * o `MaiaOutputCoordinator` (`./coordinator.ts`); quem decide o desfecho da
 * máquina de estados é `decideTurnAction` (`@/agent/turn-outcome.ts`).
 */
import type { ToolExecutionSummary } from '@/agent/tool-execution-summary.js';
import type { LatestPending, LatestReportPdf } from '@/agent/output-dispatch.js';
import type { EngineStopV1, EngineTerminalProposalV1, Json, ReportedUsageV1 } from './contracts.js';

/**
 * O que a Maia GRAVOU ao despachar uma chamada. É o lado autoritativo: existe
 * porque o dispatcher da casa rodou, não porque o motor disse que rodou.
 *
 * `ordinal` é 0-based por run e sem lacunas — a mesma régua de
 * `EngineToolCallV1.ordinal` (§5.3.1). Lacuna aqui é receipt perdido, e o
 * assembler reporta em vez de assumir.
 */
export type EngineToolReceiptV1 = {
  call_id: string;
  ordinal: number;
  tool_name: string;
  /** Saída crua do dispatcher, como o step-evaluator pós-turno espera. */
  result: unknown;
  status: 'success' | 'error';
  /** `null` quando a tool não declara efeito no registry. */
  side_effect: 'read' | 'write' | 'communication' | null;
  sensitive: boolean;
  summary: ToolExecutionSummary;
  /** Pending aberto POR esta chamada, quando houve. */
  pending: LatestPending | null;
  /** Report PDF materializado POR esta chamada, quando houve. */
  report_pdf: LatestReportPdf | null;
};

/**
 * Divergência entre o que o motor afirma e o que a Maia gravou.
 *
 * `claimed_not_journaled` é o caso grave e o motivo de este tipo existir: o
 * motor afirma uma chamada que não tem receipt. Não é erro de contagem — é o
 * motor reivindicando um efeito que não passou pelo dispatcher da casa.
 *
 * `journaled_not_claimed` é o inverso e NÃO é grave por si: a Maia despachou e
 * o motor morreu antes de registrar a observação. O efeito aconteceu e está no
 * journal, que é o que importa; fica reportado para diagnóstico.
 */
export type EngineClaimDivergenceV1 =
  | { kind: 'none' }
  | { kind: 'claimed_not_journaled'; call_ids: string[] }
  | { kind: 'journaled_not_claimed'; call_ids: string[] }
  | { kind: 'both'; claimed_not_journaled: string[]; journaled_not_claimed: string[] };

/** Texto candidato à entrega. `raw` é sem prefixo de role — ver §5.9.2.2. */
export type OutputCandidateV1 = { rawText: string; text: string };

export type AssembledTurnResultV1 = {
  /** Desfecho DELIBERATIVO. É a única parte da proposta que o motor decide. */
  stop: EngineStopV1;
  iterations: number;
  usage: ReportedUsageV1;
  /** `null` quando não há texto a entregar (`no_reply`, `failed`, `cancelled`). */
  candidate: OutputCandidateV1 | null;
  /** Derivado dos receipts, em ordem de `ordinal`. */
  toolsCalled: Array<{ name: string; result: unknown }>;
  toolSummaries: ToolExecutionSummary[];
  turnHasSensitive: boolean;
  sensitiveTools: string[];
  /** ÚLTIMO válido, na ordem do journal — não o primeiro nem o afirmado. */
  latestPending: LatestPending | null;
  latestReportPdf: LatestReportPdf | null;
  /** Efeito irreversível JÁ COMMITADO, derivado do journal (§5.3.3). */
  sideEffectsCommitted: boolean;
  divergence: EngineClaimDivergenceV1;
  /** `ordinal` faltando na sequência 0..n-1: receipt perdido, não silenciado. */
  missingOrdinals: number[];
};

/** Ordena por `ordinal`. Empate não existe no piloto; se existir, estabiliza. */
function porOrdinal(a: EngineToolReceiptV1, b: EngineToolReceiptV1): number {
  if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
  return a.call_id < b.call_id ? -1 : a.call_id > b.call_id ? 1 : 0;
}

function compararAfirmacoes(
  claimed: readonly string[],
  journaled: readonly string[],
): EngineClaimDivergenceV1 {
  const noJournal = new Set(journaled);
  const afirmados = new Set(claimed);
  const claimedNotJournaled = [...afirmados].filter((id) => !noJournal.has(id)).sort();
  const journaledNotClaimed = [...noJournal].filter((id) => !afirmados.has(id)).sort();
  if (claimedNotJournaled.length > 0 && journaledNotClaimed.length > 0) {
    return {
      kind: 'both',
      claimed_not_journaled: claimedNotJournaled,
      journaled_not_claimed: journaledNotClaimed,
    };
  }
  if (claimedNotJournaled.length > 0) {
    return { kind: 'claimed_not_journaled', call_ids: claimedNotJournaled };
  }
  if (journaledNotClaimed.length > 0) {
    return { kind: 'journaled_not_claimed', call_ids: journaledNotClaimed };
  }
  return { kind: 'none' };
}

/**
 * `ordinal` é 0-based e sem lacunas. Uma lacuna significa que uma chamada foi
 * despachada e o receipt não chegou — o assembler NÃO pode tratar isso como
 * "não houve chamada", porque o efeito pode ter acontecido.
 */
function ordinaisFaltando(receipts: readonly EngineToolReceiptV1[]): number[] {
  if (receipts.length === 0) return [];
  const vistos = new Set(receipts.map((r) => r.ordinal));
  const maior = Math.max(...vistos);
  const faltando: number[] = [];
  for (let i = 0; i <= maior; i++) if (!vistos.has(i)) faltando.push(i);
  return faltando;
}

/**
 * Aplica o prefixo de role ao texto candidato.
 *
 * `rawText` fica SEM o prefixo de propósito: a detecção de lacuna
 * (`detectGap`) lê o texto que o modelo produziu, e o anúncio de troca de role
 * é da Maia. Passar o texto prefixado ali dispara lacuna por frase nossa
 * ([P88-C4], `react-loop.ts`).
 */
function montarCandidato(
  stop: EngineStopV1,
  outboundPrefix: string | null,
): OutputCandidateV1 | null {
  if (stop.kind !== 'reply') return null;
  const rawText = stop.raw_text;
  if (rawText.length === 0) return null;
  const text =
    outboundPrefix !== null && outboundPrefix.length > 0 ? `${outboundPrefix}${rawText}` : rawText;
  return { rawText, text };
}

/**
 * Monta o resultado confiável do turno a partir do journal, confrontando a
 * proposta do motor em vez de acreditar nela.
 */
export function assembleTurnResult(input: {
  proposal: EngineTerminalProposalV1;
  receipts: readonly EngineToolReceiptV1[];
  outboundPrefix: string | null;
}): AssembledTurnResultV1 {
  const { proposal, outboundPrefix } = input;
  const receipts = [...input.receipts].sort(porOrdinal);

  const toolsCalled: Array<{ name: string; result: unknown }> = [];
  const toolSummaries: ToolExecutionSummary[] = [];
  const sensitiveTools: string[] = [];
  let latestPending: LatestPending | null = null;
  let latestReportPdf: LatestReportPdf | null = null;
  let sideEffectsCommitted = false;

  for (const r of receipts) {
    toolsCalled.push({ name: r.tool_name, result: r.result });
    toolSummaries.push(r.summary);
    // `!includes` preserva a régua atual da auditoria: a lista de
    // `sensitive_tools` é de NOMES distintos, não uma por chamada.
    if (r.sensitive && !sensitiveTools.includes(r.tool_name)) sensitiveTools.push(r.tool_name);
    // O ÚLTIMO vence: o laço pode abrir dois pendings e só o último está aberto
    // quando o turno termina. Mesma ordem do `react-loop.ts`.
    if (r.pending !== null) latestPending = r.pending;
    if (r.report_pdf !== null) latestReportPdf = r.report_pdf;
    // Efeito irreversível é do JOURNAL. Uma chamada que falhou ainda pode ter
    // commitado efeito externo antes de falhar, então `status` não é o gate —
    // ter sido DESPACHADA com efeito de escrita/comunicação é.
    if (r.side_effect === 'write' || r.side_effect === 'communication') {
      sideEffectsCommitted = true;
    }
  }

  return {
    stop: proposal.stop,
    iterations: proposal.iterations,
    usage: proposal.usage,
    candidate: montarCandidato(proposal.stop, outboundPrefix),
    toolsCalled,
    toolSummaries,
    turnHasSensitive: sensitiveTools.length > 0,
    sensitiveTools,
    latestPending,
    latestReportPdf,
    sideEffectsCommitted,
    divergence: compararAfirmacoes(
      proposal.observed_tool_call_ids,
      receipts.map((r) => r.call_id),
    ),
    missingOrdinals: ordinaisFaltando(receipts),
  };
}

/**
 * A divergência autoriza entrega?
 *
 * `claimed_not_journaled` NÃO autoriza: o motor afirma efeito que a Maia não
 * despachou, e responder ao usuário em cima disso é entregar uma resposta
 * construída sobre uma alegação não verificada. O turno para e um humano olha.
 *
 * As outras não bloqueiam a entrega: em `journaled_not_claimed` o efeito está
 * no journal (que é a fonte), e lacuna de ordinal é reportada mas não é prova
 * de alegação falsa.
 */
export function divergenceBlocksDelivery(d: EngineClaimDivergenceV1): boolean {
  return d.kind === 'claimed_not_journaled' || d.kind === 'both';
}

/** Json-safe para auditoria. Não carrega resultado de tool (pode ter PII). */
export function divergenceToAuditPayload(d: EngineClaimDivergenceV1): Json {
  switch (d.kind) {
    case 'none':
      return { kind: 'none' };
    case 'claimed_not_journaled':
      return { kind: d.kind, call_ids: [...d.call_ids] };
    case 'journaled_not_claimed':
      return { kind: d.kind, call_ids: [...d.call_ids] };
    case 'both':
      return {
        kind: d.kind,
        claimed_not_journaled: [...d.claimed_not_journaled],
        journaled_not_claimed: [...d.journaled_not_claimed],
      };
  }
}
