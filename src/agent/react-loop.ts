/**
 * P01/P02.2 · SC01 (spec §5.2, §5.4.2, §5.10.3) — `runReActLoop`: a MÁSCARA DE
 * COMPATIBILIDADE do laço local.
 *
 * ─── O que este arquivo é depois da extração ────────────────────────────────
 *
 * A deliberação, o gateway de ferramentas, o assembler e o coordenador saíram
 * daqui e vivem em `@/runtime/engines/reasoner-stage.js`. Este módulo guarda o
 * que era CONTRATO PÚBLICO do laço e continua sendo:
 *
 *   - os TIPOS (`ReActDelivery`, `ReActExitReason`, `ReActLoopResult`,
 *     `RunReActLoopParams`, agora em `./react-types.js` e REEXPORTADOS aqui) —
 *     `turn-outcome.ts`, `core.ts` e o coordenador dependem deles;
 *   - a assinatura `runReActLoop(params)`, agora delegação ao stage;
 *   - `MAX_REACT_ITERATIONS`, reexportado da implementação do raciocínio (é
 *     `@/runtime/engines/maia-reasoning.js` que o usa para parar o laço —
 *     manter duas cópias seria manter duas verdades sobre o mesmo teto).
 *
 * ─── Por que a delegação é o desenho, e não um atalho ───────────────────────
 *
 * `tests/unit/react-loop-characterization.spec.ts` (57 casos) e
 * `tests/integration/turn-lease-lost-react-loop-real-db.spec.ts` MEDEM este
 * arquivo. Eles existem para provar que a extração preservou comportamento —
 * então o caminho que eles exercitam tem de ser o caminho de PRODUÇÃO, e não
 * uma cópia paralela que envelhece. Delegar mantém os dois alinhados por
 * construção: um caso vermelho aqui é uma mudança de comportamento no seam, não
 * uma divergência entre duas implementações.
 *
 * O `core.ts` chama o stage DIRETO (`runReasonerStage` no bloco pós-gates, §5.2
 * "NOVO — seam principal"). `runReActLoop` permanece para os callers que já o
 * importavam — specs e caminhos fora do turno — com o mesmo nome, a mesma
 * assinatura e o mesmo resultado observável.
 *
 * ─── O que a extração mudou DE PROPÓSITO ────────────────────────────────────
 *
 * Nada observável de fora: o texto, o prefixo de role, o teto de 5 iterações, o
 * `max_tokens: 1024`, a auditoria por tool-use, a reação efêmera, a recusa por
 * perda de posse e o flush de sumários sem outbound continuam idênticos — e por
 * isso a caracterização segue verde sem edição. Uma única correção vem junto e
 * está declarada no coordenador: `DispatchOutputCtx.toolSummaries`, que o laço
 * OMITIA no caminho com resposta, passa a ser enviado sempre (§5.9.2.3). É a
 * "mudança intencional" que o §5.10.3 manda marcar.
 */
import type { ReActLoopResult, RunReActLoopParams } from './react-types.js';
import { runReasonerStage } from '@/runtime/engines/reasoner-stage.js';

export type {
  ReActDelivery,
  ReActExitReason,
  ReActLoopResult,
  RunReActLoopParams,
} from './react-types.js';
export { MAX_REACT_ITERATIONS } from '@/runtime/engines/maia-reasoning.js';

/**
 * Runs the ReAct turn: delibera atrás da porta do engine, monta o resultado
 * confiável a partir dos receipts e entrega pelo coordenador.
 *
 * Delegação fina ao seam (`runReasonerStage`) — ver o cabeçalho para por que a
 * delegação é deliberada.
 */
export function runReActLoop(params: RunReActLoopParams): Promise<ReActLoopResult> {
  return runReasonerStage(params);
}