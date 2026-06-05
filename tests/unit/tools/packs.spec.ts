/**
 * Issue #410 — `baseline.core` tool-pack contract.
 *
 * DoD (a): the baseline pack MUST NOT contain domain/financial/sensitive tools
 * ("fora do baseline"), and MUST expose a stable, conservative contract that
 * #408 can extend with `domain.*` packs without redefining the type.
 *
 * These tests import the registry transitively (packs.ts → _registry.ts →
 * send-proactive-message → baileys/gateway), so we stub the gateway side-effect
 * sources exactly like the existing registry/catalog specs (presence timer +
 * queue Redis). We assert CONTRACT, not gateway side-effect-freeness.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/gateway/baileys.js', () => ({
  MEDIA_ROOT: '/tmp/maia-packs-spec-media',
  ensureMediaDirs: vi.fn(),
}));
vi.mock('../../../src/gateway/presence.js', () => ({ markRead: vi.fn() }));
vi.mock('../../../src/gateway/queue.js', () => ({
  enqueueAgent: vi.fn(),
  agentQueue: {},
}));

describe('baseline.core tool pack (issue #410)', () => {
  it('DEFAULT_AGENT_PACKS is exactly [baseline.core]', async () => {
    const { DEFAULT_AGENT_PACKS } = await import('../../../src/tools/packs.js');
    expect([...DEFAULT_AGENT_PACKS]).toEqual(['baseline.core']);
  });

  it('baseline.core is versioned and lists exactly the 7 baseline tools', async () => {
    const { BASELINE_CORE_PACK } = await import('../../../src/tools/packs.js');
    expect(BASELINE_CORE_PACK.id).toBe('baseline.core');
    expect(BASELINE_CORE_PACK.version).toBeGreaterThanOrEqual(1);
    expect([...BASELINE_CORE_PACK.tools].sort()).toEqual(
      [
        'audit_decision',
        'explain_limitation',
        'handoff_to_owner',
        'read_turn_context',
        'recall_memory',
        'remember_safe_fact',
        'request_confirmation',
      ].sort(),
    );
  });

  it('every baseline.core tool exists in the registry', async () => {
    const { BASELINE_CORE_PACK } = await import('../../../src/tools/packs.js');
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    for (const name of BASELINE_CORE_PACK.tools) {
      expect(REGISTRY[name], `baseline tool ${name} must be registered`).toBeDefined();
    }
  });

  it('FORA DO BASELINE: contains NO financial / domain / proactive-external tool', async () => {
    const { BASELINE_CORE_PACK } = await import('../../../src/tools/packs.js');
    const forbidden = [
      // finanças / transação / pagamento / relatório
      'register_transaction',
      'cancel_transaction',
      'query_balance',
      'list_transactions',
      'classify_transaction',
      'compare_entities',
      'generate_report',
      'start_recurring_payment',
      // CRM / cadastro
      'identify_entity',
      // envio proativo externo
      'send_proactive_message',
      'start_recurring_outreach',
      // workflows / agenda com efeito real
      'start_workflow',
      'schedule_reminder',
      'cancel_reminder',
      'register_custom_holiday',
    ];
    for (const name of forbidden) {
      expect(
        BASELINE_CORE_PACK.tools,
        `baseline.core must NOT include domain/sensitive tool ${name}`,
      ).not.toContain(name);
    }
  });

  it('CONSERVATIVE side effects: only one self-scoped write + one internal escalation', async () => {
    const { BASELINE_CORE_PACK } = await import('../../../src/tools/packs.js');
    const { REGISTRY } = await import('../../../src/tools/_registry.js');

    const writes = BASELINE_CORE_PACK.tools.filter(
      (n) => REGISTRY[n]!.side_effect === 'write',
    );
    const comms = BASELINE_CORE_PACK.tools.filter(
      (n) => REGISTRY[n]!.side_effect === 'communication',
    );
    // The ONLY baseline write is remember_safe_fact (scoped to own pessoa).
    expect(writes).toEqual(['remember_safe_fact']);
    // The ONLY baseline communication is handoff_to_owner (internal escalation,
    // NOT send_proactive_message).
    expect(comms).toEqual(['handoff_to_owner']);
    expect(comms).not.toContain('send_proactive_message');
  });

  it('resolvePackTools resolves baseline.core to its tool set and skips unknown packs', async () => {
    const { resolvePackTools, BASELINE_CORE_PACK } = await import(
      '../../../src/tools/packs.js'
    );
    const resolved = resolvePackTools(['baseline.core', 'domain.nonexistent']).sort();
    expect(resolved).toEqual([...BASELINE_CORE_PACK.tools].sort());
  });

  it('TOOL_PACKS registry exposes baseline.core by id (extension point for #408)', async () => {
    const { TOOL_PACKS } = await import('../../../src/tools/packs.js');
    expect(TOOL_PACKS['baseline.core']).toBeDefined();
    expect(TOOL_PACKS['baseline.core']!.id).toBe('baseline.core');
  });
});
