import type { Pessoa, Conversa } from '@/db/schema.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import { canAct } from '@/governance/permissions.js';
import { constitutionalCheck } from '@/governance/rules.js';
import { REGISTRY, isToolEnabled, type AnyTool } from './_registry.js';
import { computeIdempotencyKey, computePayloadHash } from '@/governance/idempotency.js';
import { idempotencyRepo, idempotencyOutboxRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { isRedisConnected } from '@/lib/redis.js';
import { logger } from '@/lib/logger.js';
import type { ActionKey } from '@/governance/audit-actions.js';
import { featureFlags } from '@/config/feature-flags.js';

export type ToolContext = {
  pessoa: Pessoa;
  scope: { entidades: string[]; byEntity: Map<string, ResolvedPermission> };
  conversa: Conversa;
  mensagem_id: string;
  request_id: string;
};

export type DispatchResult = unknown | { error: string; details?: unknown };

type FieldType = 'string' | 'number' | 'boolean';
type FieldTypeMap = { string: string; number: number; boolean: boolean };

/**
 * Safely narrow a single field from a Zod-validated args object whose runtime
 * shape varies per tool. Zod has already validated the value against the
 * tool's schema; this helper just performs a typeof check before exposing the
 * field to the dispatcher's cross-tool code paths (entidade_id, valor,
 * dual_approval_granted, file_sha256).
 */
type UnknownBag = { [k: string]: unknown };

function pickToolField<K extends FieldType>(
  args: unknown,
  key: string,
  type: K,
): FieldTypeMap[K] | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const bag = args as UnknownBag;
  const v = bag[key];
  return typeof v === type ? (v as FieldTypeMap[K]) : undefined;
}

