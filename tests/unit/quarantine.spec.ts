import { describe, it, expect } from 'vitest';

// Tests focus on pure helpers exported from quarantine.ts. Full integration
// (DB + Baileys outbound) lives in tests/integration/identity-quarantine.spec.ts.

describe('quarantine — decision parser', () => {
  // Re-import via dynamic to keep this spec lightweight (no DB import chain).
  it('accepts affirmative variants', async () => {
    const { _internal } = await loadInternals();
    expect(_internal.parseDecision('sim')).toBe('aprova');
    expect(_internal.parseDecision('Sim, libera')).toBe('aprova');
    expect(_internal.parseDecision('aprova')).toBe('aprova');
    expect(_internal.parseDecision('  ok  ')).toBe('aprova');
  });

  it('accepts blocking variants', async () => {
    const { _internal } = await loadInternals();
    expect(_internal.parseDecision('não')).toBe('bloqueia');
    expect(_internal.parseDecision('nao')).toBe('bloqueia');
    expect(_internal.parseDecision('bloqueia')).toBe('bloqueia');
  });

  it('returns null for ambiguous input', async () => {
    const { _internal } = await loadInternals();
    expect(_internal.parseDecision('talvez')).toBeNull();
    expect(_internal.parseDecision('')).toBeNull();
  });

  it('masks phone keeping prefix and last 2 digits', async () => {
    const { _internal } = await loadInternals();
    expect(_internal.maskPhone('+5511999998888')).toBe('+551*****88');
    expect(_internal.maskPhone('+1')).toBe('***');
  });
});

async function loadInternals(): Promise<{
  _internal: {
    parseDecision: (s: string) => 'aprova' | 'bloqueia' | null;
    maskPhone: (s: string) => string;
  };
}> {
  // The module currently does not export these; re-export to make the spec
  // possible without importing DB. Keep the test honest by failing if the
  // module diverges.
  const mod = (await import('../../src/identity/quarantine.js')) as Record<string, unknown>;
  const internal = mod._internal as
    | {
        parseDecision: (s: string) => 'aprova' | 'bloqueia' | null;
        maskPhone: (s: string) => string;
      }
    | undefined;
  if (!internal) throw new Error('quarantine.ts must export _internal for tests');
  return { _internal: internal };
}
