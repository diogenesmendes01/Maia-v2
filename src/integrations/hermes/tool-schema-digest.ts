/**
 * P07 (spec §6.4.2, §6.6; README do worker) — `tool_schema_digest` do lado da
 * Maia.
 *
 * O frame `ready` traz o digest da superfície que o worker REGISTROU. O gate de
 * readiness só vale se o supervisor calcular o mesmo valor a partir do que ele
 * MANDOU no `start`. A definição nasceu no worker
 * (`services/hermes_worker/bridge_tools.py::tool_schema_digest`) e este módulo a
 * espelha byte a byte:
 *
 *  1. ordenar as tools por `name`, em ordem de CODE POINT (é o que o `sorted`
 *     do Python faz com `str`; o `sort` padrão do JS compara unidades UTF-16 e
 *     diverge fora do BMP);
 *  2. reduzir cada uma a `{name, input_schema, result_limit_chars}`;
 *  3. `canonicalDigest` da lista.
 *
 * A paridade é testada com vetores gerados pelo Python, não presumida.
 */
import { canonicalDigest } from './canonical-json.js';

/** A projeção de uma tool como ela desce no `start` (`manifest.tools[]`). */
export interface WorkerToolProjectionV1 {
  name: string;
  input_schema: Record<string, unknown>;
  result_limit_chars: number;
}

function compareCodePoints(a: string, b: string): number {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i]!.codePointAt(0)!;
    const y = cb[i]!.codePointAt(0)!;
    if (x !== y) return x - y;
  }
  return ca.length - cb.length;
}

export function computeToolSchemaDigest(tools: readonly WorkerToolProjectionV1[]): string {
  const projection = [...tools]
    .sort((a, b) => compareCodePoints(a.name, b.name))
    .map((t) => ({
      name: t.name,
      input_schema: t.input_schema,
      result_limit_chars: t.result_limit_chars,
    }));
  return canonicalDigest(projection);
}
