import type { Pessoa, Conversa, ApprovalRequest } from '@/db/schema.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import { canAct } from '@/governance/permissions.js';
import { constitutionalCheck } from '@/governance/rules.js';
import { evaluateFinancialAuthorization } from '@/governance/financial-authorization.js';
import { requiresDualApproval } from '@/governance/dual-approval.js';
import {
  computeIntentHash,
  claimExecutableApproval,
  ensureApprovalRequest,
  consumeApproval,
  failClaimedApproval,
  releaseClaimedApproval,
  dualClassFor,
} from '@/governance/approval-requests.js';
import type { ApprovalClass } from '@/db/repositories.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { REGISTRY, isToolEnabled, type AnyTool } from './_registry.js';
import { isMcpToolName, dispatchMcpTool } from './mcp-bridge.js';
import { resolveGrantedToolNames, type AgentToolGrant } from './grant-math.js';
import { BASE_AGENT_PACKS } from './base-agent-packs.js';
import { computeIdempotencyKey, computePayloadHash } from '@/governance/idempotency.js';
import { idempotencyRepo, idempotencyOutboxRepo, agentToolGrantsRepo } from '@/db/repositories.js';
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
 * natureza, categoria_id, file_sha256).
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
  // Issue #478 — tools MCP (`mcp:<server>:<tool>`) são dinâmicas (DB), não
  // vivem no REGISTRY. O bridge revalida TODAS as guardas server-side (flag,
  // pack no grant, tool aprovada+read-only, server ativo) e audita cada
  // chamada — mesmo desenho fail-closed do guard `tool_not_granted` abaixo.
  if (isMcpToolName(input.tool)) {
    // Fase 0 cap. 5 — o bridge recebe o ToolContext completo: audits com
    // pessoa/conversa/mensagem + regras constitucionais aplicadas lá dentro.
    return dispatchMcpTool({
      tool: input.tool,
      args: input.args,
      request_id: input.ctx.request_id,
      ctx: input.ctx,
    });
  }

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

  // Issue #408 — `tool_not_granted` guard. The AGENT-grant filter, revalidated
  // SERVER-SIDE before the permission/`canAct` guard. The Runtime Tool Filter
  // already hides un-granted tools from the LLM (`getAgentToolSchemas`), but
  // this is the fail-closed defense (invariant #5): even if the LLM tries a
  // tool it should never have seen — a hallucinated name, a denied tool, or a
  // tool granted to a DIFFERENT agent — the dispatcher refuses it here.
  //
  // The effective grant is the AGENT axis (`baseline.core ∪ packs ∪ tools −
  // denied`), resolved ALS-scoped from `agent_tool_grants`. We do NOT apply the
  // per-turn SKILL scope here: the skill narrows VISIBILITY, but a tool the
  // agent genuinely has installed and the person is authorised for must still
  // be dispatchable (e.g. a follow-up turn without that skill selected). The
  // skill scope is enforced at visibility time; the agent grant + `denied_tools`
  // is the hard server-side floor. `denied_tools` is HARD — a denied tool is
  // refused here even though it might be in a granted pack.
  //
  // Fail-closed sourcing: `findForCurrentAgent` returns null for an agent with
  // no grant row (un-backfilled / brand-new). The fallback degrades to
  // `BASE_AGENT_PACKS` (baseline.core + domain.calendar), and
  // `resolveGrantedToolNames` always unions in `baseline.core` — never "all
  // tools" and never a thrown error in the hot path. Baseline orchestration
  // tools (read_turn_context, audit_decision, …) are therefore always dispatchable.
  // try/catch (not just `.catch`) so a SYNCHRONOUS throw (missing ALS context,
  // mis-wired repo) degrades to the baseline floor rather than crashing the
  // dispatch — fail-closed in the SAFE direction (a non-baseline tool is then
  // refused, never silently allowed).
  let grantRow: {
    granted_packs: string[];
    granted_tools: string[];
    denied_tools: string[];
  } | null = null;
  try {
    grantRow = await agentToolGrantsRepo.findForCurrentAgent();
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tool: tool.name },
      'tool.grant_lookup_failed_fallback_baseline',
    );
  }
  const effectiveGrant: AgentToolGrant = {
    granted_packs: grantRow?.granted_packs ?? [...BASE_AGENT_PACKS],
    granted_tools: grantRow?.granted_tools ?? [],
    denied_tools: grantRow?.denied_tools ?? [],
  };
  const grantedNames = resolveGrantedToolNames(effectiveGrant);
  if (!grantedNames.has(tool.name)) {
    await audit({
      acao: 'tool_not_granted',
      pessoa_id: input.ctx.pessoa.id,
      conversa_id: input.ctx.conversa.id,
      mensagem_id: input.ctx.mensagem_id,
      metadata: {
        tool: tool.name,
        granted_packs: effectiveGrant.granted_packs,
        denied_tools: effectiveGrant.denied_tools,
      },
    });
    return { error: 'tool_not_granted', details: { tool: tool.name } };
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
  const valor = pickToolField<'number'>(args, 'valor', 'number');
  const natureza = pickToolField<'string'>(args, 'natureza', 'string');
  const categoria_id = pickToolField<'string'>(args, 'categoria_id', 'string');

  // Constitutional rules apply BEFORE per-action permission checks: hard
  // limits, dual-approval gates and cross-entity guards must short-circuit
  // even if the profile would otherwise authorize the action.
  //
  // Fase 0 cap. 3: `dual_approval_granted` (um boolean vindo dos args do LLM)
  // foi removido. Uma violação `limit_exceeded` agora vira uma EXIGÊNCIA de
  // aprovação resolvida adiante contra o store backend (approval_requests) —
  // o modelo nunca atesta a própria aprovação.
  const violation = constitutionalCheck({
    intent: { tool: tool.name, args },
    pessoa: input.ctx.pessoa,
    resolved: resolved ?? null,
    scope: { entidades: input.ctx.scope.entidades },
  });
  if (violation && violation.kind === 'forbidden') {
    await audit({
      acao: 'unauthorized_access_attempt',
      pessoa_id: input.ctx.pessoa.id,
      conversa_id: input.ctx.conversa.id,
      mensagem_id: input.ctx.mensagem_id,
      metadata: { tool: tool.name, violation },
    });
    return { error: 'forbidden', details: { rule_id: violation.rule_id, reason: violation.reason } };
  }

  for (const action of tool.required_actions as ActionKey[]) {
    const allow = canAct({
      pessoa: input.ctx.pessoa,
      resolved: resolved ?? null,
      action,
      valor,
      natureza,
      categoria_id,
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

  // Redis check ANTES do claim de aprovação: um claim seguido de bloqueio de
  // infra deixaria a evidência presa em 'claimed' sem execução.
  if (tool.redis_required && !isRedisConnected()) {
    return { error: 'redis_unavailable_blocked' };
  }

  const file_sha256 = pickToolField<'string'>(args, 'file_sha256', 'string') ?? pickToolField<'string'>(args, 'attachment_id', 'string');
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

  // Fase 0 cap. 3 — pré-check READ-ONLY do cache de idempotência ANTES da
  // exigência de aprovação: um intent idêntico JÁ EXECUTADO dentro da janela
  // retorna o resultado cacheado sem novo side effect — não faz sentido (nem
  // é seguro) exigir/consumir nova aprovação para devolver cache. `lookup`
  // revalida payload_hash, então não devolve resultado de payload colidente.
  const cachedResult = await idempotencyRepo
    .lookup({ key: idempotency_key, payload_hash })
    .catch(() => null);
  if (cachedResult !== null) {
    logger.debug({ tool: tool.name, idempotency_key }, 'tool.idempotency_precheck_hit');
    return cachedResult;
  }

  // Fase 0 cap. 1+3 — classificação de confirmação calculada pelo BACKEND:
  // regra constitucional (dual), catálogo de operações críticas (dual) e
  // thresholds financeiros (allow / single / dual). A exigência mais alta
  // vence; `deny` já foi tratado pelo canAct acima.
  let approvalRequirement: 'none' | 'single' | 'dual' = 'none';
  let approvalReason = '';
  if (violation) {
    approvalRequirement = 'dual';
    approvalReason = violation.reason;
  }
  const critical = requiresDualApproval({ tool: tool.name, args });
  if (critical.required && approvalRequirement !== 'dual') {
    approvalRequirement = 'dual';
    approvalReason = critical.reason ?? 'operação crítica';
  }
  if (valor !== undefined && approvalRequirement !== 'dual') {
    const fin = evaluateFinancialAuthorization({
      pessoa: input.ctx.pessoa,
      resolved: resolved ?? null,
      action: (tool.required_actions[0] ?? 'create_transaction') as ActionKey,
      valor,
      natureza,
      categoria_id,
    });
    // Fail-closed (revisão adversarial): NORMALMENTE o `deny` já foi barrado
    // pelo loop de `canAct` acima (mesmo avaliador). MAS o loop roda por
    // `required_actions` — uma tool com `required_actions: []` (hoje só as de
    // leitura, mas nada impede uma futura tool mutável com `valor`) o pularia,
    // e este bloco classificaria a confirmação deixando um `deny` escapar.
    // Aqui o `deny` vira `forbidden` explícito — nunca executa.
    if (fin.decision === 'deny') {
      await audit({
        acao: 'unauthorized_access_attempt',
        pessoa_id: input.ctx.pessoa.id,
        conversa_id: input.ctx.conversa.id,
        mensagem_id: input.ctx.mensagem_id,
        metadata: { tool: tool.name, reason: fin.reason_code, policy_version: fin.policy_version },
      });
      return { error: 'forbidden', details: { reason: fin.reason_code } };
    }
    if (fin.decision === 'require_dual_approval') {
      approvalRequirement = 'dual';
      approvalReason = `valor acima do threshold de aprovação dupla`;
    } else if (fin.decision === 'require_single_confirmation') {
      approvalRequirement = 'single';
      approvalReason = `valor acima do threshold de confirmação`;
    }
  }

  // Resolve a exigência contra a EVIDÊNCIA BACKEND (migration 095). Fluxo:
  //   1ª chamada → cria request persistido + notifica humanos → NÃO executa;
  //   humanos decidem fora do chat do LLM ("aprova AP-xxxxxxxx");
  //   chamada repetida com o MESMO intent → claim atômico da evidência
  //   aprovada (hash idêntico, não expirada, um vencedor) → executa UMA vez
  //   → consume. Payload alterado muda o hash ⇒ nova aprovação.
  let claimedApproval: { request: ApprovalRequest; claim_token: string } | null = null;
  if (approvalRequirement !== 'none') {
    const approval_class: ApprovalClass =
      approvalRequirement === 'single'
        ? 'single_confirmation'
        : dualClassFor(input.ctx.pessoa);
    const intent_hash = computeIntentHash({
      tenant_id: getCurrentTenant(),
      agent_id: getCurrentAgent(),
      requester_pessoa_id: input.ctx.pessoa.id,
      entidade_id: entity_id,
      tool: tool.name,
      operation_type: tool.operation_type,
      args,
      approval_class,
    });
    const claim = await claimExecutableApproval({
      intent_hash,
      requester: input.ctx.pessoa,
    });
    if (claim.outcome === 'claimed') {
      claimedApproval = { request: claim.request, claim_token: claim.claim_token };
    } else if (claim.outcome === 'pending') {
      return {
        error: 'approval_pending',
        details: {
          ref: `AP-${claim.request.id.slice(0, 8)}`,
          approval_class,
          reason: approvalReason,
        },
      };
    } else {
      // Import dinâmico: mantém o grafo de módulos do dispatcher leve (o
      // gateway puxa Baileys) e só resolve a fronteira de saída quando um
      // request precisa de fato notificar humanos.
      const notify = async (jid: string, text: string): Promise<unknown> => {
        const { forCurrentAgentChannel } = await import('@/gateway/line-output.js');
        const line = await forCurrentAgentChannel(null);
        return line.sendText(jid, text);
      };
      const ensured = await ensureApprovalRequest({
        tenant_id: getCurrentTenant(),
        agent_id: getCurrentAgent(),
        requester: input.ctx.pessoa,
        entidade_id: entity_id,
        conversa_id: input.ctx.conversa.id,
        mensagem_id: input.ctx.mensagem_id,
        request_id: input.ctx.request_id,
        tool: tool.name,
        operation_type: tool.operation_type,
        args,
        approval_class,
        reason: `${tool.name}: ${approvalReason}`,
        notify,
      });
      return {
        error: approvalRequirement === 'single' ? 'requires_confirmation' : 'requires_dual_approval',
        details: {
          ref: ensured.ref,
          approval_class,
          created: ensured.created,
          reason: approvalReason,
        },
      };
    }
  }

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

  // Fase 0 cap. 3 — caminhos em que o handler NÃO roda neste caller devolvem
  // a evidência (claimed → approved) em vez de deixá-la presa em 'claimed'.
  const releaseClaimIfHeld = async (): Promise<void> => {
    if (claimedApproval) {
      await releaseClaimedApproval({
        request: claimedApproval.request,
        claim_token: claimedApproval.claim_token,
      }).catch((err) =>
        logger.warn(
          { err: (err as Error).message, request_id: claimedApproval?.request.id },
          'tool.approval_claim_release_failed',
        ),
      );
    }
  };

  if (!reservation.was_inserted && reservation.state === 'collision') {
    await releaseClaimIfHeld();
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
    await releaseClaimIfHeld();
    logger.debug({ tool: tool.name, idempotency_key }, 'tool.idempotency_hit');
    return reservation.resultado;
  }

  if (!reservation.was_inserted && reservation.state === 'failed') {
    await releaseClaimIfHeld();
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
    await releaseClaimIfHeld();
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
    // Fase 0 cap. 3 — handler rodou e falhou com side effect DESCONHECIDO:
    // a evidência vira terminal (execution_failed, fail-closed). Retry exige
    // NOVA aprovação humana; nunca reexecuta sozinho sobre a mesma evidência.
    if (claimedApproval) {
      await failClaimedApproval({
        request: claimedApproval.request,
        claim_token: claimedApproval.claim_token,
        cause: (err as Error).message,
      }).catch((fail_err) =>
        logger.error(
          { fail_err, request_id: claimedApproval?.request.id },
          'tool.approval_fail_mark_failed',
        ),
      );
    }
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
    // Fase 0 cap. 3 — output inválido = estado do side effect desconhecido.
    // Mesma política fail-closed do catch acima: evidência terminal.
    if (claimedApproval) {
      await failClaimedApproval({
        request: claimedApproval.request,
        claim_token: claimedApproval.claim_token,
        cause: 'output_schema_violation',
      }).catch((fail_err) =>
        logger.error(
          { fail_err, request_id: claimedApproval?.request.id },
          'tool.approval_fail_mark_failed',
        ),
      );
    }
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
    // Fase 0 cap. 3 — o handler DESTE caller executou (side effect real),
    // mesmo que o resultado não tenha virado o cache autoritativo. A
    // evidência é consumida: uma execução aconteceu sob esta aprovação.
    if (claimedApproval) {
      await consumeApproval({
        request: claimedApproval.request,
        claim_token: claimedApproval.claim_token,
        result_ref: null,
      }).catch((err) =>
        logger.error(
          { err: (err as Error).message, request_id: claimedApproval?.request.id },
          'tool.approval_consume_failed',
        ),
      );
    }
    return {
      error: 'idempotency_completion_fenced',
      details: { tool: tool.name, idempotency_key },
    };
  }
  // Issue #366 — money-moving tools that self-audit TRANSACTIONALLY (via
  // `auditTx` inside their own `withTx`) set `audits_in_tx`. Their audit row is
  // already committed atomically with the ledger/balance write, so this
  // post-commit best-effort `audit()` is SKIPPED to avoid a duplicate row.
  //
  // Review #374 (medium): `audits_in_tx` is tool-WIDE, but these tools have
  // schema-valid EARLY-RETURN paths (register_transaction duplicate-suspected;
  // cancel_transaction already-`cancelada`/not-found) that exit BEFORE any
  // `auditTx` runs. A static per-tool skip would drop the audit row entirely
  // for those invocations — a regression vs the prior unconditional post-commit
  // audit(). So the skip is CONDITIONAL on the PER-INVOCATION `auditedInTx`
  // predicate: skip the fallback only when the tool actually self-audited in-tx
  // on THIS result; otherwise run the normal best-effort audit() so every
  // invocation still appends to the mutation trail.
  const selfAuditedInTx = tool.audits_in_tx === true && tool.auditedInTx?.(out.data) === true;
  if (!selfAuditedInTx) {
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
  // Fase 0 cap. 3 — execução REAL aconteceu: consome a evidência (one-time).
  // Vale também para o caminho 'fenced' acima? Não — aquele retorna antes.
  // Aqui `completed` é true e o handler rodou com sucesso, então o consume
  // reflete a verdade operacional (audit `approval_consumed` no serviço).
  if (claimedApproval) {
    const consumed = await consumeApproval({
      request: claimedApproval.request,
      claim_token: claimedApproval.claim_token,
      result_ref: tool.extractAlvoId?.(out.data) ?? idempotency_key,
    }).catch((err) => {
      logger.error(
        { err: (err as Error).message, request_id: claimedApproval?.request.id },
        'tool.approval_consume_failed',
      );
      return false;
    });
    if (!consumed) {
      logger.error(
        { request_id: claimedApproval.request.id, tool: tool.name },
        'tool.approval_consume_lost_race',
      );
    }
  }
  return out.data;
}
