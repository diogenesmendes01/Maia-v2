/**
 * P9a — `tool_mediated` execution mode.
 *
 * Modo 3: dispatcher LLM-com-tools restrito por `skill.allowed_tools`. A
 * primeira interação do LLM pode produzir um ou mais `tool_use`; a skill
 * resolve cada tool via `dispatchToolByName` e devolve `tool_result`. O
 * loop encerra quando o LLM responde com `stop_reason='end_turn'` ou o
 * cap `max_tool_calls` é atingido (default 5).
 *
 * Caps enforced (review #99 finding 3 + mission item 3):
 *  - `runtime_hints.max_tool_calls`: counter; ao exceder → BLOQUEIA novas
 *    tool calls e devolve resultado parcial. Audit log emitido.
 *  - `runtime_hints.max_tokens`: contador acumula
 *    `input_tokens + output_tokens` em cada iteração; ao exceder →
 *    TRUNCA o loop, emite warning `token_budget_exceeded`, e retorna o
 *    último conteúdo capturado.
 *  - AbortSignal: respeitado entre iterações; toolDispatcher recebe o
 *    signal para que tools side-effecting possam cancelar.
 *
 * Master spec §2.4 + §3.4 (skill agent harness). Cada tool resolvida é
 * registrada em `tools_called` (passado para o trace pelo SkillRunner).
 *
 * Fora do escopo deste modo (decisão do P9a, ainda em aberto):
 *  - Resolução por-tool de policy_descriptors (cada tool pode ter sua
 *    própria política aplicada). P9d/P10 já entregaram o Policy DSL e os
 *    PEPs, mas a resolução por-tool DENTRO deste loop nunca foi feita —
 *    segue em aberto, agora desbloqueada.
 *  - Streaming de tool_use (assumimos modo síncrono)
 */
import { callLLM, type LLMMessage, type ToolSchema } from '@/lib/claude.js';
import { getToolSchemasByName, describeExposedSchemas } from '@/tools/_registry.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import {
  getCurrentAgent,
  getCurrentTenant,
  MissingTenantContextError,
} from '@/db/tenant-context.js';
import type { ModeContext } from '../types.js';
import { resolveSkillToolScope } from '@/tools/grant-math.js';

/**
 * Deterministic hash of arbitrary args for idempotency key derivation.
 * Not cryptographic — used only to distinguish distinct tool invocations
 * within the same turn (round-2 review #99 finding 3).
 */
function simpleArgsHash(args: unknown): string {
  const json = JSON.stringify(args, Object.keys(args && typeof args === 'object' ? args as object : {}).sort());
  let h = 5381;
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) + h) ^ json.charCodeAt(i);
    h >>>= 0; // keep 32-bit unsigned
  }
  return h.toString(16);
}

interface ProcedureSpec {
  system_prompt?: string;
  template?: string;
  tool_schemas?: ToolSchema[];
}

