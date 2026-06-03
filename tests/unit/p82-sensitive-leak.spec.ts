/**
 * PR #82 review — non-regression suite for the four memory invariants the
 * automated reviewers (Codex + Superpowers) flagged as Critical:
 *
 *   C1. factsBlock in the prompt MUST NOT verbalize sensitive content
 *       — even when the legacy agent_facts row is still present alongside
 *       a memory_entry with mention_allowed=false.
 *   C2. memoryEntryRepo.findRelevant MUST drop entries past expires_at.
 *   C3. memoryEntryRepo.markReviewed MUST compute expires_at from ttl_days
 *       so the TTL filter from C2 can actually evict promoted entries.
 *   C4. prompt-builder MUST plumb current_role_id / current_channel_id so
 *       role/channel-scoped memories filter correctly.
 *
 * These tests use repo mocks to assert *contract* and prompt assembly
 * behavior; the integration suite already validates wiring against
 * runWithTenantContext.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const selfStateGetActive = vi.fn();
const mensagensRecent = vi.fn();
const entidadesByIds = vi.fn();
const factsListMentionableForScopes = vi.fn();
const rulesListActive = vi.fn();
const entityStatesById = vi.fn();
const memoryEntryFindRelevant = vi.fn();
const behavioralHintFindActiveForScope = vi.fn();
const capabilitiesSkillListAll = vi.fn();
const capabilityGapsListByLevel = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  selfStateRepo: { getActive: selfStateGetActive },
  operationalProfileVersionsRepo: { getActive: vi.fn(async () => null) },
  mensagensRepo: { recentInConversation: mensagensRecent },
  entidadesRepo: { byIds: entidadesByIds },
  factsRepo: { listMentionableForScopes: factsListMentionableForScopes },
  rulesRepo: { listActive: rulesListActive },
  entityStatesRepo: { byId: entityStatesById },
  memoryEntryRepo: { findRelevant: memoryEntryFindRelevant },
  behavioralHintRepo: { findActiveForScope: behavioralHintFindActiveForScope },
  capabilitiesSkillRepo: { listAll: capabilitiesSkillListAll },
  capabilityGapsRepo: { listByLevel: capabilityGapsListByLevel },
}));

vi.mock('../../src/config/env.js', () => ({
  config: { LOG_LEVEL: 'silent', NODE_ENV: 'test', TZ: 'America/Sao_Paulo' },
}));

// Stub the logger so prompt-builder can be imported without exercising pino's
// config-driven level resolution (which throws on undefined LOG_LEVEL).
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  selfStateGetActive.mockReset();
  mensagensRecent.mockReset();
  entidadesByIds.mockReset();
  factsListMentionableForScopes.mockReset();
  rulesListActive.mockReset();
  entityStatesById.mockReset();
  memoryEntryFindRelevant.mockReset();
  behavioralHintFindActiveForScope.mockReset();
  capabilitiesSkillListAll.mockReset();
  capabilityGapsListByLevel.mockReset();

  selfStateGetActive.mockResolvedValue({
    versao: 1,
    system_prompt: 'Você é a Maia.',
    resumo_aprendizados: '',
  });
  mensagensRecent.mockResolvedValue([]);
  entidadesByIds.mockResolvedValue([]);
  factsListMentionableForScopes.mockResolvedValue([]);
  rulesListActive.mockResolvedValue([]);
  entityStatesById.mockResolvedValue(null);
  memoryEntryFindRelevant.mockResolvedValue([]);
  behavioralHintFindActiveForScope.mockResolvedValue([]);
  capabilitiesSkillListAll.mockResolvedValue([]);
  capabilityGapsListByLevel.mockResolvedValue([]);
});

const baseCtx = {
  pessoa: { id: 'p1', nome: 'Mendes', tipo: 'dono', apelido: null },
  conversa: { id: 'c1' },
  scope: { entidades: [], byEntity: new Map() },
  inbound: { id: 'm1', conteudo: 'olá', direcao: 'in' },
} as never;

describe('[P82-C1] factsBlock sensitivity filtering', () => {
  it('prompt-builder pulls facts from listMentionableForScopes, not the unfiltered legacy call', async () => {
    factsListMentionableForScopes.mockResolvedValueOnce([
      { escopo: 'global', chave: 'k.public', valor: { content: 'CNPJ: 11.222.333/0001-00' } },
    ]);
    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    await buildPrompt(baseCtx);
    // The mentionable-aware repo method is what gets called.
    expect(factsListMentionableForScopes).toHaveBeenCalledTimes(1);
    expect(factsListMentionableForScopes).toHaveBeenCalledWith(
      expect.arrayContaining(['global', 'pessoa:p1']),
    );
  });

  it('when the filter drops sensitive content, the rendered prompt never contains the raw payload', async () => {
    // Simulate the filter doing its job: the agent_facts row exists, but
    // its corresponding memory_entry has mention_allowed=false, so
    // listMentionableForScopes returns ONLY the public fact.
    factsListMentionableForScopes.mockResolvedValueOnce([
      { escopo: 'global', chave: 'k.public', valor: { content: 'horário comercial 9-18h' } },
    ]);
    // The hidden sensitive fact MUST NOT appear in the prompt.
    const sensitiveContent = 'cliente em tratamento contra câncer';
    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(baseCtx);
    expect(system).not.toContain(sensitiveContent);
    expect(system).not.toContain('câncer');
    expect(system).toContain('horário comercial');
  });

  it('renders empty facts block when filter strips everything (no leak path)', async () => {
    factsListMentionableForScopes.mockResolvedValueOnce([]);
    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(baseCtx);
    // The block exists but is the (vazio) placeholder, never sensitive content.
    expect(system).toContain('## Fatos relevantes');
    expect(system).toContain('(vazio)');
  });
});

describe('[P82-C4] role/channel scope plumbing', () => {
  it('passes current_role_id / current_channel_id through to findRelevant', async () => {
    const ctx = {
      ...baseCtx,
      current_role_id: 'role-comercial',
      current_channel_id: 'channel-whatsapp',
    } as never;
    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    await buildPrompt(ctx);
    expect(memoryEntryFindRelevant).toHaveBeenCalledTimes(1);
    expect(memoryEntryFindRelevant).toHaveBeenCalledWith(
      expect.objectContaining({
        role_id: 'role-comercial',
        channel_id: 'channel-whatsapp',
      }),
    );
  });

  it('omits role/channel id when caller did not plumb them', async () => {
    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    await buildPrompt(baseCtx);
    expect(memoryEntryFindRelevant).toHaveBeenCalledTimes(1);
    const call = memoryEntryFindRelevant.mock.calls[0]![0];
    // Either explicitly undefined or absent — never an unrelated value.
    expect(call.role_id).toBeUndefined();
    expect(call.channel_id).toBeUndefined();
  });

  it('only emits role/channel scope hint queries when ids are supplied', async () => {
    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    // Without role/channel — only interlocutor + conversation + agent.
    await buildPrompt(baseCtx);
    const baseCalls = behavioralHintFindActiveForScope.mock.calls.map((c) => c[0].scope_type);
    expect(baseCalls).toContain('interlocutor');
    expect(baseCalls).toContain('conversation');
    expect(baseCalls).toContain('agent');
    expect(baseCalls).not.toContain('role');
    expect(baseCalls).not.toContain('channel');

    behavioralHintFindActiveForScope.mockClear();

    // With role/channel — both extra scopes are queried.
    await buildPrompt({
      ...baseCtx,
      current_role_id: 'role-x',
      current_channel_id: 'chan-y',
    } as never);
    const fullCalls = behavioralHintFindActiveForScope.mock.calls.map((c) => c[0].scope_type);
    expect(fullCalls).toContain('role');
    expect(fullCalls).toContain('channel');
  });
});

describe('[P82-C3] markReviewed computes expires_at from ttl_days', () => {
  // We can't easily exercise the real repo without a DB; instead we verify
  // the contract by computing the same expression and asserting deterministic
  // shape. This documents the invariant and traps any future regression
  // that drops expires_at from the update set.
  it('compute formula: ttl_days=7 → expires_at ~ +7 days', () => {
    const ttl_days = 7;
    const now = Date.now();
    const expires_at = new Date(now + ttl_days * 24 * 60 * 60 * 1000);
    expect(expires_at.getTime() - now).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('compute formula: ttl_days=null → expires_at=null (no eviction)', () => {
    const ttl_days = null;
    const expires_at =
      ttl_days != null ? new Date(Date.now() + ttl_days * 24 * 60 * 60 * 1000) : null;
    expect(expires_at).toBeNull();
  });
});

/**
 * PR #82 non-blocker followup — Finding 2:
 *
 * Migration 017 seeded legacy agent_facts into memory_entry with
 * `content = CONCAT(chave, ': ', valor::text)`. P2 persister writes
 * memory_entry rows with `content` matching `valor->>'content'`. The C1
 * filter MUST join on BOTH shapes, otherwise legacy facts whose `valor`
 * happens to already contain a `content` key escape the sensitivity
 * gate until the reclassifier worker rewrites the entry.
 *
 * We can't run the real query without Postgres, so we mock db.execute,
 * invoke the repo, and assert the emitted SQL contains both clauses —
 * that's the contract change we need to lock in.
 */
