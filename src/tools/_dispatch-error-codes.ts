/**
 * Issue #535 §2 — the CLOSED sets of `{ error }` codes the tool boundary can
 * return, and what each one MEANS operationally.
 *
 * ### Why this file exists at all
 *
 * `dispatchTool` signals every verdict by RETURNING `{ error: '<code>' }`, and
 * `src/observability/instrumentation.ts` collapses that code into the bounded
 * `result` label of `maia_tool_dispatch_total`. Before this file the observer
 * kept its OWN partial copy of the vocabulary and dropped everything it did not
 * recognise into `error`, so correct fail-closed refusals — a killed feature
 * flag, Redis down for a `redis_required` tool, an approval waiting on a human,
 * an MCP tool that is not approved — were counted as the platform BREAKING.
 * `maia:tool_error_ratio:rate5m` is the numerator of `MaiaToolErrorRateHigh`
 * (`monitoring/alerts/slo.rules.yml`), so governance working as designed paged
 * somebody. An SLI that does that trains people to ignore it.
 *
 * ### Why the sets live HERE and not in `observability/`
 *
 * A copy drifts. The producers (`_dispatcher.ts`, `mcp-bridge.ts`) own the
 * vocabulary and re-export their own list, and observability imports it.
 *
 * This module is a LEAF on purpose: zero imports, no `pg`, no config, no
 * registry. `_dispatcher.ts` already imports `observability/instrumentation.ts`,
 * so having instrumentation import the dispatcher back would be an ESM cycle
 * (and would drag the whole tool/governance/db graph into the metrics module).
 * A shared leaf keeps ownership in `src/tools/` without either cost.
 *
 * ### Keeping it honest
 *
 * `tests/unit/observability/tool-error-codes.spec.ts` STATICALLY SCANS
 * `_dispatcher.ts` and `mcp-bridge.ts` for every `error:` literal they can
 * return and asserts set EQUALITY with the lists below — so a new refusal code
 * cannot ship without being classified, and a code deleted here cannot linger.
 * That is exhaustiveness, not sampling.
 */

/**
 * Every code `src/tools/_dispatcher.ts` can return from its own body.
 * (It can ALSO return anything in `MCP_BRIDGE_ERROR_CODES`, because the MCP
 * branch returns the bridge's result verbatim.)
 */
export const DISPATCHER_ERROR_CODES = [
  'unknown_tool',
  'feature_disabled',
  'tool_disabled',
  'tool_not_granted',
  'invalid_args',
  'no_entity_in_scope',
  'forbidden',
  'redis_unavailable_blocked',
  'approval_pending',
  'requires_confirmation',
  'requires_dual_approval',
  'idempotency_payload_hash_collision',
  'idempotency_prior_failed',
  'idempotency_owner_failed',
  'idempotency_wait_timeout',
  'idempotency_completion_fenced',
  'turn_ownership_lost',
  // Issue #507 — o orçamento do turno acabou ANTES de a ferramenta começar.
  // Distinto de `turn_ownership_lost` de propósito: ali a tentativa deixou de
  // ser nossa, aqui ela ainda é — o que acabou foi o tempo. As triagens são
  // diferentes (takeover versus orçamento mal dimensionado), e um código só
  // apagaria a diferença justo no incidente em que ela importa.
  'turn_deadline_exceeded',
  // Issue #507 — o cancelamento chegou DEPOIS de o handler poder ter causado
  // efeito, e a ferramenta não é `abort_safe`. A resposta honesta é "não sei".
  'effect_unknown',
  'execution_failed',
] as const;

/** Every code `src/tools/mcp-bridge.ts` can return. */
export const MCP_BRIDGE_ERROR_CODES = [
  'feature_disabled',
  'unknown_tool',
  'tool_not_granted',
  'mcp_tool_not_executable',
  'forbidden',
  'requires_dual_approval',
  'invalid_args',
  'mcp_call_failed',
  // #504 — o bridge revalida a posse no PRÓPRIO limite de efeito (a chamada
  // HTTP ao servidor externo), então ele também produz esta recusa. Mesmo
  // código, mesma classificação REFUSAL do dispatcher: nada rodou.
  'turn_ownership_lost',
] as const;

export type DispatcherErrorCode = (typeof DISPATCHER_ERROR_CODES)[number];
export type McpBridgeErrorCode = (typeof MCP_BRIDGE_ERROR_CODES)[number];
export type ToolErrorCode = DispatcherErrorCode | McpBridgeErrorCode;

