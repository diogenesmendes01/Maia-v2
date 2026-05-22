import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * PR #188 (issue #183) Codex round 1, [high]: storage moved from
 * `agent_facts` (per-tenant + per-agent) to `global_settings`
 * (process-wide). These tests now exercise the new repo seam.
 */

type GlobalRow = { value: unknown; updated_at: Date; updated_by: string | null };

const globalByKey = new Map<string, GlobalRow>();

const globalSettingsRepoMock = {
  getByKey: vi.fn(async (key: string): Promise<GlobalRow | null> => {
    return globalByKey.get(key) ?? null;
  }),
  updateAtomic: vi.fn(
    async (input: {
      keys: ReadonlyArray<{
        key: string;
        value: Record<string, unknown>;
        // Codex round 4: optional expected for optimistic concurrency.
        // null means "expect no row"; undefined means no check.
        expected?: Record<string, unknown> | null;
      }>;
      audit: { actor_id: string };
    }) => {
      const now = new Date();
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      let changed = 0;
      for (const entry of input.keys) {
        const lockedRow = globalByKey.get(entry.key) ?? null;
        before[entry.key] = lockedRow?.value ?? null;
        after[entry.key] = entry.value;
        if (JSON.stringify(lockedRow?.value ?? null) === JSON.stringify(entry.value)) {
          continue;
        }
        globalByKey.set(entry.key, {
          value: entry.value,
          updated_at: now,
          updated_by: input.audit.actor_id,
        });
        changed++;
      }
      if (changed === 0) {
        return { ok: false as const, reason: 'no_changes' as const, before };
      }
      return { ok: true as const, applied_at: now, before, after };
    },
  ),
};

// Codex round 5 [high]: legacy shim now writes back to agent_facts via
// factsRepo.upsert. Mock it so we can assert call shape without hitting
// the real applyTenantGuard path.
const factsRepoUpsertMock = vi.fn(
  async (input: {
    escopo: string;
    chave: string;
    valor: unknown;
    fonte: string;
  }) => ({ id: 'mock-id', ...input }),
);

vi.mock('../../src/db/repositories.js', () => ({
  globalSettingsRepo: globalSettingsRepoMock,
  factsRepo: { upsert: factsRepoUpsertMock },
}));

// Codex round 5 [high]: the legacy shim wraps factsRepo.upsert in
// runWithTenantContext({tenant_id:'default', agent_id:'default'}) so
// applyTenantGuard finds a context. Mock the wrapper to a no-op that
// just runs the callback so tests don't need AsyncLocalStorage state.
const runWithTenantContextMock = vi.fn(
  async <T>(_ctx: { tenant_id: string; agent_id: string }, fn: () => Promise<T>) =>
    fn(),
);

vi.mock('../../src/db/tenant-context.js', () => ({
  runWithTenantContext: runWithTenantContextMock,
}));

// Codex round 3 on PR #188 [high]: getCurrent*Model now dual-reads —
// global_settings → agent_facts (legacy) → env. The legacy fallback
// queries agent_facts via raw `db.execute(sql...)`, so we mock the
// `db` client to control what the legacy branch returns. Tests
// populate `legacyAgentFacts` with one OR MORE rows per key; the mock
// answers both the COUNT(DISTINCT) preflight (Codex round 4 [high]
// conflict guard) and the LIMIT 1 fetch from the same store.
type LegacyRow = { valor: unknown };
const legacyAgentFacts = new Map<string, LegacyRow[]>();
let legacyReadShouldThrow = false;
const _dialect = new PgDialect();

function setLegacyRow(key: string, row: LegacyRow): void {
  legacyAgentFacts.set(key, [row]);
}

function setLegacyRows(key: string, rows: LegacyRow[]): void {
  legacyAgentFacts.set(key, rows);
}

