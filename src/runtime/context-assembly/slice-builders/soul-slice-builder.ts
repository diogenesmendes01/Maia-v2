/**
 * P8b — buildSoulSlice (slice builder do Context Packet) + P8a SliceBuilder
 * framework integration.
 *
 * Recebe contexto do turno; consulta soulBiasesRepo.findActiveForScope (já
 * filtrado por tenant+agent); filtra in-memory por `activation_context`;
 * ranqueia por (strength DESC, scope_specificity DESC); trunca a `max_biases`;
 * renderiza markdown "Orientação persistente" pra entrar no prompt.
 *
 * Disclaimer no fim do bloco: "inclinam, não bloqueiam" — operacionaliza
 * Princípio §0.4 do master ("Soul inclina, não força").
 *
 * Quando depth='none' devolve emptySlice — útil em testes ou modo "sem soul"
 * (ex.: debug ou rollback temporário sem alterar DB).
 *
 * Esta versão fundiu o stub do P8a (`SoulSliceBuilder` classe / `SoulPort`
 * abstração / `stubSoulPort`) com a implementação real do P8b. O P8a
 * orquestrador (`buildContextPacket`) continua usando a classe via
 * `production-builder-set.ts`; testes legados do P8b chamam `buildSoulSlice`
 * direto.
 */
import { soulBiasesRepo } from '@/control-plane/soul/soul-biases-repo.js';
import type { SoulBias, ActivationContext } from '@/db/schema.js';
import type { SoulScope } from '@/types/enums.js';
import type { SoulSlice, SoulSliceBias } from '../types/soul-slice.js';
import type { BaseContextPacket } from '../../context-packet/types.js';
import { sliceCacheKey, type SliceCache } from '../../context-packet/cache/slice-cache.js';
import { getTTLForSlice } from '../../context-packet/cache/ttl-policy.js';
import type {
  SliceBuilder,
  SliceBuilderInput,
  SliceBuilderResult,
} from './_types.js';

const RISK_ORDER: Record<'low' | 'medium' | 'high', number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export type BuildSoulSliceArgs = {
  tenant_id: string;
  agent_id: string;
  depth: 'none' | 'relevant';
  max_biases: number;
  current_role?: string;
  current_intent?: string;
  current_domain?: string;
  current_risk_level?: 'low' | 'medium' | 'high';
  current_channel?: string;
  /**
   * Optional AbortSignal honored at function entry and after the I/O step.
   * P8a orchestrator passes its budget signal through `SoulSliceBuilder`.
   */
  signal?: AbortSignal;
};

/**
 * Standalone function-based API consumed by tests and the integration suite.
 * The `SoulSliceBuilder` class below wraps it for the P8a orchestrator.
 */
export async function buildSoulSlice(args: BuildSoulSliceArgs): Promise<SoulSlice> {
  throwIfAborted(args.signal);

  if (args.depth === 'none' || args.max_biases <= 0) {
    return emptySlice(args);
  }

  // Overbook 3x para dar espaço de filtragem + ranqueamento.
  const fetchLimit = Math.max(args.max_biases * 3, 20);
  const allActive = await soulBiasesRepo.findActiveForScope({ limit: fetchLimit });
  throwIfAborted(args.signal);

  const matched = allActive.filter((b) => matchesActivationContext(b, args));

  // Ranqueamento: strength DESC, scope_specificity DESC como tiebreak.
  const sorted = matched.slice().sort((a, b) => {
    const aStrength = parseFloat(String(a.strength));
    const bStrength = parseFloat(String(b.strength));
    if (bStrength !== aStrength) return bStrength - aStrength;
    return scopeSpecificity(b.scope) - scopeSpecificity(a.scope);
  });

  const truncated = sorted.slice(0, args.max_biases);
  const rendered_block = renderSoulBlock(truncated);

  return {
    active_biases: truncated.map(toSliceBias),
    rendered_block,
    total_active: matched.length,
    truncated_to: truncated.length,
    cache_key: makeCacheKey(args),
    resolved_at: new Date(),
  };
}

function emptySlice(args: BuildSoulSliceArgs): SoulSlice {
  return {
    active_biases: [],
    rendered_block: null,
    total_active: 0,
    truncated_to: 0,
    cache_key: makeCacheKey(args),
    resolved_at: new Date(),
  };
}

/**
 * Avalia se a bias deve ativar dado o contexto do turno.
 *
 * STEP 1 — Scope check (aplicado ANTES de activation_context):
 *  - 'tenant'  → sempre passa (filtro só por tenant_id, já feito no repo)
 *  - 'agent'   → args.agent_id deve estar presente (repo já filtrou por agent_id)
 *  - 'role'    → args.current_role deve existir e bater com bias.scope_value
 *  - 'domain'  → args.current_domain deve existir e bater com bias.scope_value
 *
 * Se o contexto necessário para o scope estiver ausente → bias NÃO ativa.
 *
 * STEP 2 — Activation context rules (quando escopo passa):
 *  - intent_in    : current_intent ∈ intent_in
 *  - role_in      : current_role ∈ role_in
 *  - domain_in    : current_domain ∈ domain_in
 *  - channel_in   : current_channel ∈ channel_in
 *  - risk_level_min : current_risk_level >= risk_level_min (low<medium<high)
 *
 * Quando o filtro está presente mas o contexto correspondente NÃO foi
 * informado, a bias NÃO ativa (conservador: bias com filtro requer contexto).
 * Quando o filtro está ausente, qualquer contexto passa.
 */
