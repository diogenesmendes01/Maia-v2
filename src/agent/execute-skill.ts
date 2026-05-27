/**
 * F1 Phase 1 — Decision-Engine-driven skill execution at the agent hot path.
 *
 * When the Decision Engine routes a turn to `action_mode='execute_skill'`
 * (only for a selected skill whose `execution_mode ∈ {prompt_only, evaluator}`
 * — terminal, side-effect free; see spec §4.1), `agent/core.ts` calls
 * `executeSelectedSkill` instead of going straight to the LLM/ReAct turn.
 *
 * Safety contracts (spec §0 + §4) — ALL enforced here:
 *  1. Immutable identity (Codex HIGH-1): the packet carries the skill's
 *     descriptor + version pinned at decision time. We re-resolve the active
 *     skill by descriptor under the routed agent and assert its `id`/`version`
 *     still equal the pinned values BEFORE executing. A mismatch (activate /
 *     rollback race, or a routed-agent divergence) ⇒ we DO NOT execute; we log
 *     `skill.identity_mismatch` and fall through to the normal turn.
 *  2. Output safety (Codex HIGH-3): a successful skill reply is delivered
 *     through `dispatchOutput` (view-once for sensitive, outbound audit,
 *     pending-question + media handling), NEVER raw `sendOutbound`. If the skill
 *     produced no `reply` string we fall through rather than fabricate text.
 *  3. Fall-through on failure: `prompt_only`/`evaluator` have NO side effects,
 *     so any `!result.ok` is safe to degrade to the normal LLM/ReAct turn (no
 *     double-action risk). We log `skill.execution_failed{reason}` and fall
 *     through. (The reason-restriction in spec §4.2 only bites once Phase 2
 *     adds side-effecting modes.)
 *
 * This module is deliberately dependency-injected (runSkill / resolveActiveSkill
 * / dispatchOutput / logger) so the HIGH-risk decision logic is unit-testable
 * without the agent's DB + network stack.
 */
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';
import type {
  SkillExecutionInput,
  SkillExecutionOutput,
} from '@/skills/types.js';
import type { DispatchOutputCtx } from './output-dispatch.js';

/** Minimal active-skill identity needed for the pre-execution assert. */
export interface ActiveSkillIdentity {
  id: string;
  version: number;
}

/** The pinned identity carried on `DecisionPacket.routing`. */
export interface PinnedSkillIdentity {
  selected_skill_descriptor: string;
  selected_skill_version: number;
  selected_skill_id: string;
}

/**
 * Outcome of an execute_skill attempt.
 *  - `handled: true`  — the skill ran and its reply was dispatched; core.ts
 *    MUST run the terminal-path invariants (touch + markAllProcessed +
 *    clearDebounceState) and `return` (no LLM turn).
 *  - `handled: false` — fall through to the normal LLM/ReAct turn. `reason`
 *    is for logging/metrics only.
 */
export type ExecuteSkillOutcome =
  | { handled: true }
  | {
      handled: false;
      reason:
        | 'no_pinned_identity'
        | 'identity_mismatch'
        | 'skill_not_resolved'
        | 'execution_failed'
        | 'dispatch_send_failed'
        | 'no_reply';
    };

export interface ExecuteSelectedSkillDeps {
  /** Re-resolve the currently-active skill (by descriptor, under routed agent). */
  resolveActiveSkill: (
    descriptor: string,
    agent_id: string,
  ) => Promise<ActiveSkillIdentity | null>;
  /** Execute the skill (the stable P9a SkillRunner). */
  runSkill: (input: SkillExecutionInput) => Promise<SkillExecutionOutput>;
  /** Deliver the skill reply through the shared outbound pipeline. */
  dispatchOutput: (ctx: DispatchOutputCtx) => Promise<void>;
  logger: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
}

export interface ExecuteSelectedSkillArgs {
  pinned: PinnedSkillIdentity | null;
  routedAgentId: string;
  pessoa: Pessoa;
  conversa: Conversa;
  inbound: Mensagem;
  jid: string;
  /** Aggregated inbound text for this (possibly debounced) turn. */
  aggregatedText: string;
  signal?: AbortSignal;
}

/**
 * Build the skill input payload (spec §4.3). The skill's `input_schema`
 * validates this inside the SkillRunner (Gate 3) — we pass the conventional
 * `{ message, pessoa_id, conversa_id }` shape.
 */
export function buildSkillInput(args: {
  message: string;
  pessoa_id: string;
  conversa_id: string;
}): Record<string, unknown> {
  return {
    message: args.message,
    pessoa_id: args.pessoa_id,
    conversa_id: args.conversa_id,
  };
}

