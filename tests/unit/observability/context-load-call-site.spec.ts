import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Issue #535 gate 6 — `instrumentContextLoad` has a REAL call site.
 *
 * The defect this file exists to prevent is not "the wrapper is broken" — the
 * wrapper has had a spec since #535 landed. The defect is that NOTHING called
 * it: `maia_context_load_ms` was dashboarded (`maia:context_load_ms:p95`),
 * alerted on, documented, and produced zero series, because the only code that
 * ever invoked the wrapper was its own unit test.
 *
 * So every assertion below goes through the PRODUCTION assembly
 * (`buildContextPacket`) and reads the metric registry / span sink afterwards.
 * None of them calls `instrumentContextLoad` directly: a test that rebuilds the
 * call site inside its own harness passes with the production call site
 * DELETED, which is exactly the state this gate is closing. Delete the
 * `instrumentContextLoad(...)` line in
 * `src/runtime/context-packet/build-context-packet.ts` and this file must go
 * red.
 */
const cfg = vi.hoisted(() => ({
  endpoint: 'http://collector:4318/v1/traces' as string | undefined,
  ratio: 1,
  strict: false,
}));
vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env.js')>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop, receiver) => {
        if (prop === 'MAIA_OTLP_TRACES_ENDPOINT') return cfg.endpoint;
        if (prop === 'MAIA_OTLP_SAMPLE_RATIO') return cfg.ratio;
        if (prop === 'MAIA_STRICT_METRIC_LABELS') return cfg.strict;
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

import { buildContextPacket } from '@/runtime/context-packet/build-context-packet.js';
import type {
  BuildContextPacketDeps,
  SliceBuilderSet,
} from '@/runtime/context-packet/build-context-packet.js';
import type {
  SliceBuilder,
  SliceBuilderResult,
} from '@/runtime/context-assembly/slice-builders/_types.js';
import type {
  BaseContextPacket,
  HistorySlice,
  SliceName,
} from '@/runtime/context-packet/types.js';
import { _resetForTests, renderPrometheus } from '@/lib/metrics.js';
import { _resetLabelGuardForTests } from '@/observability/labels.js';
import { setSpanSink, withSpan, type EndedSpan } from '@/observability/tracer.js';
import { runWithCorrelation } from '@/observability/correlation.js';
import {
  CONTEXT_LOAD_STAGE,
  CONTEXT_LOAD_STAGE_VALUES,
  SPAN,
} from '@/observability/taxonomy.js';
import { mockBase, mockDecision } from '../runtime/context-assembly/_fixture.js';

const TURN_UUID = '550e8400-e29b-41d4-a716-446655440000';

let captured: EndedSpan[] = [];

beforeEach(() => {
  _resetForTests();
  _resetLabelGuardForTests();
  captured = [];
  cfg.endpoint = 'http://collector:4318/v1/traces';
  cfg.ratio = 1;
  setSpanSink((s) => captured.push(s));
});

afterEach(() => setSpanSink(null));

// ---------------------------------------------------------------------------
// Minimal in-memory builder set. Deliberately NOT the production wiring: this
// suite is about the instrumentation of the assembly, and real ports would put
// a database between the call site and the assertion.
// ---------------------------------------------------------------------------

function fakeBuilder<TSlice>(
  name: SliceName,
  slice: TSlice,
  behavior: 'ok' | 'throw' | 'hang' = 'ok',
): SliceBuilder<unknown, TSlice> {
  return {
    name,
    async build(): Promise<SliceBuilderResult<TSlice>> {
      if (behavior === 'throw') throw new Error(`${name} builder exploded`);
      if (behavior === 'hang') await new Promise(() => undefined);
      return { slice, cache_hit: false, duration_ms: 1 };
    },
    cacheKey: () => `${name}:k`,
  };
}

function builderSet(
  overrides: Partial<Record<keyof SliceBuilderSet, SliceBuilder<unknown, unknown>>> = {},
): SliceBuilderSet {
  const set = {
    identity: fakeBuilder('identity', { role_descriptor: 'r' }),
    user: fakeBuilder('user', { pessoa: null }),
    knowledge: fakeBuilder('knowledge', { facts: [], rules: [] }),
    soul: fakeBuilder('soul', { active_biases: [] }),
    policy: fakeBuilder('policy', { policy_id: 'p' }),
    skill: fakeBuilder('skill', { mode: 'candidates' }),
    tool: fakeBuilder('tool', { available_tools: [] }),
    ...overrides,
  };
  return set as unknown as SliceBuilderSet;
}

