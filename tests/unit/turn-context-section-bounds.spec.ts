import { describe, it, expect, vi } from 'vitest';
import type { Mensagem, Pessoa, Conversa } from '../../src/db/schema.js';

/**
 * Issue #511 round 2 — every rendered section is actually bounded.
 *
 * The source-text guard in `turn-context-budget.spec.ts` only proves a section
 * name reaches `applyBudget` SOMEWHERE. It passed while the `capabilities`
 * budget measured `skill_name` and let three arbitrarily large
 * `capability_description` values through — the section was wired, but only
 * partially, and a grep cannot see that.
 *
 * This spec is the real guard: it feeds a 50 KB string into EVERY
 * tenant-controlled text field the prompt renders and asserts each section of
 * the resulting system prompt stays near its declared `max_bytes`. A field that
 * escapes its budget blows the bound by orders of magnitude, so the next big
 * field added to a section fails here rather than in production.
 */

const HUGE = 'x'.repeat(50_000);
/**
 * Headroom for the parts the budget does not measure: the heading, the line
 * prefixes (`  - `), and the injection-safety wrappers (`<fact>`, `<gap>`, …).
 * Generous on purpose — the point is to catch an UNBOUNDED field (50 KB), not
 * to pin exact byte counts, which would make this brittle.
 */
const WRAPPER_SLACK = 2_000;

function hugeRows<T>(n: number, make: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

vi.mock('../../src/db/repositories.js', () => ({
  operationalProfileVersionsRepo: { getActive: vi.fn(async () => null) },
  selfStateRepo: {
    getActive: vi.fn(async () => ({
      system_prompt: 'Você é a Maia.',
      versao: 1,
      resumo_aprendizados: '(vazio)',
    })),
  },
  mensagensRepo: {
    recentInConversation: vi.fn(async () =>
      hugeRows(10, (i) => ({
        id: `m-${i}`,
        conversa_id: 'conv-1',
        direcao: i % 2 === 0 ? 'in' : 'out',
        tipo: 'texto',
        conteudo: HUGE,
        metadata: {},
        ferramentas_chamadas: [],
        created_at: new Date('2026-05-11T14:00:00Z'),
      })),
    ),
  },
  entidadesRepo: {
    byIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, nome: HUGE }))),
  },
  entityStatesRepo: {
    byIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ entidade_id: id, saldo_consolidado: HUGE, proximo_vencimento: null })),
    ),
  },
  factsRepo: {
    listMentionableForScopes: vi.fn(async () =>
      hugeRows(50, (i) => ({ escopo: 'global', chave: `k-${i}`, valor: HUGE })),
    ),
  },
  rulesRepo: {
    listActive: vi.fn(async () =>
      hugeRows(50, (i) => ({
        id: `rule-${i}-aaaaaaaa`,
        tipo: 'classificacao',
        confianca: '0.9',
        contexto: HUGE,
        acao: HUGE,
      })),
    ),
  },
  memoryEntryRepo: {
    findRelevant: vi.fn(async () =>
      hugeRows(50, () => ({ content: HUGE, proactive_use: true, mention_allowed: true })),
    ),
  },
  behavioralHintRepo: {
    findActiveForScopes: vi.fn(async () => hugeRows(50, () => ({ hint_text: HUGE }))),
  },
  capabilitiesSkillRepo: {
    listAll: vi.fn(async () =>
      hugeRows(50, (i) => ({ skill_name: `${HUGE}-${i}`, confidence: '0.9' })),
    ),
  },
  capabilityGapsRepo: {
    // The field that escaped the budget in round 1.
    listByLevel: vi.fn(async () =>
      hugeRows(50, () => ({ capability_description: HUGE, current_level: 'mentionable' })),
    ),
    listByLevels: vi.fn(async () =>
      hugeRows(50, () => ({ capability_description: HUGE, current_level: 'mentionable' })),
    ),
  },
  procedureExecutionsRepo: { findActiveForConversa: vi.fn(async () => null) },
  procedureDefinitionsRepo: { findById: vi.fn(async () => null) },
}));

