import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Conversa, Mensagem, Permissao, Pessoa } from '../../src/db/schema.js';

/**
 * Issue #525 — "renderer puro", proved rather than asserted.
 *
 * The claim is that `renderTurnPrompt` is a pure function of
 * `(PromptContext, TurnContextSnapshot)`: no lazy read hides inside a section
 * helper, so a prompt can be rendered from state alone. Three independent
 * pieces of evidence, because any one of them alone is weak:
 *
 *  1. **Structural.** `renderTurnPrompt` is SYNCHRONOUS. A function that cannot
 *     `await` cannot consume a repository promise, so a reintroduced read would
 *     have to change the signature — a compile error, not a silent regression.
 *     (`tsc` enforces this; the test below cannot.)
 *  2. **Behavioural.** Every repository method in this file THROWS. If any
 *     render path touched one, these tests would fail with "…must not be called
 *     during rendering" rather than producing a prompt.
 *  3. **Functional.** Same inputs → same bytes, twice, including for the
 *     budget-truncated sections. Rendering carries no hidden state.
 *
 * The round-trip COUNT half of the same claim lives in
 * `turn-context-round-trips.spec.ts` ("the renderer is worth zero round-trips").
 */

const h = vi.hoisted(() => ({
  boom:
    (name: string) =>
    (): never => {
      throw new Error(`${name} must not be called during rendering`);
    },
}));

vi.mock('../../src/db/repositories.js', () => ({
  operationalProfileVersionsRepo: { getActive: h.boom('operationalProfileVersionsRepo.getActive') },
  selfStateRepo: { getActive: h.boom('selfStateRepo.getActive') },
  mensagensRepo: { recentInConversation: h.boom('mensagensRepo.recentInConversation') },
  entidadesRepo: {
    byIds: h.boom('entidadesRepo.byIds'),
    byIdsWithState: h.boom('entidadesRepo.byIdsWithState'),
  },
  entityStatesRepo: { byIds: h.boom('entityStatesRepo.byIds') },
  factsRepo: { listMentionableForScopes: h.boom('factsRepo.listMentionableForScopes') },
  rulesRepo: { listActive: h.boom('rulesRepo.listActive') },
  memoryEntryRepo: { findRelevant: h.boom('memoryEntryRepo.findRelevant') },
  behavioralHintRepo: { findActiveForScopes: h.boom('behavioralHintRepo.findActiveForScopes') },
  capabilitiesSkillRepo: { listAll: h.boom('capabilitiesSkillRepo.listAll') },
  capabilityGapsRepo: {
    listByLevel: h.boom('capabilityGapsRepo.listByLevel'),
    listParaOTurno: h.boom('capabilityGapsRepo.listParaOTurno'),
  },
  procedureExecutionsRepo: { findActiveForConversa: h.boom('procedureExecutionsRepo.findActiveForConversa') },
  procedureDefinitionsRepo: { findById: h.boom('procedureDefinitionsRepo.findById') },
  permissoesRepo: { forPessoa: h.boom('permissoesRepo.forPessoa') },
  profilesRepo: { byIds: h.boom('profilesRepo.byIds') },
  pessoasRepo: { list: h.boom('pessoasRepo.list') },
}));

