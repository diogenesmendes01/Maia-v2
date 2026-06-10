/**
 * Issue #470 — archetype → pack wiring invariants.
 *
 * Pins three contracts:
 *   1. Every pack id in ARCHETYPE_PACK_MAP exists in TOOL_PACKS (a typo here
 *      would silently grant nothing — resolvePackTools is fail-closed).
 *   2. The backend ARCHETYPE_IDS and the wizard's ARCHETYPES catalog
 *      (admin-ui) stay in lockstep — a new archetype added on one side
 *      without the other fails here, not in production.
 *   3. Least privilege: no archetype grants domain.finance except
 *      'financeiro', and 'custom'/'agendador' grant nothing beyond the
 *      platform floor.
 */
import { describe, it, expect } from 'vitest';
import {
  ARCHETYPE_IDS,
  ARCHETYPE_PACK_MAP,
  isArchetypeId,
} from '@/tools/archetype-packs.js';
import { TOOL_PACKS, resolvePackTools } from '@/tools/grant-math.js';
import { BASE_AGENT_PACKS } from '@/tools/base-agent-packs.js';
import { ARCHETYPES } from '@/admin-ui/app/agents/_components/archetypes.js';

describe('ARCHETYPE_PACK_MAP', () => {
  it('every mapped pack id exists in TOOL_PACKS', () => {
    for (const id of ARCHETYPE_IDS) {
      for (const pack of ARCHETYPE_PACK_MAP[id]) {
        expect(TOOL_PACKS[pack], `pack '${pack}' (arquétipo '${id}')`).toBeDefined();
      }
    }
  });

  it('stays in lockstep with the wizard ARCHETYPES catalog', () => {
    const frontendIds = ARCHETYPES.map((a) => a.id).sort();
    expect(frontendIds).toEqual([...ARCHETYPE_IDS].sort());
    for (const a of ARCHETYPES) {
      expect(isArchetypeId(a.id), `wizard id '${a.id}' sem mapping de packs`).toBe(true);
    }
  });

  it('least privilege: only financeiro receives domain.finance', () => {
    for (const id of ARCHETYPE_IDS) {
      const packs = ARCHETYPE_PACK_MAP[id];
      if (id === 'financeiro') {
        expect(packs).toContain('domain.finance');
      } else {
        expect(packs).not.toContain('domain.finance');
      }
    }
  });

  it('custom and agendador grant nothing beyond the platform floor', () => {
    expect(ARCHETYPE_PACK_MAP.custom).toEqual([]);
    expect(ARCHETYPE_PACK_MAP.agendador).toEqual([]);
  });

  it('effective tools per archetype = floor ∪ archetype packs (sanity)', () => {
    const floorTools = new Set(resolvePackTools(BASE_AGENT_PACKS));
    const vendedorTools = new Set(
      resolvePackTools([...BASE_AGENT_PACKS, ...ARCHETYPE_PACK_MAP.vendedor]),
    );
    // Vendedor ganha algo além do floor…
    expect(vendedorTools.size).toBeGreaterThan(floorTools.size);
    // …mas nenhuma ferramenta que MOVE DINHEIRO (exclusivas do pack
    // domain.finance; tools utilitárias como identify_entity podem
    // legitimamente aparecer em mais de um pack).
    const moneyMovingTools = [
      'register_transaction',
      'cancel_transaction',
      'start_recurring_payment',
    ];
    for (const t of moneyMovingTools) {
      expect(vendedorTools.has(t), `vendedor não deveria ver '${t}'`).toBe(false);
    }
  });
});
