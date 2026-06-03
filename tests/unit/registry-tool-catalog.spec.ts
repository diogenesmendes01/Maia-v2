/**
 * FIX 2 [MEDIUM] — the Admin UI Tools Catalog source must list EVERY tool,
 * including feature-gated ones, as `disabled` with the gating flag NAME when
 * the flag is off — instead of dropping them.
 *
 * Root cause: `REGISTRY` is built with conditional spreads
 * (`...(config.FEATURE_SCHEDULING_V2 ? {...} : {})`,
 * `...(config.FEATURE_PDF_REPORTS ? { generate_report } : {})`), so when those
 * env flags are off the tools are ABSENT from `Object.values(REGISTRY)`. The
 * catalog therefore never showed them. `buildToolCatalog()` re-adds them from
 * their direct definitions with the real `enabled` + flag name.
 *
 * Separately, the KSM `propose_*` tools live in `REGISTRY` but are gated at
 * runtime by `FEATURE_KNOWLEDGE_STATE_MACHINE_V1`; their catalog entry must
 * name that flag (previously `feature_flag` was null for them).
 *
 * Importing the real `_registry.js` here also exercises FIX 1: a bare import
 * of the registry (→ baileys) must not write `media/` to disk. (`baileys.js`
 * is stubbed for speed, but the no-side-effect contract is pinned directly in
 * `baileys-no-import-side-effects.spec.ts`.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Stub baileys so importing the registry stays light (no Redis/WhatsApp).
vi.mock('../../src/gateway/baileys.js', () => ({
  MEDIA_ROOT: '/tmp/maia-catalog-media',
  ensureMediaDirs: vi.fn(),
}));

/** All flags OFF — exercises the gated-but-listed path (the spec defaults). */
function configAllFlagsOff() {
  return {
    config: {
      FEATURE_PDF_REPORTS: false,
      FEATURE_SCHEDULING_V2: false,
      // P11: only the env fields still present in the trimmed config remain.
      // KNOWLEDGE_STATE_MACHINE_V1 / CALENDAR_V2 / SKILL_REGISTRY_V1 keep their
      // env field (retained for the admin-ui catalog); MULTI_CHANNEL /
      // COGNITIVE_GRAPH survive as enum flags too.
      FEATURE_KNOWLEDGE_STATE_MACHINE_V1: false,
      FEATURE_CALENDAR_V2: false,
      FEATURE_SKILL_REGISTRY_V1: false,
      FEATURE_MULTI_CHANNEL: false,
      FEATURE_COGNITIVE_GRAPH: false,
    },
  };
}

describe('buildToolCatalog — feature-gated tools listed as disabled (FIX 2)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('includes generate_report (PDF flag off) marked disabled w/ flag name', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', configAllFlagsOff);

    const { REGISTRY, buildToolCatalog } = await import('../../src/tools/_registry.js');
    // Precondition: the conditional spread drops it from REGISTRY when off.
    expect(REGISTRY.generate_report).toBeUndefined();

    const catalog = buildToolCatalog();
    const entry = catalog.find((e) => e.tool.name === 'generate_report');
    expect(entry).toBeDefined();
    expect(entry!.enabled).toBe(false);
    expect(entry!.feature_flag).toBe('FEATURE_PDF_REPORTS');
  });

  it('includes scheduling tools (always-on) enabled and ungated', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', configAllFlagsOff);

    const { REGISTRY, buildToolCatalog } = await import('../../src/tools/_registry.js');
    // SCHEDULING_V2 collapsed to always-on: the tools are unconditionally in
    // the registry, no longer gated by the config flag.
    expect(REGISTRY.schedule_reminder).toBeDefined();

    const catalog = buildToolCatalog();
    const names = ['schedule_reminder', 'cancel_reminder', 'start_recurring_outreach', 'start_recurring_payment'];
    for (const name of names) {
      const entry = catalog.find((e) => e.tool.name === name);
      expect(entry, `${name} missing from catalog`).toBeDefined();
      expect(entry!.enabled, `${name} should be enabled`).toBe(true);
      expect(entry!.feature_flag, `${name} flag name`).toBeNull();
    }
  });

  it('propose_* tools are always-enabled (KSM collapsed), catalog still names the flag', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', configAllFlagsOff);

    const { buildToolCatalog } = await import('../../src/tools/_registry.js');
    const catalog = buildToolCatalog();

    // KSM collapsed to always-on: propose_* are enabled regardless of config.
    // The catalog still annotates the (now dead) gating flag NAME so the Admin
    // UI artifact stays stable until the admin-ui teardown wave.
    const propose = catalog.find((e) => e.tool.name === 'propose_fact');
    expect(propose).toBeDefined();
    expect(propose!.enabled).toBe(true);
    expect(propose!.feature_flag).toBe('KNOWLEDGE_STATE_MACHINE_V1');

    // The other propose_* tools behave identically.
    for (const name of ['propose_rule', 'propose_memory', 'propose_hint']) {
      const e = catalog.find((x) => x.tool.name === name);
      expect(e!.feature_flag).toBe('KNOWLEDGE_STATE_MACHINE_V1');
      expect(e!.enabled).toBe(true);
    }
  });

  it('an always-on tool reports enabled with no gating flag', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', configAllFlagsOff);

    const { buildToolCatalog } = await import('../../src/tools/_registry.js');
    const entry = buildToolCatalog().find((e) => e.tool.name === 'query_balance');
    expect(entry).toBeDefined();
    expect(entry!.enabled).toBe(true);
    expect(entry!.feature_flag).toBeNull();
  });

  it('enables generate_report + scheduling tools when their flags are on', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({
      config: { ...configAllFlagsOff().config, FEATURE_PDF_REPORTS: true, FEATURE_SCHEDULING_V2: true },
    }));

    const { buildToolCatalog } = await import('../../src/tools/_registry.js');
    const catalog = buildToolCatalog();

    const report = catalog.find((e) => e.tool.name === 'generate_report');
    expect(report!.enabled).toBe(true);
    expect(report!.feature_flag).toBe('FEATURE_PDF_REPORTS');

    const sched = catalog.find((e) => e.tool.name === 'schedule_reminder');
    expect(sched!.enabled).toBe(true);

    // No duplicate entries even though generate_report is both in REGISTRY and
    // in CONFIG_GATED_TOOLS.
    const reportCount = catalog.filter((e) => e.tool.name === 'generate_report').length;
    expect(reportCount).toBe(1);
  });

  it('catalog is a superset of REGISTRY (never drops a registered tool)', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', configAllFlagsOff);

    const { REGISTRY, buildToolCatalog } = await import('../../src/tools/_registry.js');
    const catalogNames = new Set(buildToolCatalog().map((e) => e.tool.name));
    for (const name of Object.keys(REGISTRY)) {
      expect(catalogNames.has(name), `${name} dropped from catalog`).toBe(true);
    }
    // And it adds the config-gated tools on top.
    expect(catalogNames.has('generate_report')).toBe(true);
    expect(catalogNames.has('schedule_reminder')).toBe(true);
  });
});