vi.mock('../../src/config/env.js', () => ({ config: { TZ: 'America/Sao_Paulo' } }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { renderTurnPrompt, type PromptContext } from '../../src/agent/prompt-builder.js';
import {
  emptyTurnContextSnapshot,
  type TurnContextSnapshot,
} from '../../src/agent/turn-context/loader.js';
import { degraded, loaded } from '../../src/agent/turn-context/types.js';
import type { ResolvedPermission } from '../../src/governance/permissions.js';

function mkCtx(): PromptContext {
  const byEntity = new Map<string, ResolvedPermission>();
  byEntity.set('ent-1', {
    permissao: { id: 'perm-1', entidade_id: 'ent-1' } as unknown as Permissao,
    profile: { id: 'profile-1', nome: 'p', acoes: ['*'], limite_default: '1000' } as never,
    effective_limits: { valor_max: 1000 },
  });
  return {
    pessoa: { id: 'pessoa-1', nome: 'Owner', apelido: null, tipo: 'dono', metadata: {} } as Pessoa,
    conversa: { id: 'conv-1', metadata: {} } as Conversa,
    scope: { entidades: ['ent-1'], byEntity },
    inbound: {
      id: 'msg-1',
      direcao: 'in',
      tipo: 'texto',
      conteudo: 'quanto tenho?',
      created_at: new Date('2026-08-04T12:00:00Z'),
    } as Mensagem,
  };
}

/** A snapshot with something in every section, built by hand — no I/O. */
function richSnapshot(): TurnContextSnapshot {
  return emptyTurnContextSnapshot({
    identity: loaded({
      systemPromptBody: 'Você é a Maia.',
      selfVersionLabel: 'op_profile_v4',
      resumoAprendizadosBody: '(perfil v2 ativo)',
      source: 'operational_profile_v2' as const,
    }),
    entities: loaded([{ id: 'ent-1', nome: 'Padaria' }] as never),
    entity_states: loaded([
      { entidade_id: 'ent-1', saldo_consolidado: '900.00', proximo_vencimento: '2026-08-09' },
    ] as never),
    facts: loaded([{ escopo: 'global', chave: 'moeda', valor: 'BRL' }] as never),
    rules: loaded([
      { id: 'rule-000000001', tipo: 'classificacao', confianca: '0.9', contexto: 'a', acao: 'b' },
    ] as never),
    memories: loaded([
      { content: 'prefere resumo curto', proactive_use: true, mention_allowed: true },
    ] as never),
    hints: loaded([{ hint_text: 'seja direta' }] as never),
    capabilities: loaded([{ skill_name: 'classificar', confidence: '0.9' }] as never),
    gaps: loaded([
      { capability_description: 'emitir NF', current_level: 'mentionable' },
      { capability_description: 'conciliar OFX', current_level: 'proposed' },
    ] as never),
    role: loaded({
      id: 'role-1',
      display_name: 'Financeiro',
      is_default: false,
      description: 'modo financeiro',
      prompt_addendum: 'seja formal',
    } as never),
    procedure: loaded({
      execution: {
        id: 'exec-1',
        definition_id: 'def-1',
        current_step_id: 'step-a',
        execution_state: { v: 1 },
      },
      definition: {
        nome: 'Fechamento',
        version_number: 2,
        steps: [{ id: 'step-a', intencao: 'coletar', como: 'perguntar' }],
        success_criteria: [],
      },
    } as never),
  });
}

describe('#525 renderer purity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('renders every section with all repositories rigged to throw', () => {
    const { system, messages } = renderTurnPrompt(mkCtx(), richSnapshot());

    // One assertion per section, so a section that quietly stops rendering is
    // named rather than hidden inside a byte comparison.
    expect(system).toContain('## Escopo desta conversa');
    expect(system).toContain('Padaria');
    expect(system).toContain('saldo=900.00');
    expect(system).toContain('## Fatos relevantes');
    expect(system).toContain('## Regras aprendidas relevantes');
    expect(system).toContain('## Memória relevante');
    expect(system).toContain('## Instruções comportamentais ativas');
    expect(system).toContain('## Autoconhecimento');
    expect(system).toContain('## Modo operacional');
    expect(system).toContain('## Procedimento em execução');
    expect(system).toContain('## Limitações conhecidas');
    expect(messages.at(-1)?.content).toContain('quanto tenho?');
  });

  it('is deterministic: the same snapshot renders the same bytes', () => {
    const ctx = mkCtx();
    const snapshot = richSnapshot();
    expect(renderTurnPrompt(ctx, snapshot).system).toBe(renderTurnPrompt(ctx, snapshot).system);
  });

  it('does not mutate the snapshot it is given', () => {
    const snapshot = richSnapshot();
    const before = JSON.stringify(snapshot);
    renderTurnPrompt(mkCtx(), snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  /**
   * A degraded section renders as ABSENT, never as a partial or a placeholder.
   * That is the contract the `LoadedSection` union exists to carry: the
   * renderer uses the safe fallback the loader chose, and the fact that the
   * section failed is reported through metrics and the structured log — not by
   * inventing prompt text the model would treat as truth.
   */
  it('renders a degraded section as absent, using the loader fallback', () => {
    const snapshot = emptyTurnContextSnapshot({
      hints: degraded([], 'behavioral_hint read timed out'),
      memories: degraded([], 'memory read timed out'),
    });
    const { system } = renderTurnPrompt(mkCtx(), snapshot);
    expect(system).not.toContain('## Instruções comportamentais ativas');
    expect(system).not.toContain('## Memória relevante');
    // The rest of the prompt is intact — one section failing is not a turn
    // failing.
    expect(system).toContain('## Escopo desta conversa');
  });

  /**
   * The self-awareness clause and the "known limitations" block are now fed by
   * ONE gap read (issue #525). This pins the split the renderer does in their
   * place: only `mentionable` gaps reach "Ainda não tem", while `proposed` ones
   * still reach the limitations block with their suffix.
   */
  it('splits the single gap read into the two blocks it used to cost two reads for', () => {
    const snapshot = emptyTurnContextSnapshot({
      gaps: loaded([
        { capability_description: 'emitir NF', current_level: 'mentionable' },
        { capability_description: 'conciliar OFX', current_level: 'proposed' },
      ] as never),
    });
    const { system } = renderTurnPrompt(mkCtx(), snapshot);

    expect(system).toContain('Ainda não tem: <gap>emitir NF</gap>.');
    expect(system).not.toContain('Ainda não tem: <gap>conciliar OFX</gap>');
    expect(system).toContain('Se o usuário perguntar sobre emitir NF');
    expect(system).toContain(
      'Se o usuário perguntar sobre conciliar OFX, você pode explicar honestamente que isso é uma limitação atual (proposta de melhoria já enviada).',
    );
  });
});
