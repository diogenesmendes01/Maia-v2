/**
 * P8a Task 6 — UserSliceBuilder tests.
 *
 * Coverage: proactive_use filter, truncation, depth=none, cache,
 * pessoa+hints+memories combined.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  UserSliceBuilder,
  type UserLayerPort,
  type MemoryEntryRecord,
  type PessoaRecord,
  type BehavioralHintRecord,
} from '@/runtime/context-assembly/slice-builders/user-slice-builder.js';
import { InMemorySliceCache } from '@/runtime/context-packet/cache/slice-cache.js';
import { mockBase, mockDecision } from './_fixture.js';

const PESSOA: PessoaRecord = {
  id: 'p1',
  display_name: 'Diogenes',
  locale: 'pt-BR',
  preferences: { theme: 'dark' },
};

const memory = (
  id: string,
  proactive_use: boolean,
  overrides?: Partial<MemoryEntryRecord>,
): MemoryEntryRecord => ({
  id,
  kind: 'preference',
  content: `mem ${id}`,
  confidence: 0.8,
  scope: 'pessoa',
  sensitivity: 'normal',
  proactive_use,
  ...overrides,
});

const hint = (aspect: string, suggestion: string): BehavioralHintRecord => ({
  aspect,
  suggestion,
  strength: 0.5,
});

const mkPort = (
  memories: MemoryEntryRecord[],
  hints: BehavioralHintRecord[] = [],
  pessoa: PessoaRecord | null = PESSOA,
): UserLayerPort => ({
  async getPessoa() {
    return pessoa;
  },
  async listMemories() {
    return memories;
  },
  async listBehavioralHints() {
    return hints;
  },
});

describe('UserSliceBuilder', () => {
  let cache: InMemorySliceCache;
  beforeEach(() => {
    cache = new InMemorySliceCache();
  });

  it('filters memories by proactive_use=true', async () => {
    const mems = [
      memory('m1', true),
      memory('m2', false),
      memory('m3', true),
      memory('m4', false),
      memory('m5', true),
    ];
    const builder = new UserSliceBuilder(mkPort(mems), cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_items: 10 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.memories).toHaveLength(3);
    expect(r.slice.memories.map((m) => m.id)).toEqual(['m1', 'm3', 'm5']);
    expect(r.slice.truncated).toBe(false);
  });

  it('truncates to max_items when more proactive memories exist', async () => {
    const mems = Array.from({ length: 10 }, (_, i) => memory(`m${i}`, true));
    const builder = new UserSliceBuilder(mkPort(mems), cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_items: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.memories).toHaveLength(5);
    expect(r.slice.truncated).toBe(true);
  });

  it('depth=none returns empty slice without touching repo', async () => {
    let getPessoaCalled = false;
    const noisyPort: UserLayerPort = {
      async getPessoa() {
        getPessoaCalled = true;
        return PESSOA;
      },
      async listMemories() {
        return [];
      },
      async listBehavioralHints() {
        return [];
      },
    };
    const builder = new UserSliceBuilder(noisyPort, cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'none' },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.memories).toEqual([]);
    expect(r.slice.pessoa).toBeNull();
    expect(getPessoaCalled).toBe(false);
  });

  it('populates pessoa, preferences, and behavioral_hints', async () => {
    const builder = new UserSliceBuilder(
      mkPort([memory('m1', true)], [hint('ritmo', 'devagar')]),
      cache,
    );
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_items: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.pessoa).toEqual({
      id: 'p1',
      display_name: 'Diogenes',
      locale: 'pt-BR',
    });
    expect(r.slice.preferences).toEqual({ theme: 'dark' });
    expect(r.slice.behavioral_hints).toHaveLength(1);
    expect(r.slice.behavioral_hints[0]!.aspect).toBe('ritmo');
  });

  it('cache hit on second call with same key', async () => {
    const builder = new UserSliceBuilder(mkPort([memory('m1', true)]), cache);
    const first = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_items: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(first.cache_hit).toBe(false);

    const second = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_items: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(second.cache_hit).toBe(true);
    expect(second.slice.memories).toHaveLength(1);
  });

  it('returns empty pessoa block when port returns null pessoa', async () => {
    const builder = new UserSliceBuilder(
      mkPort([memory('m1', true)], [], null),
      cache,
    );
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_items: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.pessoa).toBeNull();
    expect(r.slice.preferences).toEqual({});
  });
});
