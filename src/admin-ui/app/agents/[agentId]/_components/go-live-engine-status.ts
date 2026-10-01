/**
 * SC03-AC04 (correção pós-QA239/240) — o item de checklist do MOTOR REMOTO.
 *
 * ─── Por que este módulo existe ─────────────────────────────────────────────
 *
 * O achado do QA independente: `go-live-checklist.tsx` não lia
 * `AgentReadiness.engine`. O card continuava sumindo ("Tudo pronto") com base
 * só em booleanos locais (perfil/canal/política), mesmo quando o agente PEDIA o
 * motor remoto e o motor estava indisponível. A superfície do console é a do
 * §8.3.3: ela CONSULTA o backend que chama `evaluateAgentReadiness` e apresenta
 * o veredito — não replica critério nenhum no React.
 *
 * A decisão "o que este veredito significa para o operador" é pura e mora aqui,
 * fora do componente, por dois motivos:
 *
 *   1. ela é o que o teste do card pode exercitar SEM browser (o tier raiz não
 *      tem React nem jsdom; o render é provado no e2e do console);
 *   2. um componente de UI que decide sozinho *quando* é ready é exatamente o
 *      modo de falha que este card existe para matar. Aqui a regra é uma
 *      função total sobre a projeção do backend, com o estado DESCONHECIDO
 *      explícito e bloqueante.
 *
 * ─── Fail-closed, em três linhas ────────────────────────────────────────────
 *
 *   - `requested: false` ⇒ o motor remoto NÃO está em jogo: o item não existe
 *     (`not_applicable`), e ele não bloqueia nada;
 *   - `requested: true` + `available: true` ⇒ conferido pelo backend
 *     (`available`);
 *   - qualquer outra coisa — indisponível, projeção ausente (backend antigo,
 *     avaliação que falhou) ou motivo fora do vocabulário fechado — BLOQUEIA o
 *     "pronto" (`unavailable`/`unknown`). Nenhum caminho devolve "pronto" por
 *     ausência de informação.
 *
 * Este módulo importa SÓ TIPOS de `readiness.js` (apagados na compilação): ele
 * é carregável pela UI e pelo tier de teste raiz sem arrastar React nem o pool
 * do Postgres.
 */
import type {
  EngineReadinessProjection,
  EngineUnavailableReason,
} from '@/onboarding/readiness.js';

/** O rótulo do item, uma vez só — a cópia não se espalha pela tela. */
export const GO_LIVE_ENGINE_LABEL = 'Motor remoto (Hermes)';

export type GoLiveEngineState =
  /** O agente não pede o motor remoto: não há item a mostrar. */
  | 'not_applicable'
  /** Pedido e conferido pelo backend. */
  | 'available'
  /** Pedido e indisponível, com motivo do vocabulário fechado. */
  | 'unavailable'
  /** Não foi possível saber (projeção ausente ou avaliação que não respondeu). */
  | 'unknown';

export type GoLiveEngineItem = {
  state: GoLiveEngineState;
  label: string;
  detail: string;
  /**
   * `true` ⟺ este item IMPEDE o checklist de se declarar completo. É o que
   * impede o card de sumir quando o motor remoto está pedido e indisponível.
   */
  blocks_ready: boolean;
};

/**
 * O motivo, em português, para o operador. O vocabulário é FECHADO (oito
 * valores, o mesmo de `ENGINE_UNAVAILABLE_REASONS`); a tabela é `Record` desse
 * tipo, então um motivo novo no readiness REPROVA o typecheck aqui em vez de
 * virar texto genérico em produção.
 */
export const ENGINE_UNAVAILABLE_DETAIL: Record<EngineUnavailableReason, string> = {
  kill_switch: 'O kill switch do motor remoto está ligado: nenhuma admissão nova é permitida.',
  binding_missing:
    'O backend não encontrou linha de política que peça o motor remoto para este agente.',
  binding_invalid:
    'A linha de política do motor está inválida (motor fora do vocabulário ou versão de CAS ilegível).',
  evidence_absent:
    'Sem atestação de implantação aprovada para este ambiente — não há evidência tipada do motor remoto.',
  bundle_unapproved: 'O bundle do motor remoto não está aprovado para este ambiente.',
  data_policy_not_ready:
    'A política de dados do motor remoto não cobre as classes exigidas.',
  limits_missing: 'Os limites de inferência do motor remoto não estão configurados.',
  runtime_incompatible:
    'O pin deste build é incompatível com o motor remoto (adaptador ou protocolo).',
};

const NOT_APPLICABLE_DETAIL =
  'O motor remoto não está em jogo neste agente: nenhuma política pede Hermes.';

const AVAILABLE_DETAIL =
  'O backend conferiu o pedido: binding, bundle, política de dados, limites e pin estão válidos.';

const UNKNOWN_DETAIL =
  'Não foi possível verificar o motor remoto deste agente: o backend não devolveu o veredito. ' +
  'Sem ele este checklist não declara o agente pronto — nem que ele não está.';

function detailForUnavailable(reason: EngineUnavailableReason | null | undefined): string {
  if (reason && reason in ENGINE_UNAVAILABLE_DETAIL) {
    return ENGINE_UNAVAILABLE_DETAIL[reason as EngineUnavailableReason];
  }
  // Motivo ausente ou fora do vocabulário NÃO vira "sem problema": continua
  // bloqueante, com o motivo cru quando houver um.
  return reason
    ? `O motor remoto está indisponível para este agente (motivo reportado: ${String(reason)}).`
    : 'O motor remoto está indisponível para este agente e o backend não informou o motivo.';
}

/**
 * O veredito do motor, traduzido para o item de checklist.
 *
 * `engine` é a projeção do backend: `null`/`undefined` significam "não
 * avaliado" (a superfície não pediu, ou a avaliação falhou) — e nos dois casos
 * o resultado é `unknown` BLOQUEANTE, nunca "nada pendente".
 */
export function goLiveEngineItem(
  engine: EngineReadinessProjection | null | undefined,
): GoLiveEngineItem {
  if (!engine) {
    return {
      state: 'unknown',
      label: GO_LIVE_ENGINE_LABEL,
      detail: UNKNOWN_DETAIL,
      blocks_ready: true,
    };
  }

  if (!engine.requested) {
    return {
      state: 'not_applicable',
      label: GO_LIVE_ENGINE_LABEL,
      detail: NOT_APPLICABLE_DETAIL,
      blocks_ready: false,
    };
  }

  if (engine.available) {
    return {
      state: 'available',
      label: GO_LIVE_ENGINE_LABEL,
      detail: AVAILABLE_DETAIL,
      blocks_ready: false,
    };
  }

  return {
    state: 'unavailable',
    label: GO_LIVE_ENGINE_LABEL,
    detail: detailForUnavailable(engine.unavailable_reason),
    blocks_ready: true,
  };
}