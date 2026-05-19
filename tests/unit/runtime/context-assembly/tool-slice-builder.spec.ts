/**
 * P8a Task 11 — ToolPermissionSliceBuilder tests.
 *
 * Allowed tools from decision get hydrated with descriptor metadata.
 * Blocked + requires_confirmation pass through from the decision authoritatively.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ToolPermissionSliceBuilder,
  type ToolDescriptor,
  type ToolRegistryPort,
} from '@/runtime/context-assembly/slice-builders/tool-slice-builder.js';
import { InMemorySliceCache } from '@/runtime/context-packet/cache/slice-cache.js';
import { mockBase, mockDecision } from './_fixture.js';

const descriptor = (
  name: string,
  overrides?: Partial<ToolDescriptor>,
): ToolDescriptor => ({
  name,
  side_effect_level: 'low',
  requires_confirmation: false,
  idempotent: true,
  audit_level: 'standard',
  timeout_ms: 5000,
  ...overrides,
});

const mkRegistry = (
  descs: Record<string, ToolDescriptor | null>,
): ToolRegistryPort => ({
  async getToolDescriptor(name) {
    return descs[name] ?? null;
  },
});

describe('ToolPermissionSliceBuilder', () => {
  let cache: InMemorySliceCache;
  beforeEach(() => {
    cache = new InMemorySliceCache();
  });

  it('hydrates allowed_tools with descriptor metadata', async () => {
    const builder = new ToolPermissionSliceBuilder(
      mkRegistry({
        transfer: descriptor('transfer', {
          side_effect_level: 'high',
          requires_confirmation: true,
          idempotent: false,
          audit_level: 'high',
          timeout_ms: 10000,
        }),
        list_pending: descriptor('list_pending', {
          side_effect_level: 'none',
          idempotent: true,
        }),
      }),
      cache,
    );
    const decision = mockDecision({
      tool_permissions: {
        allowed_tools: ['transfer', 'list_pending'],
        blocked_tools: ['admin_reset'],
        requires_confirmation: ['transfer'],
      },
    });
    const r = await builder.build({
      base: mockBase(),
      requirements: {},
      decision,
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.available_tools).toHaveLength(2);
    const transfer = r.slice.available_tools.find((t) => t.name === 'transfer');
    expect(transfer).toBeDefined();
    expect(transfer!.side_effect_level).toBe('high');
    expect(transfer!.audit_level).toBe('high');
    expect(transfer!.timeout_ms).toBe(10000);
  });

  it('passes blocked_tools and requires_confirmation through from decision', async () => {
    const builder = new ToolPermissionSliceBuilder(mkRegistry({}), cache);
    const decision = mockDecision({
      tool_permissions: {
        allowed_tools: [],
        blocked_tools: ['delete_all', 'admin_reset'],
        requires_confirmation: ['transfer', 'invoice'],
      },
    });
    const r = await builder.build({
      base: mockBase(),
      requirements: {},
      decision,
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.blocked_tools).toEqual(['delete_all', 'admin_reset']);
    expect(r.slice.requires_confirmation).toEqual(['transfer', 'invoice']);
  });

  it('drops tools without registry descriptor (no metadata = unsafe)', async () => {
    const builder = new ToolPermissionSliceBuilder(
      mkRegistry({ transfer: descriptor('transfer') }),
      cache,
    );
    const decision = mockDecision({
      tool_permissions: {
        allowed_tools: ['transfer', 'ghost_tool'],
        blocked_tools: [],
        requires_confirmation: [],
      },
    });
    const r = await builder.build({
      base: mockBase(),
      requirements: {},
      decision,
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.available_tools.map((t) => t.name)).toEqual(['transfer']);
  });

  it('returns empty slice when decision has no tool permissions', async () => {
    const builder = new ToolPermissionSliceBuilder(mkRegistry({}), cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: {},
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.available_tools).toEqual([]);
    expect(r.slice.blocked_tools).toEqual([]);
    expect(r.slice.requires_confirmation).toEqual([]);
  });

  it('cache hit on second call with same decision', async () => {
    const builder = new ToolPermissionSliceBuilder(
      mkRegistry({ t1: descriptor('t1') }),
      cache,
    );
    const decision = mockDecision({
      tool_permissions: {
        allowed_tools: ['t1'],
        blocked_tools: [],
        requires_confirmation: [],
      },
    });
    const a = await builder.build({
      base: mockBase(),
      requirements: {},
      decision,
      signal: AbortSignal.timeout(600),
    });
    expect(a.cache_hit).toBe(false);
    const b = await builder.build({
      base: mockBase(),
      requirements: {},
      decision,
      signal: AbortSignal.timeout(600),
    });
    expect(b.cache_hit).toBe(true);
  });

  it('different decisions produce different cache keys', async () => {
    const builder = new ToolPermissionSliceBuilder(
      mkRegistry({ t1: descriptor('t1'), t2: descriptor('t2') }),
      cache,
    );
    const decisionA = mockDecision({
      tool_permissions: { allowed_tools: ['t1'], blocked_tools: [], requires_confirmation: [] },
    });
    const decisionB = mockDecision({
      tool_permissions: { allowed_tools: ['t2'], blocked_tools: [], requires_confirmation: [] },
    });
    const a = await builder.build({
      base: mockBase(),
      requirements: {},
      decision: decisionA,
      signal: AbortSignal.timeout(600),
    });
    const b = await builder.build({
      base: mockBase(),
      requirements: {},
      decision: decisionB,
      signal: AbortSignal.timeout(600),
    });
    expect(a.cache_hit).toBe(false);
    expect(b.cache_hit).toBe(false);
    expect(a.slice.available_tools[0]!.name).toBe('t1');
    expect(b.slice.available_tools[0]!.name).toBe('t2');
  });
});