/**
 * Tool dispatcher contract for tool_mediated mode.
 *
 * **Cache wrapper contract (issue #261 follow-up):** the injected dispatcher
 * MUST route through `src/tools/_dispatcher.ts` (or equivalent tenant-scoped
 * cache wrapper) so that the tenant+agent-scoped idempotency cache lookup
 * (`idempotencyRepo.lookup`/`.store`) is applied. `_dispatcher.ts` computes
 * its OWN cache key via `computeIdempotencyKey()` — which folds
 * tenant_id/agent_id from ALS into the SHA — and reads/writes through the
 * composite-PK `(tenant_id, agent_id, key)` row. A dispatcher that bypasses
 * `_dispatcher.ts` (e.g. calls a tool handler directly with no cache layer)
 * RE-OPENS the cross-tenant collision surface that issue #261 closed.
 *
 * The `opts.idempotency_key` passed here is an OPAQUE correlation ID derived
 * from `tenant:agent:skill:version:turno_id:tool:args_hash` — useful for
 * dispatcher-side telemetry and dedup-within-the-LLM-loop. It is **NOT** the
 * cache key written to `idempotency_keys`: the production wrapper recomputes
 * a stricter key from `computeIdempotencyKey()` over the validated tool args.
 * Treating `opts.idempotency_key` as the storage key in a custom dispatcher
 * implementation would skip the tool-arg validation and the
 * tenant-context-resolution guarantees of `computeIdempotencyKey`.
 *
 * **Production enforcement status (PR #273 review iter 2/4):**
 *
 * Today, the cache-wrapper contract above is CONTRACTUAL (JSDoc + tests in
 * `tests/unit/skills/p9a-round2-guard.spec.ts:329`), NOT type-system
 * enforced. The Codex primary review of PR #273 flagged this as residual
 * risk; the reval downgraded it to non-blocking on these grounds:
 *
 *  1. `setToolDispatcher` is NOT wired in production today. The agent's
 *     main path (`src/agent/core.ts` → ReAct loop → `dispatchTool`) reaches
 *     tool execution through `src/tools/_dispatcher.ts:144-152` directly,
 *     so the tenant+agent-scoped `computeIdempotencyKey` + `idempotencyRepo`
 *     are always invoked. No customer-facing surface exercises
 *     `toolDispatcher` yet — the bypass is theoretical until Phase 2.
 *  2. Tests in `p9a-round2-guard.spec.ts:329-384` pin that the dispatchKey
 *     passed to a custom dispatcher already carries `tenant_id:agent_id:...`
 *     in its prefix, so even a non-cache-aware dispatcher CANNOT collide
 *     cross-tenant by accident on the correlation ID.
 *
 * **Phase 2 typed bridge plan (`docs/skill-execution-f1-spec.md §5`):**
 *
 * When `tool_mediated` mode goes live (Phase 2 of the skill-execution F1
 * roll-out), `setToolDispatcher` MUST be wired to a typed bridge over
 * `dispatchTool` that:
 *
 *   (a) accepts a `ToolContext{pessoa, scope, conversa, mensagem_id}` threaded
 *       in via `ModeContext` (so `dispatchTool` has its required context),
 *   (b) routes the call through `_dispatcher.ts`'s ID-scoped cache layer
 *       (NOT directly to a tool's `handler`),
 *   (c) carries a `side_effects_started` / terminality flag so a failure
 *       between cache-miss and cache-store cannot cause double execution,
 *   (d) is the ONLY exported wiring point in production code (a `module.ts`
 *       boundary; tests can still inject mocks).
 *
 * Until Phase 2 ships, this file MUST NOT be reached in production. The
 * `execution_mode` gate in `src/skills/run-skill.ts` is the kill-switch
 * (see `docs/skill-execution-f1-spec.md §4.1`).
 */
export interface ToolDispatcher {
  (
    name: string,
    args: unknown,
    opts?: { signal?: AbortSignal; idempotency_key?: string },
  ): Promise<unknown>;
}

let toolDispatcher: ToolDispatcher | null = null;

/**
 * Permite injeção do dispatcher de tools (real registry em produção;
 * mock em testes). Em ausência de dispatcher injetado, qualquer
 * tool_use lança `tool_dispatcher_not_configured`.
 *
 * **Production wiring contract (issue #261):** the injected dispatcher MUST
 * route through `src/tools/_dispatcher.ts` (which calls
 * `computeIdempotencyKey()` and `idempotencyRepo.lookup`/`.store` with the
 * tenant+agent-scoped composite key). A dispatcher that bypasses
 * `_dispatcher.ts` and calls tool handlers directly re-opens the
 * cross-tenant cache-leak surface that issue #261 closed. See
 * `ToolDispatcher` JSDoc above for the full contract.
 */
export function setToolDispatcher(d: ToolDispatcher | null): void {
  toolDispatcher = d;
}

