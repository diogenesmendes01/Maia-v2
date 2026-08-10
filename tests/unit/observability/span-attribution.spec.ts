import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Issue #535 — owner review of PR #541, finding "the root `maia.turn` span
 * loses the real tenant/agent attribution".
 *
 * The defect: the root span is opened OUTSIDE the tenant scope
 * (`src/gateway/queue.ts` wraps the processor in `runWithSystemContext`), the
 * real tenant is opened NESTED inside the processor, and the span's attributes
 * were read at CLOSE — after that nested scope had unwound. Every root span
 * ever exported therefore said `tenant_id=system, agent_id=system`, while
 * `tool.dispatch` (opened inside the resolved scope) said the truth. A
 * waterfall whose root cannot be filtered by tenant, and whose children
 * disagree with it.
 *
 * This suite asserts the EXPORTED attribution — what reaches the sink, i.e.
 * what a collector would receive — never what the caller passed at open. That
 * distinction is the whole point: the old code passed nothing wrong, it read
 * the wrong thing at the wrong instant.
 *
 * The isolation invariant is the hard constraint, so it gets its own tests: a
 * span must never end up carrying ANOTHER tenant's tuple, including when two
 * jobs of different tenants are in flight at the same time.
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

import {
  publishSpanAttribution,
  recordElapsedSpan,
  setSpanSink,
  withSpan,
  type EndedSpan,
  type SpanAttribution,
} from '../../../src/observability/tracer.js';
import { runWithCorrelation } from '../../../src/observability/correlation.js';
import { SPAN } from '../../../src/observability/taxonomy.js';
import {
  runWithSystemContext,
  runWithTenantContext,
} from '../../../src/db/tenant-context.js';
import { renderPrometheus, _resetForTests } from '../../../src/lib/metrics.js';

const TRACE_A = '550e8400-e29b-41d4-a716-446655440000';
const TRACE_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const ACME = { tenant_id: 'acme', agent_id: 'acme-bot' } as const;
const GLOBEX = { tenant_id: 'globex', agent_id: 'globex-bot' } as const;

let captured: EndedSpan[] = [];

/** Yield to the event loop so the ALS frames really nest across ticks. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function spanNamed(name: string): EndedSpan | undefined {
  return captured.find((s) => s.name === name);
}

/**
 * The shape `src/gateway/queue.ts` + `src/agent/core.ts` actually produce:
 * root span → sanctioned `system` context → pre-resolution work (channel
 * resolver, cross-tenant adoption) → nested REAL tenant scope → the scope
 * unwinds → the root closes. Reproduced here rather than asserted on a
 * hand-rolled two-liner because the unwind IS the defect.
 */
async function turnLikeTheWorker(
  tenant: { tenant_id: string; agent_id: string },
  opts: {
    trace_id?: string;
    inside?: () => Promise<void>;
    throws?: Error;
    onAttribution?: (a: SpanAttribution) => void;
  } = {},
): Promise<void> {
  await runWithCorrelation({ trace_id: opts.trace_id ?? TRACE_A }, () =>
    withSpan(
      SPAN.TURN,
      () =>
        runWithSystemContext(async () => {
          // Pre-resolution window: no tenant known yet.
          await tick();
          // Espelha `src/agent/core.ts`: quem RESOLVE a tupla publica-a
          // explicitamente, depois de derivá-la e ANTES de abrir o escopo.
          // Não há hook em `runWithTenantContext` — ver o comentário lá.
          publishSpanAttribution(tenant);
          await runWithTenantContext(tenant, async () => {
            await tick();
            if (opts.inside) await opts.inside();
          });
          // Post-resolution: the nested scope is gone again, exactly as
          // `runAgentForMensagem` leaves it before returning to the worker.
          await tick();
          if (opts.throws) throw opts.throws;
        }),
      { attributes: { queue: 'agent' }, onAttribution: opts.onAttribution },
    ),
  );
}