/**
 * **Refusal** — the platform DECIDED not to run the tool, and that decision is
 * the feature. A grant that does not cover the tool, a killed flag, a
 * constitutional rule, a threshold that demands a human, a dependency whose
 * absence makes the tool unsafe (`redis_unavailable_blocked` fences the
 * approval claim rather than losing evidence in `claimed`), an MCP tool that is
 * not approved / not read-only / on a disabled server.
 *
 * These belong to `maia:tool_blocked_ratio:rate5m`, NEVER to the error SLI:
 * a mis-scoped grant is a configuration problem, not an outage, and folding it
 * into the error rate makes the real error rate unreadable underneath it.
 */
export const TOOL_REFUSAL_CODES: readonly ToolErrorCode[] = Object.freeze([
  'feature_disabled',
  'tool_disabled',
  'tool_not_granted',
  'no_entity_in_scope',
  'forbidden',
  'redis_unavailable_blocked',
  'approval_pending',
  'requires_confirmation',
  'requires_dual_approval',
  'mcp_tool_not_executable',
  // #504 — a tentativa perdeu a posse do turno (lease morta ou takeover) e o
  // dispatcher recusou ANTES de executar. É REFUSAL, não FAILURE: nada rodou,
  // nenhum estado ficou pela metade, e a recusa é a feature — é o cancelamento
  // local que a issue exige. A anomalia em si já paga o seu alerta em
  // `maia_turn_lease_lost_total{reason}` (com `ops_alert`) e em
  // `maia_turn_effect_blocked_total{boundary}`; contá-la TAMBÉM no numerador de
  // `MaiaToolErrorRateHigh` faria um evento paginar duas vezes e tornaria o
  // error rate de tools ilegível durante um takeover legítimo.
  'turn_ownership_lost',
  // #507 — o prazo do turno acabou e a ferramenta NÃO COMEÇOU. Mesma família
  // do `turn_ownership_lost`: é o orçamento funcionando, nada rodou e nada
  // ficou pela metade. Um orçamento apertado demais aparece como um pico aqui,
  // e o lugar de olhar é o dimensionamento do deadline — não o error rate.
  'turn_deadline_exceeded',
]);

/**
 * **Invalid** — the CALL was malformed before any governance verdict: args the
 * schema rejected, or a tool name that does not exist. This tracks MODEL/prompt
 * quality and moves when the model or the tool schemas change; it is neither a
 * refusal (nothing was decided about permissions) nor our code breaking.
 */
export const TOOL_INVALID_CODES: readonly ToolErrorCode[] = Object.freeze([
  'invalid_args',
  'unknown_tool',
]);

/**
 * **Failure** — the platform broke, or reached a state that needs an engineer.
 * The handler threw, its output violated its own schema, the external MCP call
 * failed, or the idempotency ledger reached an anomalous state (a hash
 * collision is a derivation bug; a fenced completion is a lost lease; a
 * wait timeout is a hung owner). This is the numerator of
 * `MaiaToolErrorRateHigh`.
 */
export const TOOL_FAILURE_CODES: readonly ToolErrorCode[] = Object.freeze([
  'execution_failed',
  'mcp_call_failed',
  'idempotency_payload_hash_collision',
  'idempotency_prior_failed',
  'idempotency_owner_failed',
  'idempotency_wait_timeout',
  'idempotency_completion_fenced',
  // #507 — a plataforma NÃO SABE se o efeito aconteceu. Vai para o error SLI de
  // propósito, e é o único código aqui que não descreve uma quebra: descreve
  // uma DÍVIDA. Cada ponto desta série é uma reconciliação pendente — uma linha
  // `tool_effect_unknown` em `audit_logs` esperando alguém descobrir o que de
  // fato aconteceu. Contá-lo como refusal esconderia exatamente o que precisa
  // ser visto; contá-lo como sucesso seria a mentira que a #507 fecha.
  'effect_unknown',
]);

/**
 * The whole vocabulary, deduplicated. Equal by construction to the union of
 * the two producer lists — pinned by the spec, in both directions.
 */
export const TOOL_ERROR_CODES: readonly ToolErrorCode[] = Object.freeze([
  ...TOOL_REFUSAL_CODES,
  ...TOOL_INVALID_CODES,
  ...TOOL_FAILURE_CODES,
]);