const emptyHistory = async (): Promise<HistorySlice> => ({
  turns: [],
  truncated: false,
});

function deps(
  overrides: Partial<BuildContextPacketDeps> = {},
): BuildContextPacketDeps {
  return { builders: builderSet(), historyLoader: emptyHistory, ...overrides };
}

/** All `stage` values the context-load families emitted, deduplicated. */
async function emittedStages(): Promise<string[]> {
  const text = await renderPrometheus();
  const stages = new Set<string>();
  for (const line of text.split('\n')) {
    if (
      !line.startsWith('maia_context_load_ms') &&
      !line.startsWith('maia_context_slices_total')
    ) {
      continue;
    }
    const m = /stage="([^"]*)"/.exec(line);
    if (m) stages.add(m[1]!);
  }
  return [...stages].sort();
}

/** Value of `maia_context_slices_total` for a given stage+status. */
async function sliceCount(stage: string, status: string): Promise<number> {
  const text = await renderPrometheus();
  for (const line of text.split('\n')) {
    if (!line.startsWith('maia_context_slices_total')) continue;
    if (!line.includes(`stage="${stage}"`)) continue;
    if (!line.includes(`status="${status}"`)) continue;
    return Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return 0;
}

describe('issue #535 gate 6 — buildContextPacket emits context.load', () => {
  it('produces the packet stage on the histogram and the slice counter', async () => {
    await buildContextPacket({ base: mockBase(), decision: mockDecision() }, deps());

    const text = await renderPrometheus();
    // Both families, both with stage="packet" and status="ok". This is the
    // series the dashboard panel `maia:context_load_ms:p95` reads.
    expect(text).toMatch(/maia_context_load_ms_count\{.*stage="packet".*status="ok"/);
    expect(text).toMatch(/maia_context_slices_total\{.*stage="packet".*status="ok"/);
  });

  it('opens exactly ONE context.load span per assembly, never nested twice', async () => {
    await buildContextPacket({ base: mockBase(), decision: mockDecision() }, deps());

    const spans = captured.filter((s) => s.name === SPAN.CONTEXT_LOAD);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes.stage).toBe('packet');
    expect(spans[0]!.status).toBe('ok');
    // One assembly ⇒ one counter increment. A double wrap (entry point AND
    // body) would read as two packets assembled for one turn and would halve
    // every per-packet rate on the dashboard.
    expect(await sliceCount('packet', 'ok')).toBe(1);
  });

  it('counts once per assembly, not once per process', async () => {
    await buildContextPacket({ base: mockBase(), decision: mockDecision() }, deps());
    await buildContextPacket({ base: mockBase(), decision: mockDecision() }, deps());
    expect(await sliceCount('packet', 'ok')).toBe(2);
    expect(captured.filter((s) => s.name === SPAN.CONTEXT_LOAD)).toHaveLength(2);
  });

  it('nests the assembly span under the open turn span', async () => {
    await runWithCorrelation({ trace_id: TURN_UUID }, () =>
      withSpan(SPAN.TURN, () =>
        buildContextPacket({ base: mockBase(), decision: mockDecision() }, deps()),
      ),
    );
    const ctx = captured.find((s) => s.name === SPAN.CONTEXT_LOAD);
    const turn = captured.find((s) => s.name === SPAN.TURN);
    // SPAN_PARENT declares `turn` as context.load's parent; the waterfall has
    // to agree, otherwise "the turn was slow HERE" resolves to nowhere.
    expect(ctx?.parent_span_id).toBe(turn?.span_id);
  });

  it('spans the WHOLE assembly, not a fragment of it', async () => {
    // A wrapper placed around a sub-step would finish long before the slowest
    // slice. 60ms of history load must therefore be INSIDE the measurement.
    const slowHistory = async (): Promise<HistorySlice> => {
      await new Promise((r) => setTimeout(r, 60));
      return { turns: [], truncated: false };
    };
    await buildContextPacket(
      { base: mockBase(), decision: mockDecision() },
      deps({ historyLoader: slowHistory, timeoutPerSliceMs: 500, budgetMs: 2000 }),
    );
    const span = captured.find((s) => s.name === SPAN.CONTEXT_LOAD)!;
    const durationMs = Number(span.end_unix_nano - span.start_unix_nano) / 1e6;
    expect(durationMs).toBeGreaterThanOrEqual(50);
  });
});

describe('issue #535 gate 6 — the metric never swallows a failure', () => {
  it('rethrows the policy failure unchanged and marks status=error', async () => {
    const boom = new Error('policy builder exploded');
    const policy: SliceBuilder<unknown, unknown> = {
      name: 'policy',
      build: async () => {
        throw boom;
      },
      cacheKey: () => 'policy:k',
    };

    await expect(
      buildContextPacket(
        { base: mockBase(), decision: mockDecision() },
        deps({ builders: builderSet({ policy }) }),
      ),
      // Same Error INSTANCE, not a wrapped copy: the fail-closed contract of
      // the policy slice is what the caller branches on.
    ).rejects.toBe(boom);

    expect(await sliceCount('packet', 'error')).toBe(1);
    expect(await sliceCount('packet', 'ok')).toBe(0);
    const span = captured.find((s) => s.name === SPAN.CONTEXT_LOAD);
    expect(span?.status).toBe('error');
  });

  it('keeps the fail-closed timeout message and its pre-existing counter', async () => {
    const recordCounter = vi.fn();
    await expect(
      buildContextPacket(
        { base: mockBase(), decision: mockDecision() },
        deps({
          builders: builderSet({ policy: fakeBuilder('policy', {}, 'hang') }),
          timeoutPerSliceMs: 10,
          budgetMs: 60,
          metrics: { recordCounter },
        }),
      ),
    ).rejects.toThrow(/Policy slice builder exceeded timeout/);

    // The metric that already existed before this gate must still fire — the
    // wrapper observes, it does not replace.
    expect(recordCounter).toHaveBeenCalledWith('context_packet.policy_timeout');
    expect(await sliceCount('packet', 'error')).toBe(1);
  });

  it('leaves a degraded non-policy slice as a SUCCESSFUL assembly', async () => {
    // Degradation is the orchestrator working: the packet is returned with a
    // conservative slice. Recording it as `status="error"` would make every
    // Redis blip read as a context-load outage.
    const packet = await buildContextPacket(
      { base: mockBase(), decision: mockDecision() },
      deps({ builders: builderSet({ user: fakeBuilder('user', {}, 'throw') }) }),
    );
    expect(packet.assembly_meta.fallback_depths_applied.user).toBe('degraded');
    expect(await sliceCount('packet', 'ok')).toBe(1);
    expect(await sliceCount('packet', 'error')).toBe(0);
  });
});

describe('issue #535 gate 6 — the stage set is CLOSED', () => {
  it('emits only `packet`, even when every input string is hostile', async () => {
    // Everything a caller controls is set to something that must never reach a
    // label: a tenant-derived name, a slice name from the wire, free text. If
    // any of them can become a `stage`, the 60-value budget stops bounding
    // anything and each tenant mints its own permanent series.
    const hostileBase = mockBase({
      tenant_id: 'tenant-<script>',
      agent_id: 'agent-from-config',
      conversation_id: 'conv-99',
      channel: { id: 'ch-99', kind: 'stage_from_input' as never, is_locked_down: false },
    } as Partial<BaseContextPacket>);
    const hostileDecision = mockDecision({
      intent: { label: 'stage_from_intent', confidence: 0.1 },
    });
    const renamed = builderSet({
      identity: fakeBuilder('identity_from_registry' as SliceName, {}),
      user: fakeBuilder('user_🙈' as SliceName, {}),
    });

    await buildContextPacket(
      { base: hostileBase, decision: hostileDecision },
      deps({ builders: renamed }),
    );

    expect(await emittedStages()).toEqual(['packet']);
  });

  it('every emitted stage is a member of the declared vocabulary', async () => {
    await buildContextPacket({ base: mockBase(), decision: mockDecision() }, deps());
    await expect(
      buildContextPacket(
        { base: mockBase(), decision: mockDecision() },
        deps({ builders: builderSet({ policy: fakeBuilder('policy', {}, 'throw') }) }),
      ),
    ).rejects.toThrow();

    const stages = await emittedStages();
    expect(stages.length).toBeGreaterThan(0);
    for (const stage of stages) {
      expect(CONTEXT_LOAD_STAGE_VALUES as readonly string[]).toContain(stage);
    }
    // And the vocabulary is not aspirational: `packet` is what runs.
    expect(stages).toContain(CONTEXT_LOAD_STAGE.PACKET);
  });
});
