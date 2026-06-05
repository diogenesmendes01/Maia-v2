/**
 * Issue #415/#416 — thread the resolved operational role key into the
 * BaseContextPacket.
 *
 * `buildBaseContextPacketFromTurn` is the hot-path bridge from legacy turn
 * state (Mensagem + Conversa + Pessoa) into the BaseContextPacket the Decision
 * Engine consumes. The role-selector chain (`src/cognition/role-selector/`)
 * resolves the turn's active role BEFORE this builder runs (agent/core.ts); its
 * `decided_role.role_key` must land on `base.active_role_key` so the Decision
 * Engine can apply the role → skill scope (`applicable_to_role`, taxonomy §2
 * step 5).
 *
 * Fail-closed: when no role is resolved (role-agnostic / legacy turn), the key
 * stays undefined and role-bound skills are simply not selected downstream.
 */
import { describe, it, expect } from 'vitest';
import {
  buildBaseContextPacketFromTurn,
  type BuildBaseContextInput,
} from '@/runtime/decision/build-base-context.ts';
import type { Mensagem, Conversa, Pessoa } from '@/db/schema.js';

const ROLE = 'whatsapp_boleto_proposta_attendant';

const inbound = {
  id: 'm1',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  tipo: 'texto',
} as unknown as Mensagem;
const conversa = { id: 'c1' } as unknown as Conversa;
const pessoa = { id: 'p1' } as unknown as Pessoa;

function mkInput(
  overrides?: Partial<BuildBaseContextInput>,
): BuildBaseContextInput {
  return {
    inbound,
    conversa,
    pessoa,
    tenant_id: 'tn1',
    agent_id: 'ag1',
    channel_id: null,
    active_procedure_execution_id: null,
    ...overrides,
  };
}

describe('Issue #415/#416 — buildBaseContextPacketFromTurn threads active_role_key', () => {
  it('carries the resolved role key onto base.active_role_key', () => {
    const base = buildBaseContextPacketFromTurn(
      mkInput({ active_role_key: ROLE }),
    );
    expect(base.active_role_key).toBe(ROLE);
  });

  it('leaves active_role_key undefined when no role is resolved (fail-closed)', () => {
    const base = buildBaseContextPacketFromTurn(mkInput());
    expect(base.active_role_key).toBeUndefined();
  });
});
