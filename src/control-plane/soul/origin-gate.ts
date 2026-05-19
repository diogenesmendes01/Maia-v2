/**
 * P8b — Origin Gate (spec §7).
 *
 * Pure function: dado (origin, strength) de uma Soul Bias, decide se ela pode
 * sobrescrever uma parte de Identity LOCAL. Identity é a "constituição" do
 * agente; Soul é a "gravidade" — Soul só pode tencionar Identity quando há
 * autoridade humana clara por trás. Regras (spec §7 + invariante 11):
 *
 *   - origin ∈ {founder_explicit, human_approved, tenant_culture_explicit}
 *     E strength ≥ 0.95   → override PERMITIDO (origin_trusted_and_strong)
 *   - strength < 0.95     → BLOQUEIO (strength_below_threshold)
 *   - origin = learned_strong_evidence (qualquer strength)
 *                          → BLOQUEIO + emit alerta `soul_identity_conflict`
 *
 * `learned_strong_evidence` nunca sobrescreve, mesmo com strength=1.0 —
 * Identity só evolui via aprovação humana explícita. Quando a Maia detecta
 * tentativa de override learned, emite um drift alert + capability_proposal
 * (downstream do origin gate, fora deste pure function).
 *
 * Esta função NÃO lê DB, NÃO faz IO, NÃO tem dependências exceto types.
 * Determinística — testes exhaustivos (4 origins × 2 thresholds).
 */
import type { SoulOrigin } from '@/types/enums.js';

export type OverrideDecision =
  | { allowed: true; reason: 'origin_trusted_and_strong' }
  | { allowed: false; reason: 'strength_below_threshold' }
  | {
      allowed: false;
      reason: 'origin_blocks_override';
      alert: 'soul_identity_conflict';
    };

export const ORIGIN_GATE_STRENGTH_THRESHOLD = 0.95;

const TRUSTED_ORIGINS: ReadonlySet<SoulOrigin> = new Set([
  'founder_explicit',
  'human_approved',
  'tenant_culture_explicit',
]);

export function canSoulOverrideIdentity(bias: {
  origin: SoulOrigin;
  strength: number;
}): OverrideDecision {
  // Regra 1: strength must clear the threshold.
  if (bias.strength < ORIGIN_GATE_STRENGTH_THRESHOLD) {
    return { allowed: false, reason: 'strength_below_threshold' };
  }

  // Regra 2: learned_strong_evidence is permanently blocked (spec §7,
  // invariante 11). Emit an alert downstream — the gate flag this in the
  // result so the caller can persist the alert.
  if (bias.origin === 'learned_strong_evidence') {
    return {
      allowed: false,
      reason: 'origin_blocks_override',
      alert: 'soul_identity_conflict',
    };
  }

  // Regra 3: origin must be in the trusted set.
  if (!TRUSTED_ORIGINS.has(bias.origin)) {
    // Defensive: should not happen given the DB CHECK constraint, but a future
    // origin added without updating the gate would silently allow — return
    // a deny to fail safe.
    return { allowed: false, reason: 'strength_below_threshold' };
  }

  return { allowed: true, reason: 'origin_trusted_and_strong' };
}
