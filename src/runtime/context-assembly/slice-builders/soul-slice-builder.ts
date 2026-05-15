/**
 * P8b — buildSoulSlice (slice builder do Context Packet).
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
 */
import { soulBiasesRepo } from '@/control-plane/soul/soul-biases-repo.js';
import type { SoulBias, ActivationContext } from '@/db/schema.js';
import type { SoulScope } from '@/types/enums.js';
import type { SoulSlice, SoulSliceBias } from '../types/soul-slice.js';

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
};

export async function buildSoulSlice(args: BuildSoulSliceArgs): Promise<SoulSlice> {
  if (args.depth === 'none' || args.max_biases <= 0) {
    return emptySlice(args);
  }

  // Overbook 3x para dar espaço de filtragem + ranqueamento.
  const fetchLimit = Math.max(args.max_biases * 3, 20);
  const allActive = await soulBiasesRepo.findActiveForScope({ limit: fetchLimit });

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
 * Regras (todas devem passar quando o filtro está presente):
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