export async function dispatchTool(input: {
  tool: string;
  args: unknown;
  ctx: ToolContext;
}): Promise<DispatchResult> {
  const tool = REGISTRY[input.tool] as AnyTool | undefined;
  if (!tool) return { error: 'unknown_tool', details: { tool: input.tool } };

  // Codex review #105 (medium): kill-switch em runtime. `REGISTRY` é
  // construído no module-load; quando um flag é killado depois, processos
  // já em execução ainda exporiam (e executariam) o tool sem essa checagem.
  // Verifica AQUI, antes de auth e idempotência, para que o flag desligado
  // bloqueie execução imediatamente — incluindo retries de tools cacheadas.
  // Per-tool `feature_flag` é mais específico que o gate KSM genérico, então
  // vem primeiro e retorna o erro tipado `feature_disabled` com o flag name.
  if (tool.feature_flag !== undefined && !featureFlags.isEnabled(tool.feature_flag)) {
    return {
      error: 'feature_disabled',
      details: { tool: tool.name, feature_flag: tool.feature_flag },
    };
  }

  // P10a (review #104 high): runtime feature-flag gate genérico (KSM
  // propose_* tools). A killed feature flag must block the handler
  // in-flight, not just hide the schema. Without this, the LLM could
  // still call propose_* during a canary rollback and produce rows whose
  // lifecycle columns may not exist in the database yet.
  if (!isToolEnabled(input.tool)) {
    return {
      error: 'tool_disabled',
      details: { tool: input.tool, reason: 'feature_flag_off' },
    };
  }

  const parsed = tool.input_schema.safeParse(input.args);
  if (!parsed.success) {
    return { error: 'invalid_args', details: parsed.error.issues };
  }
  const args = parsed.data;

  const entity_id =
    pickToolField<'string'>(args, 'entidade_id', 'string') ?? input.ctx.scope.entidades[0];
  if (!entity_id) return { error: 'no_entity_in_scope' };

  const resolved = input.ctx.scope.byEntity.get(entity_id);

  // Constitutional rules apply BEFORE per-action permission checks: hard
  // limits, dual-approval gates and cross-entity guards must short-circuit
  // even if the profile would otherwise authorize the action.
  const violation = constitutionalCheck({
    intent: { tool: tool.name, args },
    pessoa: input.ctx.pessoa,
    resolved: resolved ?? null,
    scope: { entidades: input.ctx.scope.entidades },
    dual_approval_granted:
      pickToolField<'boolean'>(args, 'dual_approval_granted', 'boolean') === true,
  });
  if (violation) {
    await audit({
      acao: 'unauthorized_access_attempt',
      pessoa_id: input.ctx.pessoa.id,
      conversa_id: input.ctx.conversa.id,
      mensagem_id: input.ctx.mensagem_id,
      metadata: { tool: tool.name, violation },
    });
    if (violation.kind === 'forbidden') {
      return { error: 'forbidden', details: { rule_id: violation.rule_id, reason: violation.reason } };
    }
    return {
      error: 'requires_dual_approval',
      details: { reason: violation.reason },
    };
  }

  for (const action of tool.required_actions as ActionKey[]) {
    const allow = canAct({
      pessoa: input.ctx.pessoa,
      resolved: resolved ?? null,
      action,
      valor: pickToolField<'number'>(args, 'valor', 'number'),
    });
    if (!allow.allowed) {
      await audit({
        acao: 'unauthorized_access_attempt',
        pessoa_id: input.ctx.pessoa.id,
        conversa_id: input.ctx.conversa.id,
        mensagem_id: input.ctx.mensagem_id,
        metadata: { tool: tool.name, action, reason: allow.reason },
      });
      return { error: 'forbidden', details: { reason: allow.reason } };
    }
  }

  if (tool.redis_required && !isRedisConnected()) {
    return { error: 'redis_unavailable_blocked' };
  }

  const file_sha256 = pickToolField<'string'>(args, 'file_sha256', 'string');
  const idempotency_key = computeIdempotencyKey({
    pessoa_id: input.ctx.pessoa.id,
    entity_id,
    tool_name: tool.name,
    operation_type: tool.operation_type,
    payload: args,
    file_sha256,
  });
  // #299: payload_hash is INDEPENDENT of idempotency_key (no bucket). On a
  // cache hit `tryReserve` re-checks the stored row's payload_hash against
  // this value — defends against key collision (truncated hash, derivator
  // regression, or stale cache after a schema change) returning a wrong
  // cached result for a DISTINCT payload. Note that before #298 the cache
  // hit happened in `idempotencyRepo.lookup`; #298 moved the dispatcher onto
  // the atomic `tryReserve` path, so the revalidation now lives there (and
  // in `waitForCompletion` for the loser-of-the-race branch below).
  const payload_hash = computePayloadHash({
    pessoa_id: input.ctx.pessoa.id,
    entity_id,
    tool_name: tool.name,
    operation_type: tool.operation_type,
    payload: args,
    file_sha256,
  });

  // Issue #298: atomic reservation closes the check-then-act race.
  //
  // Pre-fix flow (broken):
  //   lookup → miss → handler() → store
  // Two concurrent workers can both miss `lookup`, both execute `handler()`
  // (DUPLICATE SIDE EFFECTS), then one stores and the other silently
  // `onConflictDoNothing`s. For tools that POST to external systems, send
  // messages, or write to other databases, this violates the exact-once
  // contract the cache is supposed to enforce.
  //
  // Post-fix flow:
  //   tryReserve → was_inserted ? handler+markCompleted : (cached | wait)
  // tryReserve is one INSERT … ON CONFLICT DO NOTHING RETURNING — atomic
  // by Postgres. Exactly one caller wins the reservation; losers wait for
  // the winner's completion and return the same result.
  //
  // TTL semantics: the reservation is bounded by `RESERVATION_TTL_SECONDS`
  // so a crashed worker can't block subsequent callers indefinitely. After
  // expiry, the next tryReserve atomically reclaims the row via UPDATE …
  // WHERE expires_at < now(). The poll budget (`WAIT_TIMEOUT_MS`) is the
  // same value in ms so a non-winning caller waits AT MOST as long as the
  // winner's reservation. Match it to your slowest tool's expected
  // wall-clock — 30s aligns with `DEFAULT_TIMEOUT_MS` in skill-runner.
  const RESERVATION_TTL_SECONDS = 30;
  const WAIT_TIMEOUT_MS = RESERVATION_TTL_SECONDS * 1000;

  const reservation = await idempotencyRepo.tryReserve({
    key: idempotency_key,
    tool_name: tool.name,
    operation_type: tool.operation_type,
    pessoa_id: input.ctx.pessoa.id,
    entity_id,
    // #299: store/compare the REAL payload fingerprint (was incorrectly
    // `idempotency_key` before, which made the collision check a tautology
    // — the key always matches itself). `tryReserve` echoes this hash into
    // the reserved row and revalidates it on a `completed` hit.
    payload_hash,
    file_sha256,
    ttl_seconds: RESERVATION_TTL_SECONDS,
  });

  if (!reservation.was_inserted && reservation.state === 'collision') {
    // #299: an existing `completed` row under this exact (tenant, agent,
    // key) carries a DIFFERENT payload_hash — a key collision. Returning
    // its `resultado` would hand the caller a result computed for a
    // different payload (silent wrong side effect). Fail closed: surface a
    // typed error instead of the stale cache entry. We do NOT re-execute
    // under the colliding key (that would clobber the other payload's
    // cached result); a true collision signals a derivation bug / hash
    // truncation that must be loud, not silently papered over. The
    // collision is logged + metered inside `tryReserve`.
    logger.warn(
      { tool: tool.name, idempotency_key },
      'tool.idempotency_payload_hash_collision',
    );
    return {
      error: 'idempotency_payload_hash_collision',
      details: { tool: tool.name, idempotency_key },
    };
  }

  if (!reservation.was_inserted && reservation.state === 'completed') {
    // Cache hit — another worker already completed this exact call with a
    // MATCHING payload_hash (verified in tryReserve). Skip execution and
    // return the cached output.
    logger.debug({ tool: tool.name, idempotency_key }, 'tool.idempotency_hit');
    return reservation.resultado;
  }

  if (!reservation.was_inserted && reservation.state === 'failed') {
    // Issue #298 B3: a prior attempt for this exact key terminally FAILED.
    // The failed handler may have applied a partial side effect, so we MUST
    // NOT silently re-execute. Surface a typed error; any retry is an
    // explicit, higher-level decision (which would compute the same
    // idempotency_key and re-enter here — still fenced by the 'failed' row
    // until it ages out of the cache).
    logger.warn(
      { tool: tool.name, idempotency_key },
      'tool.idempotency_prior_failed',
    );
    return {
      error: 'idempotency_prior_failed',
      details: { tool: tool.name, idempotency_key },
    };
  }

  if (!reservation.was_inserted && reservation.state === 'in_progress') {
    // Another worker owns the reservation. Wait for them to complete and
    // return their result — preserves the exact-once contract (we do NOT
    // execute the handler again).
    logger.debug(
      { tool: tool.name, idempotency_key },
      'tool.idempotency_wait_start',
    );
    const waited = await idempotencyRepo.waitForCompletion(
      idempotency_key,
      WAIT_TIMEOUT_MS,
      // #299: revalidate the OWNER's stored payload_hash before adopting
      // their result. If the winner reserved a colliding payload (same
      // key, different inputs), the loser must not return that foreign
      // result either — fail closed instead of leaking the wrong side
      // effect across a key collision.
      payload_hash,
    );
    if (waited.status === 'collision') {
      // The settled row carries a different payload_hash than ours.
      // Surface the same typed collision error as the direct-hit path.
      logger.warn(
        { tool: tool.name, idempotency_key },
        'tool.idempotency_payload_hash_collision',
      );
      return {
        error: 'idempotency_payload_hash_collision',
        details: { tool: tool.name, idempotency_key },
      };
    }
    if (waited.status === 'completed') {
      logger.debug(
        { tool: tool.name, idempotency_key },
        'tool.idempotency_wait_hit',
      );
      return waited.resultado;
    }
    if (waited.status === 'failed' || waited.status === 'released') {
      // Owning worker terminally failed. `failed` = the reservation was
      // marked terminal (issue #298 B3); `released` = the row vanished
      // (cleanup reap / down-migration). Either way: tell the caller the
      // operation didn't complete. We MUST NOT re-execute here — a
      // higher-level retry would recompute the same idempotency_key and
      // re-enter this dispatcher, where a 'failed' row keeps the slot
      // fenced until it ages out (no silent partial-side-effect re-run).
      logger.warn(
        { tool: tool.name, idempotency_key, wait_status: waited.status },
        'tool.idempotency_owner_failed',
      );
      return {
        error: 'idempotency_owner_failed',
        details: { tool: tool.name, idempotency_key },
      };
    }
    // status === 'timeout': owner is still working (or hung). Surface a
    // retry-friendly error rather than block the caller indefinitely.
    logger.warn(
      { tool: tool.name, idempotency_key },
      'tool.idempotency_wait_timeout',
    );
    return {
      error: 'idempotency_wait_timeout',
      details: { tool: tool.name, idempotency_key, waited_ms: WAIT_TIMEOUT_MS },
    };
  }

  // was_inserted === true: this caller owns the reservation. Execute the
  // handler and either markCompleted (success) or releaseReservation
  // (failure → mark the slot 'failed' so the same key isn't silently
  // re-executed). All three transitions are fenced by `reservation_token`
  // (issue #298 B2): if this owner's lease expired and was reclaimed by
  // another worker mid-handler, the stale token won't match and the
  // markCompleted/releaseReservation become no-ops — the new owner's
  // reservation is preserved and this owner's side effect doesn't get
  // double-counted as the winning result.
  const reservation_token = reservation.reservation_token;
  let result: unknown;
  try {
    result = await tool.handler(args, {
      pessoa: input.ctx.pessoa,
      scope: input.ctx.scope,
      conversa: input.ctx.conversa,
      mensagem_id: input.ctx.mensagem_id,
      request_id: input.ctx.request_id,
      idempotency_key,
    });
  } catch (err) {
    // Mark the reservation 'failed' (B3) so a higher-level retry doesn't
    // get stuck waiting, and the same key isn't silently re-run while the
    // failed marker stands.
    await idempotencyRepo
      .releaseReservation({ key: idempotency_key, reservation_token })
      .catch((release_err) => {
        logger.error(
          { release_err, tool: tool.name, idempotency_key },
          'tool.reservation_release_failed',
        );
      });
    logger.error({ err, tool: tool.name }, 'tool.execution_failed');
    return { error: 'execution_failed', details: { cause: (err as Error).message } };
  }

  const out = tool.output_schema.safeParse(result);
  if (!out.success) {
    // Output schema violation = handler ran (possibly with side effects)
    // but produced a malformed response. Mark the reservation 'failed':
    // a retry is undesirable (would re-execute the side effect), but
    // locking the slot in 'in_progress' for the full TTL would block all
    // retries from ever surfacing the error — worse for the user. The
    // terminal 'failed' marker fails subsequent same-key dispatches fast
    // (no silent re-run) until it ages out of the cache.
    await idempotencyRepo
      .releaseReservation({ key: idempotency_key, reservation_token })
      .catch((release_err) => {
        logger.error(
          { release_err, tool: tool.name, idempotency_key },
          'tool.reservation_release_failed',
        );
      });
    logger.error({ tool: tool.name, issues: out.error.issues }, 'tool.output_invalid');
    return { error: 'execution_failed', details: { cause: 'output_schema_violation' } };
  }

  // #316: transactional outbox for NON-IDEMPOTENT external effects. A tool
  // with such an effect does NOT fire it inline — its handler PLANS it and
  // exposes it via `extractEffect`. When a plan is present, we complete the
  // reservation AND enqueue the effect in ONE transaction (both fenced by
  // `reservation_token`), so the effect is bound to the WINNING reservation,
  // never to a preempted racer. The relayer
  // (src/workers/idempotency-outbox-relayer.ts) then dispatches it EXACTLY
  // ONCE. Tools without an external effect (or whose result plans none) take
  // the plain markCompleted path unchanged.
  //
  // #299/#298: payload_hash was already written to the reserved row by
  // tryReserve (the REAL fingerprint, not idempotency_key). markCompleted
  // only transitions in_progress→completed and persists the result; it
  // does not re-stamp identity columns. So no payload_hash here.
  const plannedEffect = tool.extractEffect?.(out.data) ?? null;
  const completed = plannedEffect
    ? await idempotencyOutboxRepo.markCompletedWithEffect({
        key: idempotency_key,
        resultado: out.data,
        reservation_token,
        effect: plannedEffect,
      })
    : await idempotencyRepo.markCompleted({
        key: idempotency_key,
        resultado: out.data,
        reservation_token,
      });
  if (!completed) {
    // Fenced out (B2): our lease expired and another worker reclaimed the
    // reservation while our handler was still running. We do NOT cache our
    // result under the new owner's reservation (that would clobber it).
    // #316: for the external-effect path this is STRICTLY safe — the
    // markCompletedWithEffect tx rolled back, so we ALSO did not enqueue an
    // effect under the new owner's reservation (no double-fire). For the plain
    // path, any inline side effect already happened, but the new owner will
    // produce the authoritative cached result; concurrent callers wait on IT.
    // Either way: surface a retry-friendly error rather than returning a result
    // that won't match the cache.
    logger.warn(
      { tool: tool.name, idempotency_key },
      'tool.idempotency_completion_fenced',
    );
    return {
      error: 'idempotency_completion_fenced',
      details: { tool: tool.name, idempotency_key },
    };
  }
  // Issue #366 — money-moving tools that self-audit TRANSACTIONALLY (via
  // `auditTx` inside their own `withTx`) set `audits_in_tx`. Their audit row is
  // already committed atomically with the ledger/balance write, so this
  // post-commit best-effort `audit()` is SKIPPED to avoid a duplicate row.
  if (!tool.audits_in_tx) {
    await audit({
      acao: tool.audit_action,
      pessoa_id: input.ctx.pessoa.id,
      conversa_id: input.ctx.conversa.id,
      mensagem_id: input.ctx.mensagem_id,
      entidade_alvo: entity_id,
      alvo_id: tool.extractAlvoId?.(out.data) ?? null,
      metadata: { tool: tool.name },
    });
  }
  return out.data;
}
