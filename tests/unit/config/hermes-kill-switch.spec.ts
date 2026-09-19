/**
 * K-15 — o kill switch do Hermes falha FECHADO: só `false`/`0` explícitos o
 * deixam solto. `boolFlag` leria `TRUE`/`yes`/`on` como `false`, e o operador
 * que tentasse desligar o Hermes o deixaria ligado.
 */
import { describe, expect, it } from 'vitest';
import { findSpec } from '@/config/contract.js';

const parse = (v: string | undefined): unknown =>
  findSpec('MAIA_HERMES_KILL_SWITCH')!.schema.parse(v);

describe('MAIA_HERMES_KILL_SWITCH', () => {
  it('ausente ou false/0 explícito: solto', () => {
    for (const v of [undefined, 'false', '0', 'FALSE', ' false ']) expect(parse(v)).toBe(false);
  });

  it('qualquer outro valor aciona, inclusive caixa, sinônimo e erro de digitação', () => {
    for (const v of ['true', 'TRUE', 'True', ' true', '1', 'yes', 'on', 'ture', '']) {
      expect(parse(v), JSON.stringify(v)).toBe(true);
    }
  });
});
