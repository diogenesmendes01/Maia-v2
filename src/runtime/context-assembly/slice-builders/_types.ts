/**
 * P8a — SliceBuilder interface contract.
 *
 * Cada slice builder implementa esta interface. O orquestrador
 * `buildContextPacket()` invoca builders em paralelo via `Promise.all`,
 * cada um respeitando o `signal: AbortSignal` para o budget global de 600ms.
 *
 * Spec §3.2 do design doc.
 */

import type { BaseContextPacket, DecisionPacket, SliceName } from '../../context-packet/types.js';

export interface SliceBuilderInput<TReq> {
  base: BaseContextPacket;
  requirements: TReq;
  decision: DecisionPacket;
  signal: AbortSignal;
}

export interface SliceBuilderResult<TSlice> {
  slice: TSlice;
  cache_hit: boolean;
  duration_ms: number;
  fallback_depth_applied?: string;
}

export interface SliceBuilder<TReq, TSlice> {
  readonly name: SliceName;
  build(input: SliceBuilderInput<TReq>): Promise<SliceBuilderResult<TSlice>>;
  cacheKey(base: BaseContextPacket, req: TReq): string;
}