/**
 * Map a successful `SkillExecutionOutput` to a `dispatchOutput` payload
 * (spec §4.4). Convention: `output.reply: string` is the user-facing text.
 *
 * Returns `null` when there is no usable `reply` string — the caller then
 * falls through to the normal turn rather than fabricating text. The returned
 * object is the dispatch-relevant subset; the caller fills the channel context
 * (pessoa/conversa/inbound/jid). `turnHasSensitive` is derived from the skill
 * output so `dispatchOutput` applies view-once to sensitive replies.
 *
 * EVALUATOR CONTRACT (Codex #216 review item 4): an `evaluator`-mode skill is
 * allowed in the execute gate, but to be user-TERMINAL it must place its
 * user-facing text in `output.reply` like any other mode. Its native
 * `{ score, verdict, reasons }` are internal (audit/log) and are NEVER shown to
 * the user — an evaluator that produces no `reply` returns null here and the
 * caller falls through to the normal turn (a verdict-only evaluator never
 * surfaces raw scores to the user).
 *
 * A whitespace-only `reply` is treated as absent (item 8) so we never dispatch
 * a visibly blank message.
 */
export function buildSkillReply(result: SkillExecutionOutput): {
  text: string;
  turnHasSensitive: boolean;
  sensitiveTools: string[];
} | null {
  if (!result.ok) return null;
  const output = result.output;
  if (!output) return null;
  const reply = output['reply'];
  if (typeof reply !== 'string' || reply.trim().length === 0) return null;
  // A skill may flag its output sensitive (e.g. balance-like data) so the
  // outbound is delivered view-once. We read `output.sensitive === true`
  // conservatively; absent ⇒ not sensitive.
  const turnHasSensitive = output['sensitive'] === true;
  return {
    text: reply,
    turnHasSensitive,
    sensitiveTools: turnHasSensitive ? ['skill_output'] : [],
  };
}

/**
 * Execute the skill the Decision Engine selected, enforcing the safety
 * contracts above. Returns an outcome the caller uses to decide whether to run
 * the terminal-path invariants + `return`, or fall through to the normal turn.
 *
 * The caller (core.ts) is responsible for `conversasRepo.touch` /
 * `markAllProcessed` / `clearDebounceState` on `{ handled: true }` — they need
 * the caller's turn-scoped closures and are asserted by tests at that layer.
 */