vi.mock('../../src/config/env.js', () => ({
  config: { TZ: 'America/Sao_Paulo', LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { buildPrompt, type PromptContext } from '../../src/agent/prompt-builder.js';
import { SECTION_BUDGETS } from '../../src/agent/turn-context/types.js';
import { utf8Bytes } from '../../src/agent/turn-context/budget.js';

/** Text between `## <heading>` and the next `## ` (or end of prompt). */
function sectionBody(system: string, heading: string): string {
  const start = system.indexOf(`## ${heading}`);
  if (start === -1) return '';
  const after = start + `## ${heading}`.length;
  const next = system.indexOf('\n## ', after);
  return next === -1 ? system.slice(after) : system.slice(after, next);
}

function mkCtx(entityCount: number): PromptContext {
  const entidades = Array.from({ length: entityCount }, (_, i) => `ent-${i}`);
  return {
    pessoa: {
      id: 'pessoa-1',
      nome: 'Owner',
      apelido: null,
      telefone_whatsapp: '+5511999999999',
      tipo: 'dono',
      status: 'ativa',
      metadata: {},
      created_at: new Date('2026-01-01T00:00:00Z'),
    } as Pessoa,
    conversa: {
      id: 'conv-1',
      pessoa_id: 'pessoa-1',
      escopo_entidades: [],
      status: 'ativa',
      metadata: {},
      created_at: new Date('2026-05-11T14:00:00Z'),
    } as Conversa,
    scope: { entidades, byEntity: new Map() },
    inbound: {
      id: 'msg-inbound',
      conversa_id: 'conv-1',
      direcao: 'in',
      tipo: 'texto',
      conteudo: 'oi',
      metadata: {},
      ferramentas_chamadas: [],
      created_at: new Date('2026-05-11T15:00:00Z'),
    } as Mensagem,
  };
}

describe('#511 every rendered section respects its byte budget', () => {
  it.each([
    ['Fatos relevantes', 'facts'],
    ['Regras aprendidas relevantes', 'rules'],
    ['Memória relevante', 'memories'],
    ['Instruções comportamentais ativas', 'hints'],
    ['Autoconhecimento', 'capabilities'],
    ['Estado atual', 'entity_states'],
  ] as const)('%s stays within its ceiling', async (heading, section) => {
    const { system } = await buildPrompt(mkCtx(50));
    const body = sectionBody(system, heading);
    const budget = SECTION_BUDGETS[section as keyof typeof SECTION_BUDGETS];

    expect(body.length).toBeGreaterThan(0);
    expect(utf8Bytes(body)).toBeLessThanOrEqual(budget.max_bytes + WRAPPER_SLACK);
  });

  it('the gap-transparency section stays within its ceiling', async () => {
    const { system } = await buildPrompt(mkCtx(1));
    const body = sectionBody(system, 'Limitações conhecidas');
    expect(utf8Bytes(body)).toBeLessThanOrEqual(SECTION_BUDGETS.gaps.max_bytes + WRAPPER_SLACK);
  });

  /**
   * The specific round-2 regression: `capability_description` is long and
   * free-form, and used to render outside the `capabilities` ceiling entirely.
   */
  it('capability descriptions are inside the capabilities ceiling, not beside it', async () => {
    const { system } = await buildPrompt(mkCtx(1));
    const body = sectionBody(system, 'Autoconhecimento');
    // Both clauses live under ONE shared allowance, so the whole section —
    // skills AND gap descriptions — is bounded together.
    expect(utf8Bytes(body)).toBeLessThanOrEqual(
      SECTION_BUDGETS.capabilities.max_bytes + WRAPPER_SLACK,
    );
    // Sanity: without a budget on descriptions this would be ~150 KB.
    expect(utf8Bytes(body)).toBeLessThan(50_000);
  });

  it('history is bounded too (it renders into messages, not the system prompt)', async () => {
    const { messages } = await buildPrompt(mkCtx(1));
    const historyBytes = messages.reduce(
      (sum, m) => sum + utf8Bytes(typeof m.content === 'string' ? m.content : ''),
      0,
    );
    expect(historyBytes).toBeLessThanOrEqual(
      SECTION_BUDGETS.history.max_bytes + WRAPPER_SLACK,
    );
  });

  it('the whole system prompt stays within a sane total', async () => {
    // The sum of the parts, plus the fixed editorial blocks. One tenant must
    // not be able to produce an unbounded prompt through ANY field.
    const { system } = await buildPrompt(mkCtx(100));
    const declared = Object.values(SECTION_BUDGETS).reduce((s, b) => s + b.max_bytes, 0);
    expect(utf8Bytes(system)).toBeLessThanOrEqual(declared + 10_000);
  });
});