beforeEach(() => {
  captured = [];
  cfg.endpoint = 'http://collector:4318/v1/traces';
  cfg.ratio = 1;
  setSpanSink((s) => captured.push(s));
});

afterEach(() => setSpanSink(null));

describe('issue #535 review — the root span carries the RESOLVED tenant', () => {
  it('exports the tenant the turn resolved to, not the pre-resolution system context', async () => {
    await turnLikeTheWorker(ACME);

    const root = spanNamed(SPAN.TURN);
    expect(root, 'the root span must be exported').toBeDefined();
    // The assertion is on the EXPORTED bag — what the collector receives.
    expect(root?.attributes.tenant_id).toBe('acme');
    expect(root?.attributes.agent_id).toBe('acme-bot');
  });

  it('root and children agree on the tuple instead of diverging', async () => {
    await turnLikeTheWorker(ACME, {
      inside: async () => {
        await withSpan(SPAN.TOOL_DISPATCH, async () => undefined, {
          attributes: { tool: 'listar_lancamentos' },
        });
      },
    });

    const root = spanNamed(SPAN.TURN);
    const child = spanNamed(SPAN.TOOL_DISPATCH);
    expect(child?.parent_span_id).toBe(root?.span_id);
    expect(root?.attributes.tenant_id).toBe(child?.attributes.tenant_id);
    expect(root?.attributes.agent_id).toBe(child?.attributes.agent_id);
    expect(root?.attributes.tenant_id).toBe('acme');
  });

  it('attributes a turn that THREW — a failed turn still belongs to a tenant', async () => {
    const boom = new Error('handler exploded');
    await expect(turnLikeTheWorker(ACME, { throws: boom })).rejects.toBe(boom);

    const root = spanNamed(SPAN.TURN);
    expect(root?.status).toBe('error');
    expect(root?.attributes.tenant_id).toBe('acme');
    expect(root?.attributes.agent_id).toBe('acme-bot');
  });

  it('reports the resolved tuple to `onAttribution` so a sibling span can use it', async () => {
    // This is the hook `queue.ts` uses to attribute the deferred `queue.wait`
    // span, which describes a window that closed before the worker existed.
    const seen: SpanAttribution[] = [];
    await turnLikeTheWorker(ACME, { onAttribution: (a) => seen.push(a) });
    expect(seen).toEqual([{ tenant_id: 'acme', agent_id: 'acme-bot' }]);
  });

  it('still falls back to the sanctioned `system` sentinel when nothing resolves', async () => {
    // The fallback is not deleted — a genuinely tenant-less span must stay
    // labelled, not unlabelled. It is just no longer the answer for a turn
    // that DID resolve a tenant.
    await runWithCorrelation({ trace_id: TRACE_A }, () =>
      withSpan(SPAN.TURN, () => runWithSystemContext(async () => tick())),
    );
    expect(spanNamed(SPAN.TURN)?.attributes.tenant_id).toBe('system');
    expect(spanNamed(SPAN.TURN)?.attributes.agent_id).toBe('system');
  });
});