export async function executeSelectedSkill(
  args: ExecuteSelectedSkillArgs,
  deps: ExecuteSelectedSkillDeps,
): Promise<ExecuteSkillOutcome> {
  const { pinned, routedAgentId, pessoa, conversa, inbound, jid } = args;

  // Contract 1a: the engine must have pinned the skill's stable identity. If it
  // didn't (legacy/stub skill with no descriptor/version), we cannot safely
  // re-resolve + assert ⇒ fall through.
  if (
    !pinned ||
    !pinned.selected_skill_descriptor ||
    pinned.selected_skill_version === undefined ||
    pinned.selected_skill_version === null ||
    !pinned.selected_skill_id
  ) {
    deps.logger.warn(
      { conversa_id: conversa.id, turno_id: inbound.id },
      'skill.execute_skipped_no_pinned_identity',
    );
    return { handled: false, reason: 'no_pinned_identity' };
  }

  // Contract 1b: re-resolve the active skill by descriptor under the routed
  // agent and assert id + version still match. This closes the activate/
  // rollback race (Codex HIGH-1) — never execute a divergent row.
  const active = await deps.resolveActiveSkill(
    pinned.selected_skill_descriptor,
    routedAgentId,
  );
  if (!active) {
    deps.logger.warn(
      {
        conversa_id: conversa.id,
        turno_id: inbound.id,
        skill_descriptor: pinned.selected_skill_descriptor,
        agent_id: routedAgentId,
      },
      'skill.identity_mismatch',
    );
    return { handled: false, reason: 'skill_not_resolved' };
  }
  if (
    active.id !== pinned.selected_skill_id ||
    active.version !== pinned.selected_skill_version
  ) {
    deps.logger.warn(
      {
        conversa_id: conversa.id,
        turno_id: inbound.id,
        skill_descriptor: pinned.selected_skill_descriptor,
        pinned_id: pinned.selected_skill_id,
        pinned_version: pinned.selected_skill_version,
        active_id: active.id,
        active_version: active.version,
      },
      'skill.identity_mismatch',
    );
    return { handled: false, reason: 'identity_mismatch' };
  }

  // Contract 2 (input): build the validated input payload.
  const runInput: SkillExecutionInput = {
    skill_descriptor: pinned.selected_skill_descriptor,
    input: buildSkillInput({
      message: args.aggregatedText,
      pessoa_id: pessoa.id,
      conversa_id: conversa.id,
    }),
    conversa_id: conversa.id,
    turno_id: inbound.id,
    triggered_by: 'user_message',
    agent_id: routedAgentId,
    // Immutable-identity pin (Codex #216 review HIGH-B): make runSkill assert
    // the row it re-resolves is STILL the one we validated, closing the TOCTOU
    // between our pre-check and runSkill's own lookup.
    expected_skill_id: pinned.selected_skill_id,
    expected_skill_version: pinned.selected_skill_version,
    ...(args.signal ? { signal: args.signal } : {}),
  };

  // Contract 3 (item 1, Codex #216 review): runSkill must never throw past
  // here. A rejection/timeout is treated exactly like a resolved `!ok` — log
  // `skill.execution_failed` and fall through. prompt_only/evaluator have no
  // side effects, so a pre-dispatch failure is always safe to degrade to the
  // normal LLM/ReAct turn (no double-action risk — nothing was sent yet).
  let result: SkillExecutionOutput;
  try {
    result = await deps.runSkill(runInput);
  } catch (e) {
    deps.logger.warn(
      {
        conversa_id: conversa.id,
        turno_id: inbound.id,
        skill_descriptor: pinned.selected_skill_descriptor,
        reason: (e as Error).message,
      },
      'skill.execution_failed',
    );
    return { handled: false, reason: 'execution_failed' };
  }

  // Contract 3: prompt_only/evaluator have no side effects — any failure is
  // safe to degrade to the normal LLM/ReAct turn.
  if (!result.ok) {
    deps.logger.warn(
      {
        conversa_id: conversa.id,
        turno_id: inbound.id,
        skill_descriptor: pinned.selected_skill_descriptor,
        reason: result.reason,
      },
      'skill.execution_failed',
    );
    return { handled: false, reason: 'execution_failed' };
  }

  // Contract 2 (output): map to dispatchOutput; no reply ⇒ fall through.
  const reply = buildSkillReply(result);
  if (!reply) {
    deps.logger.warn(
      {
        conversa_id: conversa.id,
        turno_id: inbound.id,
        skill_descriptor: pinned.selected_skill_descriptor,
      },
      'skill.execution_no_reply_fallthrough',
    );
    return { handled: false, reason: 'no_reply' };
  }

  // Contract 2: deliver through the shared pipeline (view-once / audit /
  // pending / media) — never raw sendOutbound.
  //
  // EXACTLY-ONCE (Codex #216 review HIGH-A): dispatchOutput sends to the channel
  // BEFORE persisting, so the typed OutboundDeliveryError tells us WHICH phase
  // failed and we react accordingly (LLM-first: prefer letting ReAct recover):
  //   - delivered === false (send threw, NOTHING reached the user) → fall
  //     through to the normal ReAct turn so the agent still answers with a real,
  //     adaptive reply. Safe: nothing was sent, so there is no double-send.
  //   - delivered === true / unknown (sent, persist failed) → report handled
  //     WITHOUT re-sending (a fall-through would double-send a financial
  //     message) and log the inconsistency loudly for ops reconciliation.
  // A canned fallback is reserved for Phase-2 "last resort" cases (e.g. a
  // side-effecting confirmation that must NOT let ReAct improvise); Phase 1 only
  // runs side-effect-free prompt_only/evaluator, so ReAct recovery is best.
  try {
    await deps.dispatchOutput({
      pessoa,
      conversa,
      inbound,
      jid,
      text: reply.text,
      latestPending: null,
      latestReportPdf: null,
      turnHasSensitive: reply.turnHasSensitive,
      sensitiveTools: reply.sensitiveTools,
    });
  } catch (e) {
    const delivered = (e as { delivered?: unknown }).delivered;
    if (delivered === false) {
      // Pre-send failure: nothing reached the user. Fall through to the normal
      // ReAct turn so the agent still answers (a real, adaptive reply). Safe —
      // nothing was sent, so there is no double-send risk.
      deps.logger.warn(
        {
          conversa_id: conversa.id,
          turno_id: inbound.id,
          skill_descriptor: pinned.selected_skill_descriptor,
          err: (e as Error).message,
        },
        'skill.dispatch_send_failed_fallthrough',
      );
      return { handled: false, reason: 'dispatch_send_failed' };
    }
    // delivered === true (sent, persist failed) OR unknown error: the message
    // likely reached the user — report handled WITHOUT re-sending (no
    // double-send) and log the inconsistency loudly for ops reconciliation.
    deps.logger.error(
      {
        conversa_id: conversa.id,
        turno_id: inbound.id,
        skill_descriptor: pinned.selected_skill_descriptor,
        skill_version: pinned.selected_skill_version,
        err: (e as Error).message,
        ops_alert: true,
      },
      'skill.dispatch_failed_after_send_inconsistency',
    );
    return { handled: true };
  }

  deps.logger.info(
    {
      conversa_id: conversa.id,
      turno_id: inbound.id,
      skill_descriptor: pinned.selected_skill_descriptor,
      skill_version: pinned.selected_skill_version,
    },
    'skill.executed',
  );
  return { handled: true };
}