function matchesActivationContext(bias: SoulBias, args: BuildSoulSliceArgs): boolean {
  // STEP 1 — Scope enforcement (before activation_context)
  const scope = bias.scope as SoulScope;
  if (scope === 'role') {
    // role-scoped bias: current_role must match scope_value exactly
    if (!args.current_role || args.current_role !== bias.scope_value) {
      return false;
    }
  } else if (scope === 'domain') {
    // domain-scoped bias: current_domain must match scope_value exactly
    if (!args.current_domain || args.current_domain !== bias.scope_value) {
      return false;
    }
  } else if (scope === 'agent') {
    // agent-scoped bias: agent_id must be present (already filtered by repo,
    // but guard against missing context)
    if (!args.agent_id) {
      return false;
    }
  }
  // 'tenant' scope: no additional context requirement — passes scope check

  // STEP 2 — Activation context checks
  const ctx = (bias.activation_context ?? {}) as ActivationContext;

  if (ctx.intent_in && ctx.intent_in.length > 0) {
    if (!args.current_intent || !ctx.intent_in.includes(args.current_intent)) {
      return false;
    }
  }
  if (ctx.role_in && ctx.role_in.length > 0) {
    if (!args.current_role || !ctx.role_in.includes(args.current_role)) {
      return false;
    }
  }
  if (ctx.domain_in && ctx.domain_in.length > 0) {
    if (!args.current_domain || !ctx.domain_in.includes(args.current_domain)) {
      return false;
    }
  }
  if (ctx.channel_in && ctx.channel_in.length > 0) {
    if (!args.current_channel || !ctx.channel_in.includes(args.current_channel)) {
      return false;
    }
  }
  if (ctx.risk_level_min) {
    if (!args.current_risk_level) return false;
    if (RISK_ORDER[args.current_risk_level] < RISK_ORDER[ctx.risk_level_min]) {
      return false;
    }
  }

  return true;
}

/**
 * Specificity: domain > role > agent > tenant.
 * Usado como tiebreak quando strength empata — bias mais específico vence.
 */
function scopeSpecificity(scope: SoulBias['scope']): number {
  const s = scope as SoulScope;
  switch (s) {
    case 'domain':
      return 4;
    case 'role':
      return 3;
    case 'agent':
      return 2;
    case 'tenant':
      return 1;
    default:
      return 0;
  }
}

function renderSoulBlock(biases: SoulBias[]): string | null {
  if (biases.length === 0) return null;

  const lines: string[] = ['## Orientação persistente', ''];
  for (const b of biases) {
    lines.push(`- (${b.principle}) ${b.guidance}`);
  }
  lines.push('');
  lines.push('Estas orientações modulam o seu comportamento — elas inclinam, não bloqueiam.');
  lines.push(
    'Quando uma orientação parece conflitar com a identidade ou uma policy, a identidade/policy prevalece.',
  );
  return lines.join('\n');
}

function toSliceBias(b: SoulBias): SoulSliceBias {
  return {
    id: b.id,
    scope: b.scope as SoulScope,
    scope_value: b.scope_value,
    principle: b.principle,
    guidance: b.guidance,
    strength: parseFloat(String(b.strength)),
    origin: b.origin as SoulSliceBias['origin'],
  };
}

function makeCacheKey(args: BuildSoulSliceArgs): string {
  return [
    'soul',
    args.tenant_id,
    args.agent_id,
    args.depth,
    String(args.max_biases),
    args.current_role ?? '-',
    args.current_intent ?? '-',
    args.current_domain ?? '-',
    args.current_risk_level ?? '-',
    args.current_channel ?? '-',
  ].join(':');
}

// ============================================================================
// P8a SliceBuilder framework integration
// ============================================================================

/**
 * Requirements consumed by the orchestrator. P8a's `DecisionPacket.context_requirements.soul`
 * matches this shape.
 */
export interface SoulRequirements {
  depth: 'none' | 'relevant';
  max_biases?: number;
}

/**
 * P8a port abstraction. P8b exposes a concrete adapter (`soulBiasesRepoPort`)
 * backed by `soulBiasesRepo.findActiveForScope`. Tests may inject a stub.
 */
export interface SoulPort {
  listActiveBiases(
    tenant_id: string,
    agent_id: string,
    opts: { limit: number },
  ): Promise<SoulBias[]>;
}

/**
 * Stub Soul port returning no biases. Used in tests and as a fallback when the
 * real repo is intentionally disabled (kill switch).
 */