describe('issue #535 review — attribution cannot cross tenants', () => {
  it('a nested `system` scope never downgrades a span that already resolved', async () => {
    await turnLikeTheWorker(ACME, {
      inside: async () => {
        // e.g. a global-maintenance helper invoked mid-turn.
        await runWithSystemContext(async () => tick());
      },
    });
    expect(spanNamed(SPAN.TURN)?.attributes.tenant_id).toBe('acme');
  });

  it('a SECOND, different tenant never re-stamps a span the first one owns', async () => {
    // Write-once. Re-stamping would put globex's tuple on a span that already
    // did acme's work — the exact isolation failure the invariant forbids.
    await turnLikeTheWorker(ACME, {
      inside: async () => {
        // Uma SEGUNDA resolução tentando publicar. Com o hook removido, é
        // preciso publicar explicitamente para reproduzir o conflito — que é
        // justamente o que um call site novo e descuidado faria.
        publishSpanAttribution(GLOBEX);
        await runWithTenantContext(GLOBEX, async () => tick());
      },
    });
    const root = spanNamed(SPAN.TURN);
    expect(root?.attributes.tenant_id).toBe('acme');
    expect(root?.attributes.agent_id).toBe('acme-bot');
  });

  it('COUNTS the conflict instead of swallowing it', async () => {
    // Dropping the second tuple is the safe behaviour, but a silent drop is
    // how a turn that touches two tenants stays invisible. The runbook tells
    // operators to investigate this series, so the series has to exist.
    _resetForTests();
    await turnLikeTheWorker(ACME, {
      inside: async () => {
        // Uma SEGUNDA resolução tentando publicar. Com o hook removido, é
        // preciso publicar explicitamente para reproduzir o conflito — que é
        // justamente o que um call site novo e descuidado faria.
        publishSpanAttribution(GLOBEX);
        await runWithTenantContext(GLOBEX, async () => tick());
      },
    });
    const exposition = await renderPrometheus();
    expect(exposition).toContain('maia_span_attribute_rejected_total');
    expect(exposition).toMatch(/reason="attribution_conflict"/);
    expect(exposition).toMatch(/span="turn"/);
  });

  it('two turns of DIFFERENT tenants running concurrently never swap tuples', async () => {
    // The risk the owner named explicitly. Both turns are parked INSIDE their
    // own tenant scope at the same time, so if attribution lived anywhere
    // shared (a module-level slot, a "last resolved" variable) one would
    // overwrite the other. It lives on the per-span object created inside
    // `spanStorage.run`, so there is nothing to race on.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked = 0;
    const park = async (): Promise<void> => {
      parked += 1;
      await gate;
    };

    const a = turnLikeTheWorker(ACME, { trace_id: TRACE_A, inside: park });
    const b = turnLikeTheWorker(GLOBEX, { trace_id: TRACE_B, inside: park });

    // Both must be sitting inside their tenant scope before either may finish.
    while (parked < 2) await tick();
    release();
    await Promise.all([a, b]);

    const roots = captured.filter((s) => s.name === SPAN.TURN);
    expect(roots).toHaveLength(2);

    const byTrace = new Map(roots.map((s) => [s.attributes.trace_id, s]));
    expect(byTrace.get(TRACE_A)?.attributes.tenant_id).toBe('acme');
    expect(byTrace.get(TRACE_A)?.attributes.agent_id).toBe('acme-bot');
    expect(byTrace.get(TRACE_B)?.attributes.tenant_id).toBe('globex');
    expect(byTrace.get(TRACE_B)?.attributes.agent_id).toBe('globex-bot');

    // Belt and braces: no span carries a MIXED tuple either.
    for (const root of roots) {
      expect(`${String(root.attributes.tenant_id)}/${String(root.attributes.agent_id)}`).toMatch(
        /^(acme\/acme-bot|globex\/globex-bot)$/,
      );
    }
  });
});

describe('issue #535 review — elapsed spans', () => {
  it('an elapsed span recorded inside a tenant scope is attributed to it', async () => {
    await runWithTenantContext(ACME, async () => {
      const now = Date.now();
      recordElapsedSpan(SPAN.QUEUE_WAIT, now - 1_000, now, { queue: 'agent' });
    });
    expect(spanNamed(SPAN.QUEUE_WAIT)?.attributes.tenant_id).toBe('acme');
  });

  it('an explicit tuple wins over the ambient read — how `queue.wait` is attributed', async () => {
    // `queue.wait` is emitted AFTER the turn, with the tenant scope long gone,
    // so `src/gateway/queue.ts` hands it the tuple the root resolved to.
    const now = Date.now();
    recordElapsedSpan(SPAN.QUEUE_WAIT, now - 1_000, now, { queue: 'agent', ...ACME });
    expect(spanNamed(SPAN.QUEUE_WAIT)?.attributes.tenant_id).toBe('acme');
    expect(spanNamed(SPAN.QUEUE_WAIT)?.attributes.agent_id).toBe('acme-bot');
  });
});
