/**
 * P8a — BaseContextBuilder (Camada 1 → BaseContextPacket).
 *
 * Spec §3.1 — produz BaseContextPacket em <100ms a partir do raw input.
 *
 * Dependências externas (tenant/agent resolver, feature flags) são injetadas
 * via construtor para que o builder seja testável sem subir o resto do
 * runtime. Em produção o `react-loop` resolve tenant/agent antes de chamar.
 *
 * NÃO carrega slices pesadas — apenas identifica o turno.
 */

import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { BaseContextPacket } from './types.js';
import { memoryResolver } from '@/user-layer/resolvers/memory-resolver.js';
import { assertNotDefaultLiteral } from '@/db/tenant-context.js';

export interface BaseContextBuilderInput {
  raw_input: Record<string, unknown>;
  channel_id: string;
  received_at: Date;
  // Optional pre-resolved fields — quando o caller já fez identity resolve
  // (caminho real do react-loop), passa direto. Quando ausente, builder
  // usa o resolver injetado.
  tenant_id?: string;
  agent_id?: string;
  session_id?: string;
  conversation_id?: string;
  user_id?: string | null;
  pessoa_id?: string | null;
  actor_role?: string;
  is_authenticated?: boolean;
  channel_kind?: 'whatsapp' | 'web' | 'api' | 'admin';
  is_locked_down?: boolean;
  active_procedure_execution_id?: string | null;
  input_kind?: 'text' | 'audio' | 'image' | 'pdf' | 'tool_result';
}

export interface IdentityResolverPort {
  resolve(channel_id: string): Promise<{ tenant_id: string; agent_id: string }>;
}

export interface FeatureFlagsPort {
  /**
   * Snapshot the flags we want recorded in BaseContextPacket. Tenant-scoped
   * when relevant. Reading happens at entry time so the rest of the turn sees
   * a consistent view.
   */
  snapshot(tenant_id: string): Promise<Record<string, boolean>>;
}

/**
 * Port for counting active sensitive memories in scope.
 * Injected so BaseContextBuilder is testable without a real DB.
 * Agent isolation is mandatory — implementations MUST filter by agent_id.
 */
export interface SensitiveMemoryCounterPort {
  countActiveSensitive(input: {
    tenant_id: string;
    agent_id: string;
    conversation_id?: string;
  }): Promise<number>;
}

export class BaseContextBuilder {
  constructor(
    private readonly resolver: IdentityResolverPort = failLoudResolver,
    private readonly featureFlags: FeatureFlagsPort = defaultFeatureFlags,
    private readonly sensitiveCounter: SensitiveMemoryCounterPort = defaultSensitiveCounter,
  ) {}