export const stubSoulPort: SoulPort = {
  async listActiveBiases() {
    return [];
  },
};

/**
 * Real port — wraps `soulBiasesRepo.findActiveForScope`. The repo reads
 * tenant/agent from the current `tenant-context`, so the orchestrator must
 * call into this port from within `runWithTenantContext({ tenant_id, agent_id })`.
 */
export const soulBiasesRepoPort: SoulPort = {
  async listActiveBiases(_tenant_id, _agent_id, opts) {
    return soulBiasesRepo.findActiveForScope({ limit: opts.limit });
  },
};

/**
 * Re-exported for tests that need a minimal shape. The function-based path
 * uses the full `SoulBias` row; tests that exercise the SliceBuilder layer
 * may use this trimmed projection.
 */
export interface SoulBiasRecord {
  id: string;
  principle: string;
  strength: number;
  origin: string;
  scope: string;
  scope_value: string | null;
  version_id: string;
}

/**
 * P8a SliceBuilder wrapper. Delegates to `buildSoulSlice()` for the real
 * filtering/rendering work; satisfies the `SliceBuilder<SoulRequirements,
 * SoulSlice>` contract so the orchestrator can wire it into the parallel
 * assembly pipeline.
 */
export class SoulSliceBuilder
  implements SliceBuilder<SoulRequirements, SoulSlice>
{
  readonly name = 'soul' as const;

  constructor(
    private readonly port: SoulPort,
    private readonly cache: SliceCache,
  ) {}

  cacheKey(base: BaseContextPacket, req: SoulRequirements): string {
    // Builders share the InMemorySliceCache; keep keys in
    // `maia:context:v2:{tenant}:{agent}:soul:{scope_hash}` namespace.
    const scope = [
      base.agent_id,
      req.depth,
      String(req.max_biases ?? 5),
    ].join(':');
    // Issue #235: pass agent_id into sliceCacheKey's prefix. agent_id remains
    // in the scope hash too (redundant but harmless) since soul biases were
    // already agent-scoped here.
    return sliceCacheKey(base.tenant_id, base.agent_id, 'soul', scope);
  }

  async build(
    input: SliceBuilderInput<SoulRequirements>,
  ): Promise<SliceBuilderResult<SoulSlice>> {
    const start = performance.now();
    throwIfAborted(input.signal);

    const depth = input.requirements.depth;
    const max_biases = input.requirements.max_biases ?? 5;

    if (depth === 'none' || max_biases <= 0) {
      const slice = await buildSoulSlice({
        tenant_id: input.base.tenant_id,
        agent_id: input.base.agent_id,
        depth: 'none',
        max_biases,
        signal: input.signal,
      });
      return {
        slice,
        cache_hit: false,
        duration_ms: performance.now() - start,
      };
    }

    const key = this.cacheKey(input.base, input.requirements);
    const cached = await this.cache.get<SoulSlice>(key);
    throwIfAborted(input.signal);
    if (cached) {
      return {
        slice: cached,
        cache_hit: true,
        duration_ms: performance.now() - start,
      };
    }

    // Delegate to the port. The default `soulBiasesRepoPort` reuses
    // `buildSoulSlice` internally for full filtering + rendering; stub
    // ports (tests) short-circuit to empty.
    const biases = await this.port.listActiveBiases(
      input.base.tenant_id,
      input.base.agent_id,
      { limit: max_biases * 3 + 1 },
    );
    throwIfAborted(input.signal);

    const slice = assembleFromBiases(biases, input.base, input.requirements);

    await this.cache.set(key, slice, getTTLForSlice('soul'));
    return {
      slice,
      cache_hit: false,
      duration_ms: performance.now() - start,
    };
  }
}

/**
 * Pure builder: takes already-fetched biases and produces the SoulSlice using
 * the same ranking/rendering logic as `buildSoulSlice`. Kept as a helper so
 * the SoulSliceBuilder class can leverage injected ports (stubs in tests)
 * without re-querying the repo.
 */
function assembleFromBiases(
  biases: SoulBias[],
  base: BaseContextPacket,
  req: SoulRequirements,
): SoulSlice {
  const max_biases = req.max_biases ?? 5;
  const cacheArgs: BuildSoulSliceArgs = {
    tenant_id: base.tenant_id,
    agent_id: base.agent_id,
    depth: req.depth,
    max_biases,
  };

  const sorted = biases.slice().sort((a, b) => {
    const aStrength = parseFloat(String(a.strength));
    const bStrength = parseFloat(String(b.strength));
    if (bStrength !== aStrength) return bStrength - aStrength;
    return scopeSpecificity(b.scope) - scopeSpecificity(a.scope);
  });
  const truncated = sorted.slice(0, max_biases);
  const rendered_block = renderSoulBlock(truncated);

  return {
    active_biases: truncated.map(toSliceBias),
    rendered_block,
    total_active: biases.length,
    truncated_to: truncated.length,
    cache_key: makeCacheKey(cacheArgs),
    resolved_at: new Date(),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}
