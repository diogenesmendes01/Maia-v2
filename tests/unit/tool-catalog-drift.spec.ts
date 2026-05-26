/**
 * PR #207 round 2 [DRIFT GUARD] — the committed tool-catalog artifact must
 * stay in sync with the registry.
 *
 * The Admin UI Tools Catalog router now consumes a GENERATED, side-effect-free
 * artifact (`src/admin-ui/generated/tool-catalog.ts`, produced by
 * `scripts/gen-tool-catalog.ts`) instead of importing the registry at request
 * time. That removes the gateway side-effect chain (presence `setInterval` +
 * queue Redis) from the admin-ui process — but it introduces a staleness risk:
 * if someone adds/renames/changes a tool (name, description, schema, gating
 * flag) and forgets to regenerate, the UI silently shows the old catalog.
 *
 * This test reproduces the generation IN-MEMORY (same `buildToolCatalog` +
 * `describeZodObject` the generator uses) and deep-equals the committed
 * `TOOL_CATALOG`. It fails loudly with a "run npm run gen:tool-catalog" hint
 * when they drift.
 *
 * Unlike the decouple-proof test, this one is ALLOWED to mock the gateway
 * (`@/gateway/presence` + `@/gateway/queue`): it asserts catalog CONTENT, not
 * side-effect-freeness, so stubbing the heavy gateway deps keeps it fast and
 * avoids opening a Redis socket / installing the presence timer.
 */
import { describe, it, expect, vi } from 'vitest';

// Light logger so importing the registry stays quiet.
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Stub baileys so importing the registry (→ send-proactive-message → baileys)
// stays light (no Redis/WhatsApp). Mirrors registry-tool-catalog.spec.ts.
vi.mock('../../src/gateway/baileys.js', () => ({
  MEDIA_ROOT: '/tmp/maia-catalog-drift-media',
  ensureMediaDirs: vi.fn(),
}));
// Gateway side-effect sources — stubbed here ON PURPOSE (this test asserts
// catalog content, not gateway-freeness; the no-side-effect contract is pinned
// in tools-catalog-decouple.spec.ts). Without these, importing the registry
// would install the presence sweep `setInterval` + construct the queue's
// IORedis connection.
vi.mock('../../src/gateway/presence.js', () => ({ markRead: vi.fn() }));
vi.mock('../../src/gateway/queue.js', () => ({
  enqueueAgent: vi.fn(),
  agentQueue: {},
}));

describe('tool-catalog artifact — in sync with the registry (drift guard)', () => {
  it('committed TOOL_CATALOG deep-equals a fresh in-memory generation', async () => {
    const { buildToolCatalog } = await import('../../src/tools/_registry.js');
    const { describeZodObject } = await import(
      '../../src/tools/describe-schema.js'
    );
    const { TOOL_CATALOG } = await import(
      '../../src/admin-ui/generated/tool-catalog.js'
    );

    // Reproduce EXACTLY what scripts/gen-tool-catalog.ts writes (minus the
    // `enabled` runtime field, which the artifact deliberately omits).
    const expected = buildToolCatalog()
      .map(({ tool, feature_flag }) => ({
        name: tool.name,
        description: tool.description,
        side_effect: tool.side_effect,
        operation_type: tool.operation_type,
        sensitive: tool.sensitive ?? false,
        feature_flag,
        required_actions: [...tool.required_actions],
        inputs: describeZodObject(tool.input_schema),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Normalize the committed artifact through JSON so the comparison is on
    // plain data (the artifact is typed but structurally identical).
    const committed = JSON.parse(JSON.stringify(TOOL_CATALOG));

    expect(
      committed,
      'src/admin-ui/generated/tool-catalog.ts is STALE — a tool was added, ' +
        'renamed, or its schema/description/gating flag changed without ' +
        'regenerating. Run `npm run gen:tool-catalog` and commit the result.',
    ).toEqual(expected);
  });

  it('every committed entry carries the expected static shape (no enabled)', async () => {
    const { TOOL_CATALOG } = await import(
      '../../src/admin-ui/generated/tool-catalog.js'
    );
    expect(TOOL_CATALOG.length).toBeGreaterThan(0);
    for (const entry of TOOL_CATALOG) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.description).toBe('string');
      expect(['none', 'read', 'write', 'communication']).toContain(
        entry.side_effect,
      );
      expect(typeof entry.sensitive).toBe('boolean');
      expect(Array.isArray(entry.required_actions)).toBe(true);
      expect(Array.isArray(entry.inputs)).toBe(true);
      // feature_flag is a string NAME or null.
      expect(
        entry.feature_flag === null || typeof entry.feature_flag === 'string',
      ).toBe(true);
      // `enabled` is runtime-only — it must NOT be baked into the artifact.
      expect(entry).not.toHaveProperty('enabled');
    }
  });
});