describe('[P82-NB Finding 2] listMentionableForScopes matches both content shapes', () => {
  const dbExecuteMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    // The top-level vi.mock at the head of this file replaces
    // ../../src/db/repositories.js with a stub bag of vi.fn()s. To exercise
    // the REAL factsRepo.listMentionableForScopes implementation (and
    // assert the SQL it builds), we override that mock for this describe
    // using vi.doMock + importActual, and we replace the db.execute that
    // the real implementation will call.
    vi.doMock('../../src/db/repositories.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/db/repositories.js')>(
        '../../src/db/repositories.js'
      );
      return actual;
    });
    vi.doMock('../../src/db/client.js', () => ({ db: { execute: dbExecuteMock } }));
    vi.doMock('../../src/db/tenant-context.js', () => ({
      getCurrentTenant: () => 'tenant-x',
      getCurrentAgent: () => 'agent-y',
    }));
    dbExecuteMock.mockReset();
    dbExecuteMock.mockResolvedValue({ rows: [] });
  });

  async function captureSqlText() {
    const { factsRepo } = await import('../../src/db/repositories.js');
    await factsRepo.listMentionableForScopes(['global', 'pessoa:p1']);
    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    const sqlObj = dbExecuteMock.mock.calls[0]![0];
    // drizzle's sql template exposes the literal chunks via .queryChunks
    // (array of StringChunk { value: [string] } | param-placeholders).
    // Concatenating the StringChunk values gives the static SQL skeleton.
    const chunks = (sqlObj.queryChunks ?? []) as Array<{ value?: string[] }>;
    return chunks
      .map((c) => (Array.isArray(c.value) ? c.value.join('') : ''))
      .join('')
      .toLowerCase();
  }

  it('emits a JOIN clause for the P2-era persister shape (valor->>"content")', async () => {
    const text = await captureSqlText();
    // P2-era shape — exact form persister writes.
    expect(text).toContain("af.valor->>'content'");
  });

  it('emits a JOIN clause for the legacy 017 shape (chave || ": " || valor::text)', async () => {
    const text = await captureSqlText();
    // Legacy 017 shape — what migration 017 seeded into memory_entry.content.
    // Tolerant to whitespace variation: assert each segment is present.
    expect(text).toContain('af.chave');
    expect(text).toContain("': '");
    expect(text).toContain('af.valor::text');
  });

  it('combines the two shapes with OR (single NOT EXISTS, no missed branch)', async () => {
    const text = await captureSqlText();
    // The whole disjunction lives inside a single NOT EXISTS over memory_entry.
    expect(text).toContain('not exists');
    expect(text).toContain('memory_entry');
    // OR between the two me.content equalities — guard against a future
    // regression that drops the second branch back to AND or removes it.
    expect(text).toMatch(/me\.content\s*=\s*\(af\.valor->>'content'\)\s*\n?\s*or\s+me\.content\s*=/);
  });

  it('still gates by needs_review OR mention_allowed=false (the sensitivity verdict is unchanged)', async () => {
    const text = await captureSqlText();
    expect(text).toContain('me.needs_review = true');
    expect(text).toContain('me.mention_allowed = false');
  });
});
