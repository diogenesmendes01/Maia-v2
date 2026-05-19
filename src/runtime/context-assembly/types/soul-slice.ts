/**
 * P8b — SoulSlice type.
 *
 * Slice produzido pelo `soul-slice-builder` (uma fatia do Context Packet do P8a).
 * Carrega as soul biases ativas que aplicam ao turno + um `rendered_block`
 * pronto pra entrar no prompt como "Orientação persistente".
 *
 * EXPORTAÇÃO: este arquivo é o source of truth. P8a (quando aterrissar) faz
 * `export type { SoulSlice } from '../soul/types/soul-slice.js'` na sua barrel
 * — não duplica o tipo.
 */
import type { SoulOrigin, SoulScope } from '@/types/enums.js';

export type SoulSliceBias = {
  id: string;
  scope: SoulScope;
  scope_value: string;
  principle: string;
  guidance: string;
  /** ∈ [0, 1]. */
  strength: number;
  origin: SoulOrigin;
};

export interface SoulSlice {
  /** Biases que passaram filtro + ranking + truncate. */
  active_biases: SoulSliceBias[];

  /**
   * Bloco markdown pronto pra prompt; null quando depth='none' ou nenhuma
   * bias passou no filtro de activation_context.
   */
  rendered_block: string | null;

  /** Total ativo no DB (pre-truncate). */
  total_active: number;

  /** Quantas entraram no slice (post-truncate). */
  truncated_to: number;

  /** Chave determinística pra cache (P8a integration). */
  cache_key: string;

  /** Timestamp de resolução. */
  resolved_at: Date;
}
