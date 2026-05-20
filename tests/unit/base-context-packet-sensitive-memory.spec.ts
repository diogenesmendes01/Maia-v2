/**
 * Tests: active_sensitive_memory_count wiring (closes PR #158 gap).
 *
 * T1: BaseContextBuilder.build() calls the sensitive-memory counter and
 *     populates active_sensitive_memory_count when counter returns 3.
 * T2: Build populates active_sensitive_memory_count: 0 when counter returns 0.
 * T3: Agent isolation — counter is called with agent_id=A, not agent_id=B.
 *
 * The counter port is injected via the BaseContextBuilder constructor so tests
 * can mock it without DB access.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  BaseContextBuilder,
  type SensitiveMemoryCounterPort,
} from '@/runtime/context-packet/base-context-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkCounter(count: number): SensitiveMemoryCounterPort {
  return {
    countActiveSensitive: vi.fn().mockResolvedValue(count),
  };
}

const baseInput = {
  raw_input: { text: 'hello' },
  channel_id: 'ch-1',
  received_at: new Date('2026-05-20T10:00:00Z'),
  tenant_id: 'tenant-A',
  agent_id: 'agent-A',
  session_id: 'sess-1',
  conversation_id: 'conv-1',
  user_id: null,
  pessoa_id: null,
  actor_role: 'end_user',
  is_authenticated: true,
  channel_kind: 'api' as const,
  is_locked_down: false,
  active_procedure_execution_id: null,
  input_kind: 'text' as const,
};

// ---------------------------------------------------------------------------
// T1: counter returns 3 → packet field = 3
// ---------------------------------------------------------------------------
describe('BaseContextBuilder — active_sensitive_memory_count population', () => {
  it('T1: counter returns 3 → packet has active_sensitive_memory_count=3', async () => {
    const counter = mkCounter(3);
    const builder = new BaseContextBuilder(undefined, undefined, counter);

    const packet = await builder.build(baseInput);

    expect(packet.active_sensitive_memory_count).toBe(3);
    expect(counter.countActiveSensitive).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // T2: zero memories
  // -------------------------------------------------------------------------
  it('T2: counter returns 0 → packet has active_sensitive_memory_count=0', async () => {
    const counter = mkCounter(0);
    const builder = new BaseContextBuilder(undefined, undefined, counter);

    const packet = await builder.build(baseInput);

    expect(packet.active_sensitive_memory_count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // T3: agent isolation — counter called with agent_id=A, not B
  // -------------------------------------------------------------------------
  it('T3: counter is called with the effective agent_id (agent isolation)', async () => {
    const counter = mkCounter(1);
    const builder = new BaseContextBuilder(undefined, undefined, counter);

    await builder.build({
      ...baseInput,
      tenant_id: 'tenant-shared',
      agent_id: 'agent-A',
    });

    const callArgs = (counter.countActiveSensitive as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      tenant_id: string;
      agent_id: string;
      conversation_id?: string;
    };

    // Must pass agent_id='agent-A', NOT any other agent in the same tenant.
    expect(callArgs?.agent_id).toBe('agent-A');
    expect(callArgs?.tenant_id).toBe('tenant-shared');
  });
});