const dbExecuteMock = vi.fn(async (query: SQL) => {
  if (legacyReadShouldThrow) {
    throw new Error('simulated legacy read failure');
  }
  // Use the drizzle PgDialect to render the SQL to its bound params
  // form. The fallback fires TWO queries:
  //   1. COUNT(DISTINCT valor->>'model') — the round-4 conflict guard.
  //   2. SELECT valor ... ORDER BY updated_at DESC LIMIT 1 — the
  //      original fetch.
  // Both bind only the chave string, so we pull it from params, then
  // disambiguate by inspecting the rendered SQL string.
  const rendered = _dialect.sqlToQuery(query);
  const sqlText = rendered.sql;
  const key = (rendered.params as unknown[]).find(
    (p) => typeof p === 'string' && p.startsWith('llm.model.'),
  ) as string | undefined;
  if (!key) return { rows: [] };
  const rows = legacyAgentFacts.get(key) ?? [];

  if (sqlText.includes('COUNT(DISTINCT')) {
    // Compute distinct model count across all rows for this key.
    const distinct = new Set<string>();
    for (const r of rows) {
      const v = r.valor as { model?: unknown };
      if (v && typeof v.model === 'string') distinct.add(v.model);
    }
    return { rows: [{ distinct_count: String(distinct.size) }] };
  }

  // ORDER BY updated_at DESC LIMIT 1 — return the first row (the mock
  // store is already in "freshest first" order by convention).
  return { rows: rows.length > 0 ? [rows[0]!] : [] };
});