  async build(input: BaseContextBuilderInput): Promise<BaseContextPacket> {
    const enteredAtMs = performance.now();

    // Resolve tenant + agent. Caller may supply pre-resolved values.
    let tenant_id = input.tenant_id;
    let agent_id = input.agent_id;
    if (!tenant_id || !agent_id) {
      const resolved = await this.resolver.resolve(input.channel_id);
      tenant_id = tenant_id ?? resolved.tenant_id;
      agent_id = agent_id ?? resolved.agent_id;
    }
    if (!tenant_id || !agent_id) {
      throw new Error(
        `BaseContextBuilder: failed to resolve tenant/agent from channel ${input.channel_id}`,
      );
    }

    // Literal 'default' rejection (issue #315). Falsy checks above only catch
    // empty/undefined; the legacy `{tenant_id:'default', agent_id:'default'}`
    // sentinel slipped through and produced a synthetic cross-tenant scope,
    // violating the inviolable isolation invariant. We reuse the SAME helper
    // as the ALS read-time guard (`getCurrentTenant`/`getCurrentAgent`) so the
    // two layers share one flag + counter + error type and cannot diverge:
    //  - always meters `maia_tenant_id_default_literal_total` for observability;
    //  - throws `DefaultLiteralRejectedError` only when
    //    `MAIA_REJECT_DEFAULT_LITERAL=true` (opt-in until every legacy worker
    //    /single-tenant path is migrated off the sentinel — see issue #315).
    assertNotDefaultLiteral(tenant_id, 'tenant_id');
    assertNotDefaultLiteral(agent_id, 'agent_id');

    // Tenant-scoped HMAC of raw input (16 chars). Deterministic for cache
    // dedup / idempotency keys when same body shows up twice.
    const contentStr = JSON.stringify(input.raw_input);
    const contentHmac = crypto
      .createHmac('sha256', tenant_id)
      .update(contentStr)
      .digest('hex')
      .substring(0, 16);

    // Snapshot feature flags. FEATURE_CONTEXT_PACKET_V1 is the marquee one
    // for P8a, but the snapshot is open-ended — the FeatureFlagsPort decides
    // which flags to expose.
    const featureFlagsSnapshot = await this.featureFlags.snapshot(tenant_id);

    const conversationId =
      input.conversation_id ?? `conv_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;

    // Count active sensitive memories in scope (tenant + agent + conversation).
    // Fail-open: 0 if the counter throws (conservative — no false floor).
    const activeSensitiveMemoryCount = await this.sensitiveCounter
      .countActiveSensitive({
        tenant_id,
        agent_id,
        conversation_id: conversationId,
      })
      .catch(() => 0);

    return {
      trace_id: randomUUID(),
      tenant_id,
      agent_id,
      session_id: input.session_id ?? input.channel_id,
      conversation_id: conversationId,
      channel: {
        id: input.channel_id,
        kind: input.channel_kind ?? 'api',
        is_locked_down: input.is_locked_down ?? false,
      },
      actor: {
        user_id: input.user_id ?? null,
        pessoa_id: input.pessoa_id ?? null,
        role: input.actor_role ?? 'system',
        is_authenticated: input.is_authenticated ?? false,
      },
      input: {
        kind: input.input_kind ?? 'text',
        content_ref: `input:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`,
        content_hmac: contentHmac,
        received_at: input.received_at.toISOString(),
      },
      active_procedure_execution_id: input.active_procedure_execution_id ?? null,
      feature_flags_snapshot: featureFlagsSnapshot,
      entered_at_ms: enteredAtMs,
      active_sensitive_memory_count: activeSensitiveMemoryCount,
    };
  }
}

// ============================================================================
// Default ports — fail-loud for production, explicit fixture for tests
// ============================================================================

/**
 * Fail-loud default resolver: if production ever reaches this code path it
 * means DI is mis-wired. Returning `{tenant_id:'default', agent_id:'default'}`
 * (the previous behaviour) would silently create a synthetic context that
 * violates the inviolable multi-tenant isolation invariant:
 * "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 * herdam aprendizado. Sem exceção." (project memory).
 *
 * Issue #282: removed the silent default. Tests that need a stand-in must
 * either inject a real-shaped resolver or import `__testOnlyPassthroughResolver`
 * from `./test-fixtures.js` (test-only path; production code MUST NOT import
 * it). Production code that legitimately runs without a resolver (e.g. when
 * `tenant_id`/`agent_id` are pre-resolved by the react-loop) never reaches
 * the resolver — `build()` short-circuits when the caller supplies both.
 */
const failLoudResolver: IdentityResolverPort = {
  async resolve(channel_id: string): Promise<never> {
    throw new Error(
      `BaseContextBuilder: no IdentityResolverPort injected and no pre-resolved tenant/agent for channel ${channel_id}. ` +
        `Production code must inject a resolver via DI; tests must inject __testOnlyPassthroughResolver from test-fixtures. ` +
        `Silent default fallback was removed by issue #282 to preserve tenant-isolation invariant.`,
    );
  },
};

/**
 * Default feature flags snapshot: exposes FEATURE_CONTEXT_PACKET_V1 from env
 * for P8a. Tests can inject a mock with different shape.
 */
const defaultFeatureFlags: FeatureFlagsPort = {
  async snapshot(_tenant_id: string) {
    const killSwitch = process.env.FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH === 'true';
    const enabled = !killSwitch && process.env.FEATURE_CONTEXT_PACKET_V1 === 'true';
    return {
      FEATURE_CONTEXT_PACKET_V1: enabled,
    };
  },
};

/**
 * Default sensitive-memory counter: delegates to the production memoryResolver.
 * Tests inject a mock counter via the constructor to avoid DB access.
 */
const defaultSensitiveCounter: SensitiveMemoryCounterPort = {
  countActiveSensitive: (input) => memoryResolver.countActiveSensitive(input),
};