export async function toolMediatedMode(
  ctx: ModeContext,
): Promise<Record<string, unknown>> {
  const procedure = (ctx.skill.procedure ?? {}) as ProcedureSpec;
  const hints = (ctx.skill.runtime_hints ?? {}) as Record<string, unknown>;
  // Issue #408 — SkillToolScope. `allowed_tools` is the existing allowlist;
  // `denied_tools` (from `blocked_tools` / `runtime_hints.denied_tools`) is a
  // HARD deny applied here at the executor (defense in depth alongside the
  // visibility filter). `requires_confirmation_for` is carried by the decision
  // packet, not enforced as a visibility filter here.
  const skillScope = resolveSkillToolScope(ctx.skill);
  const allowedTools = [...(skillScope.allowed_tools ?? [])];
  const deniedTools = new Set(skillScope.denied_tools ?? []);

  const system = procedure.system_prompt ?? procedure.template ?? '';
  const max_tokens = typeof hints.max_output_tokens === 'number' ? hints.max_output_tokens : 2048;
  const maxToolCalls = typeof hints.max_tool_calls === 'number' ? hints.max_tool_calls : 5;
  // Total prompt+output token budget enforced across the loop (review #99
  // mission item 3). When exceeded, we truncate the loop and emit warning.
  const maxTokensBudget =
    typeof hints.max_tokens === 'number'
      ? hints.max_tokens
      : typeof hints.max_prompt_tokens === 'number'
      ? hints.max_prompt_tokens + max_tokens * (maxToolCalls + 1)
      : Number.POSITIVE_INFINITY;

  // Resolve tool schemas from the registry for tools declared in allowed_tools
  // and NOT in denied_tools (defense in depth — #408 SkillToolScope HARD deny).
  // Schemas are NOT stored in procedure.tool_schemas to avoid drift between the
  // registry and seed SQL; they are always derived from the live registry.
  const visibleNames = allowedTools.filter((t) => !deniedTools.has(t));
  const tools: ToolSchema[] = getToolSchemasByName(visibleNames);

  // Issue #509 — schema identity + budget for THIS skill's exposed set. The
  // agent hot path records the same digest in its `tool_visibility_resolved`
  // audit row; this path has no such audit, so the trace lives in the log.
  // Contract identity only: no schema bodies, no arguments.
  {
    const digest = describeExposedSchemas(
      tools.map((t) => t.name),
      'skill_tool_mediated',
    );
    logger.debug(
      {
        skill_id: ctx.skill.id,
        tool_schema_set_hash: digest.set_hash,
        tool_schema_bytes: digest.bytes,
        tools: digest.tools,
      },
      'p9a.tool_schemas_resolved',
    );
  }

  const messages: LLMMessage[] = [{ role: 'user', content: JSON.stringify(ctx.input) }];
  const toolsCalled: string[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let toolCallCount = 0;
  let lastContent: string | null = null;
  let tokenBudgetExceeded = false;
  let toolCapHit = false;

  // Stable idempotency key base (round-2 review #99 finding 3).
  //
  // Requirements:
  //  - Must survive retries of the same execution attempt (same key → dedupe).
  //  - Must NOT collide across distinct turns even if a provider repeats a
  //    tool_use id.
  //  - Must fail-closed when no stable execution/turn ID is available.
  //
  // Key shape: tenant:agent:skill_id:skill_version:turno_id_or_conversa_id
  // Per-dispatch suffix: tool_name:args_hash (appended in the loop below,
  // replacing the unreliable LLM-generated tool_use.id as sole discriminant).
  const stableExecId = ctx.turno_id ?? ctx.conversa_id ?? null;
  if (!stableExecId) {
    throw new Error(
      'idempotency_key_unstable: tool_mediated skills require a stable turno_id or conversa_id in ModeContext to derive idempotency keys; aborting to prevent duplicate side effects',
    );
  }
  // Fail-closed on missing ALS context (issue #262). Previously the code
  // degraded to a shared 'unknown:unknown' bucket via `tryGetCurrentContext`,
  // which (a) opened a cross-tenant idempotency collision surface and
  // (b) silenced caller bugs that forgot to wrap execution in
  // `runWithTenantContext`. We now match the fail-closed pattern of
  // rulesRepo / agent_memories / ledgers (#232/#237/#241/#243): if there
  // is no active tenant context, `getCurrentTenant`/`getCurrentAgent`
  // throw `MissingTenantContextError` so the misuse surfaces loudly.
  // In production, the SkillRunner (gate 1.5) already guarantees context
  // exists before dispatching here, so this only fires on direct calls
  // or test misconfiguration.
  //
  // Observability (PR #269 reval): emit a structured log + counter BEFORE
  // re-throwing so rejections are visible in production even when no
  // upstream handler captures the error. Without this, fail-closed
  // rejections at this gate would be silent in metrics/dashboards and only
  // discoverable via incidental error traces.
  let tenant: string;
  let agent: string;
  try {
    tenant = getCurrentTenant();
    agent = getCurrentAgent();
  } catch (err) {
    if (err instanceof MissingTenantContextError) {
      logger.warn(
        {
          code: err.code,
          skill_id: ctx.skill.id,
          skill_version: ctx.skill.version,
          turno_id: ctx.turno_id ?? null,
          conversa_id: ctx.conversa_id ?? null,
        },
        'p9a.tool_mediated.missing_tenant_context',
      );
      incCounter('maia_tool_mediated_missing_tenant_context_total', {
        skill_id: ctx.skill.id,
      });
    }
    throw err;
  }
  const idempotencyBase = `${tenant}:${agent}:${ctx.skill.id}:${ctx.skill.version}:${stableExecId}`;

  // Safety upper bound for the loop: allow a few extra iterations beyond
  // max_tool_calls so the LLM can wrap up its answer after we soft-block
  // further tool dispatch (review #99 mission item 3). Throws
  // `max_tool_calls_exceeded` only if even this larger bound is exceeded
  // (defense against runaway LLM that keeps re-requesting tools).
  const loopUpperBound = maxToolCalls + 5;
  for (let i = 0; i <= loopUpperBound; i++) {
    // Pre-iteration abort check — caller / runner timeout cuts the loop
    // before issuing a new LLM call.
    if (ctx.signal?.aborted) {
      throw new Error('aborted');
    }
    const res = await callLLM({
      system,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      max_tokens,
      // Forwarded so the SDK cancels the in-flight HTTP request when the
      // SkillRunner aborts mid-iteration. Pre/post-iteration abort checks
      // above already cut the loop; this catches cancellation that lands
      // while the LLM call itself is pending. Issue #220.
      signal: ctx.signal,
    });
    totalIn += res.usage.input_tokens;
    totalOut += res.usage.output_tokens;
    if (res.content !== null) lastContent = res.content;

    // Token-budget enforcement (review #99 mission item 3): truncate
    // before issuing further tool calls or new iterations.
    if (totalIn + totalOut > maxTokensBudget) {
      tokenBudgetExceeded = true;
      logger.warn(
        {
          skill_id: ctx.skill.id,
          tokens_in: totalIn,
          tokens_out: totalOut,
          budget: maxTokensBudget,
        },
        'p9a.tool_mediated.token_budget_exceeded',
      );
      break;
    }

    if (res.tool_uses.length === 0 || res.stop_reason === 'end_turn') {
      // No more tool calls — final answer is text content.
      const parsed = safeParseJson(lastContent ?? '');
      return {
        ...parsed,
        _tools_called: toolsCalled,
        _tokens_in: totalIn,
        _tokens_out: totalOut,
        _token_budget_exceeded: tokenBudgetExceeded,
        _tool_cap_hit: toolCapHit,
      };
    }

    if (i === loopUpperBound) {
      throw new Error('max_tool_calls_exceeded');
    }

    // Append assistant turn with tool_uses
    messages.push({
      role: 'assistant',
      content: [
        ...(res.content ? [{ type: 'text' as const, text: res.content }] : []),
        ...res.tool_uses.map((tu) => ({
          type: 'tool_use' as const,
          id: tu.id,
          name: tu.tool,
          input: tu.args,
        })),
      ],
    });

    // Dispatch each tool, append tool_results in a single user turn.
    const toolResults: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }> = [];
    for (const tu of res.tool_uses) {
      // Cap enforcement (review #99 mission item 3): when we have already
      // reached the cap, refuse further dispatch and emit a tool_result
      // marking it so the LLM stops. We do NOT raise — partial-result
      // path is preferable for the agent to wrap up its answer.
      if (toolCallCount >= maxToolCalls) {
        toolCapHit = true;
        logger.warn(
          { skill_id: ctx.skill.id, max_tool_calls: maxToolCalls, tool: tu.tool },
          'p9a.tool_mediated.tool_call_cap_hit',
        );
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: 'tool_call_cap_reached',
          is_error: true,
        });
        continue;
      }
      // Abort check before dispatch (review #99 finding 3): if the runner
      // signaled cancellation while we were filling toolResults, refuse to
      // start a new side-effecting tool call.
      if (ctx.signal?.aborted) {
        throw new Error('aborted');
      }
      if (!allowedTools.includes(tu.tool) || deniedTools.has(tu.tool)) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `tool_not_allowed: ${tu.tool}`,
          is_error: true,
        });
        continue;
      }
      if (!toolDispatcher) {
        throw new Error('tool_dispatcher_not_configured');
      }
      try {
        // Per-dispatch correlation ID: base + tool_name + args_hash (NOT tu.id,
        // which is LLM-generated and may repeat across turns per provider).
        //
        // Cache wrapper contract (issue #261): the injected `toolDispatcher`
        // MUST route through `src/tools/_dispatcher.ts` (or an equivalent
        // tenant-scoped cache wrapper) for the cross-tenant invariant to
        // hold. `_dispatcher.ts` computes its OWN cache key via
        // `computeIdempotencyKey()` (folding tenant_id/agent_id from ALS into
        // the SHA) and reads/writes through `idempotencyRepo` against the
        // composite-PK `(tenant_id, agent_id, key)`. The `dispatchKey` below
        // is an opaque correlation ID — useful for telemetry and dedup
        // within this LLM loop, but NOT the row key written to
        // `idempotency_keys`. See `ToolDispatcher` JSDoc above.
        const dispatchKey = `${idempotencyBase}:${tu.tool}:${simpleArgsHash(tu.args)}`;
        const result = await toolDispatcher(tu.tool, tu.args, {
          signal: ctx.signal,
          idempotency_key: dispatchKey,
        });
        toolCallCount++;
        toolsCalled.push(tu.tool);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const e = err as Error;
        // Propagate cancellation upward — never swallow an abort into the
        // tool-result stream as a normal error (review #99 finding 3).
        if (e.message === 'aborted' || ctx.signal?.aborted) {
          throw new Error('aborted', { cause: err });
        }
        logger.warn({ skill_id: ctx.skill.id, tool: tu.tool, err: e.message }, 'p9a.tool_dispatch_error');
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `error: ${e.message}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Loop exited via break (token budget) or natural end — return what we have.
  if (tokenBudgetExceeded) {
    const parsed = safeParseJson(lastContent ?? '');
    return {
      ...parsed,
      _tools_called: toolsCalled,
      _tokens_in: totalIn,
      _tokens_out: totalOut,
      _token_budget_exceeded: true,
      _tool_cap_hit: toolCapHit,
    };
  }

  throw new Error('tool_loop_exhausted_without_resolution');
}

function safeParseJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { text: trimmed };
  }
}