vi.mock('../../src/db/client.js', () => ({
  db: { execute: dbExecuteMock },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// Codex round 5 [high]: `LLM_PROVIDER` is now read dynamically by the
// source — on every read for the provider-mismatch check and on every
// write for the stamped `provider` field. Use a mutable reference so
// each test can flip the active provider without re-creating the mock.
let mockLlmProvider: 'anthropic' | 'openrouter' = 'openrouter';

vi.mock('../../src/config/env.js', () => ({
  config: {
    get LLM_PROVIDER() {
      return mockLlmProvider;
    },
    OPENROUTER_MODEL_MAIN: 'anthropic/claude-sonnet-4.6',
    OPENROUTER_MODEL_FAST: 'anthropic/claude-haiku-4.5',
    CLAUDE_MODEL_MAIN: 'claude-sonnet-4-6',
    CLAUDE_MODEL_FAST: 'claude-haiku-4-5-20251001',
  },
}));

beforeEach(() => {
  globalByKey.clear();
  legacyAgentFacts.clear();
  legacyReadShouldThrow = false;
  globalSettingsRepoMock.getByKey.mockClear();
  globalSettingsRepoMock.updateAtomic.mockClear();
  factsRepoUpsertMock.mockClear();
  runWithTenantContextMock.mockClear();
  mockLlmProvider = 'openrouter';
});

describe('llm-settings (global_settings storage)', () => {
  it('returns env default for main when no row set (provider=openrouter)', async () => {
    const { getCurrentMainModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentMainModel()).toBe('anthropic/claude-sonnet-4.6');
  });

  it('returns env default for fast when no row set (provider=openrouter)', async () => {
    const { getCurrentFastModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentFastModel()).toBe('anthropic/claude-haiku-4.5');
  });

  it('reads from global_settings when the row exists', async () => {
    globalByKey.set('llm.model.main', {
      value: { model: 'openai/gpt-5' },
      updated_at: new Date(),
      updated_by: 'founder@example.com',
    });
    const { getCurrentMainModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentMainModel()).toBe('openai/gpt-5');
  });

  // Codex round 5 on PR #188 [high]: the round-2 fail-loud throw was
  // wrong. Until PR #176 retires the legacy `/dashboard/llm-settings`
  // route, that form's POST handler is still wired up — throwing would
  // 500 the page during incident response (precisely the window the
  // feature exists to support). Round 5 reverts the shims to legacy
  // behavior: write back to `agent_facts` via `factsRepo.upsert`, with
  // a `llm_settings.legacy_write_used` warn log so the deprecated
  // route can be charted to zero usage. The new admin-ui
  // `/setup/llm-settings` still owns the canonical `global_settings`
  // path; the shims never touch it.
  it('legacy setCurrentMainModel writes to agent_facts via factsRepo (no global_settings touched)', async () => {
    const { setCurrentMainModel } = await import(
      '../../src/lib/llm-settings.js'
    );
    await setCurrentMainModel('openai/gpt-5');

    // Wrote to agent_facts under the legacy storage shape — the
    // round-3 dual-read fallback can find it.
    expect(factsRepoUpsertMock).toHaveBeenCalledTimes(1);
    expect(factsRepoUpsertMock).toHaveBeenCalledWith({
      escopo: 'global',
      chave: 'llm.model.main',
      valor: { model: 'openai/gpt-5' },
      fonte: 'configurado',
    });
    // Wrapped in runWithTenantContext({tenant_id:'default',
    // agent_id:'default'}) so applyTenantGuard finds a context. The
    // legacy single-tenant dashboard handler doesn't establish one.
    expect(runWithTenantContextMock).toHaveBeenCalledWith(
      { tenant_id: 'default', agent_id: 'default' },
      expect.any(Function),
    );
    // The canonical (founder-only) path is NOT touched.
    expect(globalSettingsRepoMock.updateAtomic).not.toHaveBeenCalled();
  });

  it('legacy setCurrentFastModel mirrors the main shim behavior', async () => {
    const { setCurrentFastModel } = await import(
      '../../src/lib/llm-settings.js'
    );
    await setCurrentFastModel('deepseek/deepseek-r1');

    expect(factsRepoUpsertMock).toHaveBeenCalledTimes(1);
    expect(factsRepoUpsertMock).toHaveBeenCalledWith({
      escopo: 'global',
      chave: 'llm.model.fast',
      valor: { model: 'deepseek/deepseek-r1' },
      fonte: 'configurado',
    });
    expect(runWithTenantContextMock).toHaveBeenCalled();
    expect(globalSettingsRepoMock.updateAtomic).not.toHaveBeenCalled();
  });

  // Codex round 5 [high]: the deprecation warn log is the signal
  // operators chart to monitor legacy-form usage. Confirm it fires.
  it('legacy shim emits llm_settings.legacy_write_used warn', async () => {
    const logger = (await import('../../src/lib/logger.js')).logger as {
      warn: ReturnType<typeof vi.fn>;
    };
    logger.warn.mockClear();
    const { setCurrentMainModel } = await import(
      '../../src/lib/llm-settings.js'
    );
    await setCurrentMainModel('openai/gpt-5');
    const calls = logger.warn.mock.calls.filter(
      (c: unknown[]) => c[1] === 'llm_settings.legacy_write_used',
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to env default if DB throws on read (no legacy row either)', async () => {
    globalSettingsRepoMock.getByKey.mockRejectedValueOnce(
      new Error('connection lost'),
    );
    const { getCurrentMainModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentMainModel()).toBe('anthropic/claude-sonnet-4.6');
  });

  // Codex round 3 on PR #188 [high]: dual-read fallback.
  //
  // Rolling deploy / pre-062 scenario: global_settings doesn't have the
  // key yet (table is empty or migration 062 hasn't run in this process),
  // BUT the legacy `/dashboard/llm-settings` UI previously wrote a row
  // into agent_facts. Before the dual-read fallback was added, runtime
  // would silently revert to the env default and ignore the operator's
  // last-good choice — exactly the dangerous path during a provider
  // outage. With the fallback, agent_facts is consulted before env.
  it('dual-read fallback: agent_facts read when global_settings is empty (main)', async () => {
    setLegacyRow('llm.model.main', {
      valor: { model: 'openai/gpt-5' },
    });
    const { getCurrentMainModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentMainModel()).toBe('openai/gpt-5');
  });

  it('dual-read fallback: agent_facts read when global_settings is empty (fast)', async () => {
    setLegacyRow('llm.model.fast', {
      valor: { model: 'x-ai/grok-4.1-fast' },
    });
    const { getCurrentFastModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentFastModel()).toBe('x-ai/grok-4.1-fast');
  });

  it('dual-read fallback: global_settings wins over legacy agent_facts when both exist', async () => {
    globalByKey.set('llm.model.main', {
      value: { model: 'openai/gpt-5' },
      updated_at: new Date(),
      updated_by: 'founder@example.com',
    });
    setLegacyRow('llm.model.main', {
      valor: { model: 'anthropic/claude-opus-4.7' }, // older legacy row
    });
    const { getCurrentMainModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentMainModel()).toBe('openai/gpt-5');
  });

  it('dual-read fallback: legacy read failure does not block env fallback', async () => {
    legacyReadShouldThrow = true;
    const { getCurrentMainModel } = await import('../../src/lib/llm-settings.js');
    // global_settings empty, legacy read throws → env default still served.
    expect(await getCurrentMainModel()).toBe('anthropic/claude-sonnet-4.6');
  });

  it('dual-read fallback: legacy used when global read throws', async () => {
    globalSettingsRepoMock.getByKey.mockRejectedValueOnce(
      new Error('connection lost'),
    );
    setLegacyRow('llm.model.main', {
      valor: { model: 'openai/gpt-5' },
    });
    const { getCurrentMainModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentMainModel()).toBe('openai/gpt-5');
  });

  it('dual-read fallback: malformed legacy valor (no .model) ignored, env wins', async () => {
    setLegacyRow('llm.model.main', {
      valor: { not_model: 'garbage' },
    });
    const { getCurrentMainModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentMainModel()).toBe('anthropic/claude-sonnet-4.6');
  });

  it('envDefaults returns the expected struct for openrouter provider', async () => {
    const { envDefaults } = await import('../../src/lib/llm-settings.js');
    expect(envDefaults()).toEqual({
      main: 'anthropic/claude-sonnet-4.6',
      fast: 'anthropic/claude-haiku-4.5',
      provider: 'openrouter',
    });
  });

  it('setGlobalLLMSettingsAtomic flips both keys and surfaces before/after', async () => {
    // Seed the "fast" row so we can prove before reflects what's stored.
    globalByKey.set('llm.model.fast', {
      value: { model: 'anthropic/claude-haiku-4.5' },
      updated_at: new Date(),
      updated_by: 'seed',
    });

    const { setGlobalLLMSettingsAtomic } = await import('../../src/lib/llm-settings.js');
    const res = await setGlobalLLMSettingsAtomic({
      main: 'openai/gpt-5',
      fast: 'x-ai/grok-4.1-fast',
      // The mock updateAtomic doesn't enforce expected_* (only the
      // real repo does — see global-settings-repo.spec.ts integration
      // test). Pass realistic values so the helper signature matches.
      expected_main: 'anthropic/claude-sonnet-4.6',
      expected_fast: 'anthropic/claude-haiku-4.5',
      updated_by: 'founder@example.com',
      actor_role: 'founder',
      tenant_id: 'tenant-test',
      comment: 'Anthropic outage at 14:30 UTC',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.before).toEqual({
      main: null, // not previously set → null (router will map to env)
      fast: 'anthropic/claude-haiku-4.5',
    });
    expect(res.after).toEqual({
      main: 'openai/gpt-5',
      fast: 'x-ai/grok-4.1-fast',
    });
  });

  it('setGlobalLLMSettingsAtomic returns no_changes when nothing differs', async () => {
    // Codex round 5 [high]: writes stamp `provider` too, so we seed
    // the full round-5 shape here. A pre-round-5 row missing the
    // provider field would correctly be UPDATED on the next save
    // (the helper would now write the marker) — exercised in the
    // separate "stamps provider" tests above.
    globalByKey.set('llm.model.main', {
      value: { model: 'openai/gpt-5', provider: 'openrouter' },
      updated_at: new Date(),
      updated_by: 'seed',
    });
    globalByKey.set('llm.model.fast', {
      value: { model: 'openai/gpt-5', provider: 'openrouter' },
      updated_at: new Date(),
      updated_by: 'seed',
    });

    const { setGlobalLLMSettingsAtomic } = await import('../../src/lib/llm-settings.js');
    const res = await setGlobalLLMSettingsAtomic({
      main: 'openai/gpt-5',
      fast: 'openai/gpt-5',
      expected_main: 'openai/gpt-5',
      expected_fast: 'openai/gpt-5',
      updated_by: 'founder@example.com',
      actor_role: 'founder',
      tenant_id: 'tenant-test',
      comment: 'no-op renew should be rejected',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('no_changes');
  });

  // Codex round 3 on PR #188 [P2]: helper propagates the
  // optimistic_conflict reason from the repo, translating the repo's
  // KEY namespace ('llm.model.main') into the LLM-domain `field`
  // discriminator ('main'). The router uses this field to render the
  // UI message — exercise the translation here.
  it('setGlobalLLMSettingsAtomic maps optimistic_conflict for main', async () => {
    // Configure the mock to return optimistic_conflict for this call.
    globalSettingsRepoMock.updateAtomic.mockResolvedValueOnce({
      ok: false as const,
      reason: 'optimistic_conflict' as const,
      key: 'llm.model.main',
      expected: { model: 'anthropic/claude-sonnet-4.6' },
      current: { model: 'openai/gpt-5' },
      before: {
        'llm.model.main': { model: 'openai/gpt-5' },
        'llm.model.fast': { model: 'anthropic/claude-haiku-4.5' },
      },
    });

    const { setGlobalLLMSettingsAtomic } = await import(
      '../../src/lib/llm-settings.js'
    );
    const res = await setGlobalLLMSettingsAtomic({
      main: 'x-ai/grok-4.1-fast',
      fast: 'anthropic/claude-haiku-4.5',
      expected_main: 'anthropic/claude-sonnet-4.6',
      expected_fast: 'anthropic/claude-haiku-4.5',
      updated_by: 'founder@example.com',
      actor_role: 'founder',
      tenant_id: 'tenant-test',
      comment: 'racing with another founder',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('optimistic_conflict');
    if (res.reason !== 'optimistic_conflict') throw new Error('unreachable');
    expect(res.field).toBe('main');
    expect(res.expected).toBe('anthropic/claude-sonnet-4.6');
    expect(res.current).toBe('openai/gpt-5');
  });

  it('setGlobalLLMSettingsAtomic maps optimistic_conflict for fast', async () => {
    globalSettingsRepoMock.updateAtomic.mockResolvedValueOnce({
      ok: false as const,
      reason: 'optimistic_conflict' as const,
      key: 'llm.model.fast',
      expected: { model: 'anthropic/claude-haiku-4.5' },
      current: { model: 'x-ai/grok-4.1-fast' },
      before: {
        'llm.model.main': { model: 'anthropic/claude-sonnet-4.6' },
        'llm.model.fast': { model: 'x-ai/grok-4.1-fast' },
      },
    });

    const { setGlobalLLMSettingsAtomic } = await import(
      '../../src/lib/llm-settings.js'
    );
    const res = await setGlobalLLMSettingsAtomic({
      main: 'anthropic/claude-sonnet-4.6',
      fast: 'openai/gpt-5',
      expected_main: 'anthropic/claude-sonnet-4.6',
      expected_fast: 'anthropic/claude-haiku-4.5',
      updated_by: 'founder@example.com',
      actor_role: 'founder',
      tenant_id: 'tenant-test',
      comment: 'race on fast side',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('optimistic_conflict');
    if (res.reason !== 'optimistic_conflict') throw new Error('unreachable');
    expect(res.field).toBe('fast');
  });

  // ============================================================
  // Codex round 4 on PR #188 [high]: source-aware read (Finding 1).
  // The admin UI needs to know whether each side's value came from a
  // real global_settings row, a legacy agent_facts fallback, or the
  // env default — so it can pass `expected_*: null` on a fresh install
  // and avoid the first-update CONFLICT loop.
  // ============================================================
  describe('getCurrentLLMSettings (source-aware)', () => {
    it('source=env when no global_settings row and no legacy row exists', async () => {
      const { getCurrentLLMSettings } = await import(
        '../../src/lib/llm-settings.js',
      );
      const r = await getCurrentLLMSettings();
      expect(r.main).toEqual({
        value: 'anthropic/claude-sonnet-4.6',
        source: 'env',
      });
      expect(r.fast).toEqual({
        value: 'anthropic/claude-haiku-4.5',
        source: 'env',
      });
    });

    it('source=global when global_settings has a row', async () => {
      globalByKey.set('llm.model.main', {
        value: { model: 'openai/gpt-5' },
        updated_at: new Date(),
        updated_by: 'founder@example.com',
      });
      const { getCurrentLLMSettings } = await import(
        '../../src/lib/llm-settings.js',
      );
      const r = await getCurrentLLMSettings();
      expect(r.main).toEqual({ value: 'openai/gpt-5', source: 'global' });
      // fast still env (no global, no legacy)
      expect(r.fast.source).toBe('env');
    });

    it('source=legacy when only legacy agent_facts row exists', async () => {
      setLegacyRow('llm.model.main', {
        valor: { model: 'openai/gpt-5' },
      });
      const { getCurrentLLMSettings } = await import(
        '../../src/lib/llm-settings.js',
      );
      const r = await getCurrentLLMSettings();
      expect(r.main).toEqual({ value: 'openai/gpt-5', source: 'legacy' });
      expect(r.fast.source).toBe('env');
    });
  });

  // ============================================================
  // Codex round 4 on PR #188 [high]: legacy fallback conflict guard
  // (Finding 3). When agent_facts contains multiple DISTINCT model
  // values for the same key (e.g. two tenants picked different models
  // pre-migration), the fallback must NOT pick one and promote it
  // process-wide — that would silently impose one tenant's choice on
  // every tenant. Mirror migration 062's behavior: fail-closed to
  // env default and log llm_settings.legacy_fallback_conflict.
  // ============================================================
  describe('legacy fallback conflict guard', () => {
    it('two distinct legacy values → env default (fail-closed)', async () => {
      setLegacyRows('llm.model.main', [
        { valor: { model: 'openai/gpt-5' } },
        { valor: { model: 'anthropic/claude-opus-4.7' } },
      ]);
      const { getCurrentMainModel } = await import(
        '../../src/lib/llm-settings.js',
      );
      // Distinct count = 2 → guard trips → env default served.
      expect(await getCurrentMainModel()).toBe('anthropic/claude-sonnet-4.6');
    });

    it('one distinct legacy value across multiple rows → promote it', async () => {
      // Two rows from different tenants, but same model — safe to
      // promote.
      setLegacyRows('llm.model.main', [
        { valor: { model: 'openai/gpt-5' } },
        { valor: { model: 'openai/gpt-5' } },
      ]);
      const { getCurrentMainModel } = await import(
        '../../src/lib/llm-settings.js',
      );
      expect(await getCurrentMainModel()).toBe('openai/gpt-5');
    });

    it('source=legacy still flagged when single distinct value present', async () => {
      setLegacyRows('llm.model.main', [
        { valor: { model: 'openai/gpt-5' } },
        { valor: { model: 'openai/gpt-5' } },
      ]);
      const { getCurrentLLMSettings } = await import(
        '../../src/lib/llm-settings.js',
      );
      const r = await getCurrentLLMSettings();
      expect(r.main).toEqual({ value: 'openai/gpt-5', source: 'legacy' });
    });
  });

  // ============================================================
  // Codex round 5 on PR #188 [high]: provider field on write +
  // provider-mismatch fallback on read. Writes stamp `provider`
  // alongside `model` (config.LLM_PROVIDER snapshot at write time).
  // Reads compare stored provider against current config; mismatch
  // → fallback to env default + warn log. Pre-round-5 rows with no
  // provider field are trusted.
  // ============================================================
  describe('provider field (Codex round 5)', () => {
    it('write stamps provider alongside model (provider=anthropic mode)', async () => {
      mockLlmProvider = 'anthropic';
      const { setGlobalLLMSettingsAtomic } = await import(
        '../../src/lib/llm-settings.js',
      );
      await setGlobalLLMSettingsAtomic({
        main: 'claude-sonnet-4-6',
        fast: 'claude-haiku-4-5-20251001',
        expected_main: null,
        expected_fast: null,
        updated_by: 'founder@example.com',
        actor_role: 'founder',
        tenant_id: 'tenant-test',
        comment: 'first install on anthropic provider',
      });
      const lastCall = globalSettingsRepoMock.updateAtomic.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const passed = lastCall![0];
      expect(passed.keys[0]!.value).toEqual({
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
      });
      expect(passed.keys[1]!.value).toEqual({
        model: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
      });
    });

    it('write stamps provider=openrouter when LLM_PROVIDER=openrouter', async () => {
      mockLlmProvider = 'openrouter';
      const { setGlobalLLMSettingsAtomic } = await import(
        '../../src/lib/llm-settings.js',
      );
      await setGlobalLLMSettingsAtomic({
        main: 'openai/gpt-5',
        fast: 'x-ai/grok-4.1-fast',
        expected_main: null,
        expected_fast: null,
        updated_by: 'founder@example.com',
        actor_role: 'founder',
        tenant_id: 'tenant-test',
        comment: 'router stamps openrouter',
      });
      const lastCall = globalSettingsRepoMock.updateAtomic.mock.calls.at(-1);
      const passed = lastCall![0];
      expect(passed.keys[0]!.value).toEqual({
        model: 'openai/gpt-5',
        provider: 'openrouter',
      });
    });

    // Mismatch: stored under anthropic, current env says openrouter.
    // Runtime must not feed claude-sonnet-4-6 to the OpenRouter client.
    it('read falls back to env default on stored.provider !== current.provider', async () => {
      mockLlmProvider = 'openrouter';
      globalByKey.set('llm.model.main', {
        value: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
        updated_at: new Date(),
        updated_by: 'someone-on-anthropic',
      });
      const { getCurrentMainModel } = await import(
        '../../src/lib/llm-settings.js',
      );
      // Env default for openrouter is anthropic/claude-sonnet-4.6.
      // The stored anthropic-native slug must NOT be served.
      expect(await getCurrentMainModel()).toBe('anthropic/claude-sonnet-4.6');
    });

    it('read uses stored value when provider matches', async () => {
      mockLlmProvider = 'anthropic';
      globalByKey.set('llm.model.main', {
        value: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
        updated_at: new Date(),
        updated_by: 'founder@example.com',
      });
      const { getCurrentMainModel } = await import(
        '../../src/lib/llm-settings.js',
      );
      expect(await getCurrentMainModel()).toBe('claude-sonnet-4-6');
    });

    it('symmetric: stored=openrouter slug but current=anthropic → fallback', async () => {
      mockLlmProvider = 'anthropic';
      globalByKey.set('llm.model.main', {
        value: { model: 'openai/gpt-5', provider: 'openrouter' },
        updated_at: new Date(),
        updated_by: 'someone-on-openrouter',
      });
      const { getCurrentMainModel } = await import(
        '../../src/lib/llm-settings.js',
      );
      // Env default for anthropic is claude-sonnet-4-6.
      expect(await getCurrentMainModel()).toBe('claude-sonnet-4-6');
    });

    it('pre-round-5 row (no provider field) is trusted unchanged', async () => {
      mockLlmProvider = 'anthropic';
      // Old shape: just {model}. The compat check returns ok=true so
      // the read serves it. Migration 062 backfills the provider
      // marker, so this branch shrinks to deployments stuck mid-rollout
      // — explicit by design.
      globalByKey.set('llm.model.main', {
        value: { model: 'claude-sonnet-4-6' },
        updated_at: new Date(),
        updated_by: 'pre-round-5-writer',
      });
      const { getCurrentMainModel } = await import(
        '../../src/lib/llm-settings.js',
      );
      expect(await getCurrentMainModel()).toBe('claude-sonnet-4-6');
    });

    it('mismatch emits llm_settings.provider_mismatch warn', async () => {
      mockLlmProvider = 'openrouter';
      globalByKey.set('llm.model.main', {
        value: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
        updated_at: new Date(),
        updated_by: 'someone-on-anthropic',
      });
      const logger = (await import('../../src/lib/logger.js')).logger as {
        warn: ReturnType<typeof vi.fn>;
      };
      logger.warn.mockClear();
      const { getCurrentMainModel } = await import(
        '../../src/lib/llm-settings.js',
      );
      await getCurrentMainModel();
      const warns = logger.warn.mock.calls.filter(
        (c: unknown[]) => c[1] === 'llm_settings.provider_mismatch',
      );
      expect(warns.length).toBeGreaterThanOrEqual(1);
      // The log payload includes both providers + the stored model so
      // ops can spot the env flip vs the staleness in one shot.
      const payload = warns[0]![0] as Record<string, unknown>;
      expect(payload.stored_provider).toBe('anthropic');
      expect(payload.current_provider).toBe('openrouter');
      expect(payload.stored_model).toBe('claude-sonnet-4-6');
    });
  });

  // ============================================================
  // Codex round 4 on PR #188 [high]: expected_*=null support for the
  // first-ever update on a fresh install (Finding 1). The helper
  // must accept null and pass it through to the repo as expected:
  // null so the locked placeholder (JSON null) matches.
  // ============================================================
  describe('setGlobalLLMSettingsAtomic accepts expected_*=null', () => {
    it('first update succeeds when expected_main=null and no global row exists', async () => {
      const { setGlobalLLMSettingsAtomic } = await import(
        '../../src/lib/llm-settings.js',
      );
      const res = await setGlobalLLMSettingsAtomic({
        main: 'openai/gpt-5',
        fast: 'x-ai/grok-4.1-fast',
        expected_main: null,
        expected_fast: null,
        updated_by: 'founder@example.com',
        actor_role: 'founder',
        tenant_id: 'tenant-test',
        comment: 'fresh install — first ever update',
      });
      expect(res.ok).toBe(true);
      // The mock updateAtomic doesn't enforce expected, but we want to
      // confirm that the helper PASSES expected:null (not wraps it in
      // {model: null}) so the real repo's `null === null` match fires.
      const lastCall = globalSettingsRepoMock.updateAtomic.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const passedInput = lastCall![0];
      expect(passedInput.keys[0]!.expected).toBeNull();
      expect(passedInput.keys[1]!.expected).toBeNull();
    });

    it('expected_*=string still wraps into {model: <slug>}', async () => {
      globalByKey.set('llm.model.main', {
        value: { model: 'anthropic/claude-sonnet-4.6' },
        updated_at: new Date(),
        updated_by: 'seed',
      });
      globalByKey.set('llm.model.fast', {
        value: { model: 'anthropic/claude-haiku-4.5' },
        updated_at: new Date(),
        updated_by: 'seed',
      });
      const { setGlobalLLMSettingsAtomic } = await import(
        '../../src/lib/llm-settings.js',
      );
      await setGlobalLLMSettingsAtomic({
        main: 'openai/gpt-5',
        fast: 'openai/gpt-5',
        expected_main: 'anthropic/claude-sonnet-4.6',
        expected_fast: 'anthropic/claude-haiku-4.5',
        updated_by: 'founder@example.com',
        actor_role: 'founder',
        tenant_id: 'tenant-test',
        comment: 'standard update with observed expected values',
      });
      const lastCall = globalSettingsRepoMock.updateAtomic.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const passedInput = lastCall![0];
      expect(passedInput.keys[0]!.expected).toEqual({
        model: 'anthropic/claude-sonnet-4.6',
      });
      expect(passedInput.keys[1]!.expected).toEqual({
        model: 'anthropic/claude-haiku-4.5',
      });
    });
  });
});
