import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mensagem, Pessoa, Conversa } from '../../src/db/schema.js';

/**
 * Issue #73 — prompt-builder evidence-hierarchy, scope-change sentinel,
 * backend-events block, and contradiction overlay.
 *
 * The bug fix is structural: instead of repeating fresh scope at the end,
 * we (a) add a fixed hierarchy block at the top so the LLM knows what
 * authority wins, (b) emit a delta-only sentinel when scope changed
 * between turns, (c) reidrate persisted tool summaries from prior
 * assistant turns as a SYSTEM-level block (not as text inside an
 * assistant turn), and (d) emit an overlay when a prior assistant text
 * contradicts a persisted tool success (regex + domain keyword gate).
 *
 * The conversation `messages` array stays untouched (raw history).
 */

const h = vi.hoisted(() => ({
  selfStateGetActive: vi.fn(),
  recentInConversation: vi.fn(),
  entidadesByIds: vi.fn(),
  factsListForScopes: vi.fn(),
  rulesListActive: vi.fn(),
  entityStatesById: vi.fn(),
}));

vi.mock('../../src/db/repositories.js', () => ({
  selfStateRepo: { getActive: h.selfStateGetActive },
  mensagensRepo: { recentInConversation: h.recentInConversation },
  entidadesRepo: { byIds: h.entidadesByIds },
  factsRepo: { listForScopes: h.factsListForScopes },
  rulesRepo: { listActive: h.rulesListActive },
  entityStatesRepo: { byId: h.entityStatesById },
}));

vi.mock('../../src/config/env.js', () => ({
  config: { TZ: 'America/Sao_Paulo' },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { buildPrompt, type PromptContext } from '../../src/agent/prompt-builder.js';
import { hashScope } from '../../src/agent/scope-hash.js';
import type { ResolvedPermission } from '../../src/governance/permissions.js';

function mkPessoa(over: Partial<Pessoa> = {}): Pessoa {
  return {
    id: 'pessoa-1',
    nome: 'Owner',
    apelido: null,
    telefone_whatsapp: '+5511999999999',
    tipo: 'dono',
    status: 'ativa',
    profile_id: null,
    metadata: {},
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  } as Pessoa;
}

function mkConversa(over: Partial<Conversa> = {}): Conversa {
  return {
    id: 'conv-1',
    pessoa_id: 'pessoa-1',
    escopo_entidades: [],
    status: 'ativa',
    contexto_resumido: null,
    ultima_atividade_em: new Date('2026-05-11T15:00:00Z'),
    metadata: {},
    created_at: new Date('2026-05-11T14:00:00Z'),
    ...over,
  } as Conversa;
}

function mkInbound(over: Partial<Mensagem> = {}): Mensagem {
  return {
    id: 'msg-inbound',
    conversa_id: 'conv-1',
    direcao: 'in',
    tipo: 'texto',
    conteudo: 'oi',
    midia_url: null,
    metadata: {},
    processada_em: null,
    ferramentas_chamadas: [],
    tokens_usados: null,
    created_at: new Date('2026-05-11T15:00:00Z'),
    ...over,
  } as Mensagem;
}

function mkAssistantMsg(over: Partial<Mensagem> = {}): Mensagem {
  return {
    id: 'msg-asst-' + Math.random().toString(36).slice(2),
    conversa_id: 'conv-1',
    direcao: 'out',
    tipo: 'texto',
    conteudo: 'resposta',
    midia_url: null,
    metadata: {},
    processada_em: new Date('2026-05-11T14:59:00Z'),
    ferramentas_chamadas: [],
    tokens_usados: 100,
    created_at: new Date('2026-05-11T14:59:00Z'),
    ...over,
  } as Mensagem;
}

function mkUserMsg(over: Partial<Mensagem> = {}): Mensagem {
  return {
    id: 'msg-usr-' + Math.random().toString(36).slice(2),
    conversa_id: 'conv-1',
    direcao: 'in',
    tipo: 'texto',
    conteudo: 'olá',
    midia_url: null,
    metadata: {},
    processada_em: new Date('2026-05-11T14:58:00Z'),
    ferramentas_chamadas: [],
    tokens_usados: null,
    created_at: new Date('2026-05-11T14:58:00Z'),
    ...over,
  } as Mensagem;
}

function mkPerm(opts: { entidade_id: string; profile_id?: string }): ResolvedPermission {
  return {
    permissao: {
      id: 'perm-' + opts.entidade_id,
      pessoa_id: 'pessoa-1',
      entidade_id: opts.entidade_id,
      papel: 'dono',
      profile_id: opts.profile_id ?? 'owner',
      acoes_permitidas: [],
      limites: {},
      status: 'ativa',
      created_at: new Date('2026-01-01T00:00:00Z'),
    },
    profile: {
      id: opts.profile_id ?? 'owner',
      nome: 'owner',
      acoes: ['*'],
      limite_default: '0',
      descricao: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
    },
    effective_limits: { valor_max: 1000 },
  } as ResolvedPermission;
}

function mkScope(perms: ResolvedPermission[] = []) {
  const byEntity = new Map<string, ResolvedPermission>();
  const entidades: string[] = [];
  for (const rp of perms) {
    byEntity.set(rp.permissao.entidade_id!, rp);
    entidades.push(rp.permissao.entidade_id!);
  }
  return { entidades, byEntity };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.selfStateGetActive.mockResolvedValue(null);
  h.recentInConversation.mockResolvedValue([]);
  h.entidadesByIds.mockResolvedValue([]);
  h.factsListForScopes.mockResolvedValue([]);
  h.rulesListActive.mockResolvedValue([]);
  h.entityStatesById.mockResolvedValue(null);
});

async function build(over: Partial<PromptContext> = {}): Promise<{ system: string; messages: { role: string; content: unknown }[] }> {
  const ctx: PromptContext = {
    pessoa: over.pessoa ?? mkPessoa(),
    conversa: over.conversa ?? mkConversa(),
    scope: over.scope ?? mkScope(),
    inbound: over.inbound ?? mkInbound(),
  };
  return buildPrompt(ctx);
}

describe('prompt-builder — evidence hierarchy', () => {
  it('always includes the evidence-hierarchy block in the system prompt', async () => {
    const { system } = await build();
    expect(system).toContain('Hierarquia de evidências');
    expect(system).toMatch(/autoridade m[áa]xima/i);
  });

  it('ranks tool results above scope, scope above facts, facts above assistant history', async () => {
    const { system } = await build();
    const block = system.slice(
      system.indexOf('Hierarquia de evidências'),
      system.indexOf('Hierarquia de evidências') + 1500,
    );
    const idxTools = block.search(/tools? .* turno atual/i);
    const idxPrior = block.search(/turnos anteriores/i);
    const idxScope = block.search(/Escopo desta conversa/i);
    const idxFacts = block.search(/Fatos.*regras/i);
    const idxAsst = block.search(/mensagens? anteriores|seu pr[óo]prio/i);
    expect(idxTools).toBeGreaterThanOrEqual(0);
    expect(idxPrior).toBeGreaterThan(idxTools);
    expect(idxScope).toBeGreaterThan(idxPrior);
    expect(idxFacts).toBeGreaterThan(idxScope);
    expect(idxAsst).toBeGreaterThan(idxFacts);
  });

  it('includes the "never contradict tool success" imperative rule', async () => {
    const { system } = await build();
    expect(system).toMatch(/nunca\s+(contradiga|negue|invente)/i);
    expect(system).toMatch(/(sucesso|tool\s+result)/i);
  });
});

describe('prompt-builder — scope change sentinel', () => {
  it('omits the sentinel when no prior assistant turn exists (first turn)', async () => {
    h.recentInConversation.mockResolvedValue([mkInbound({ id: 'msg-inbound' })]);
    const { system } = await build();
    expect(system).not.toMatch(/Mudan[çc]a de escopo desde sua [úu]ltima resposta/i);
  });

  it('omits the sentinel when scope hash matches the persisted last_scope_hash', async () => {
    const scope = mkScope([mkPerm({ entidade_id: 'ent-pf' })]);
    const persistedHash = hashScope(scope);
    const conversa = mkConversa({
      metadata: { last_scope_hash: persistedHash, last_scope_hash_set_at: '2026-05-11T14:59:00Z' },
    });
    h.recentInConversation.mockResolvedValue([mkAssistantMsg(), mkUserMsg(), mkInbound()]);
    const { system } = await build({ scope, conversa });
    expect(system).not.toMatch(/Mudan[çc]a de escopo/i);
  });

  it('emits the sentinel when scope hash differs AND a prior assistant turn exists', async () => {
    const scopeNow = mkScope([mkPerm({ entidade_id: 'ent-pf' })]);
    const conversa = mkConversa({
      metadata: { last_scope_hash: 'old-hash-1234', last_scope_hash_set_at: '2026-05-11T14:00:00Z' },
    });
    h.recentInConversation.mockResolvedValue([mkAssistantMsg(), mkUserMsg(), mkInbound()]);
    const { system } = await build({ scope: scopeNow, conversa });
    expect(system).toMatch(/Mudan[çc]a de escopo desde sua [úu]ltima resposta/i);
    expect(system).toMatch(/descarte conclus[õo]es anteriores/i);
  });

  it('never exposes the raw hash strings to the LLM', async () => {
    const scopeNow = mkScope([mkPerm({ entidade_id: 'ent-pf' })]);
    const currHash = hashScope(scopeNow);
    const conversa = mkConversa({
      metadata: {
        last_scope_hash: 'old-distinct-hash',
        last_scope_hash_set_at: '2026-05-11T14:00:00Z',
      },
    });
    h.recentInConversation.mockResolvedValue([mkAssistantMsg(), mkInbound()]);
    const { system } = await build({ scope: scopeNow, conversa });
    expect(system).not.toContain(currHash);
    expect(system).not.toContain('old-distinct-hash');
  });
});

describe('prompt-builder — backend events block', () => {
  it('includes a system-level "## Eventos confirmados pelo backend" block when prior assistant turns have tool summaries', async () => {
    const summary = {
      tool_call_id: 'tu_1',
      tool_name: 'schedule_reminder',
      status: 'success',
      side_effect: 'write',
      result_summary: 'lembrete agendado para 2026-05-25',
      occurred_at: '2026-05-11T14:59:00Z',
    };
    h.recentInConversation.mockResolvedValue([
      mkAssistantMsg({
        conteudo: 'Pronto, agendei.',
        ferramentas_chamadas: [summary],
      }),
      mkUserMsg(),
      mkInbound(),
    ]);
    const { system } = await build();
    expect(system).toContain('Eventos confirmados pelo backend');
    expect(system).toContain('schedule_reminder');
    expect(system).toContain('lembrete agendado para 2026-05-25');
  });

  it('does NOT embed tool summary text inside the assistant message in the messages array', async () => {
    const summary = {
      tool_call_id: 'tu_1',
      tool_name: 'schedule_reminder',
      status: 'success',
      side_effect: 'write',
      result_summary: 'lembrete agendado',
      occurred_at: '2026-05-11T14:59:00Z',
    };
    h.recentInConversation.mockResolvedValue([
      mkAssistantMsg({
        conteudo: 'Pronto, agendei.',
        ferramentas_chamadas: [summary],
      }),
      mkUserMsg(),
      mkInbound(),
    ]);
    const { messages } = await build();
    const assistantMsg = messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(typeof assistantMsg!.content).toBe('string');
    expect(assistantMsg!.content as string).toBe('Pronto, agendei.');
    expect(assistantMsg!.content as string).not.toContain('Eventos confirmados');
    expect(assistantMsg!.content as string).not.toContain('schedule_reminder');
  });

  it('orders the events block ABOVE the regular conversation history in the system prompt', async () => {
    const summary = {
      tool_call_id: 'tu_1',
      tool_name: 'schedule_reminder',
      status: 'success',
      side_effect: 'write',
      result_summary: 'lembrete agendado',
      occurred_at: '2026-05-11T14:59:00Z',
    };
    h.recentInConversation.mockResolvedValue([
      mkAssistantMsg({ ferramentas_chamadas: [summary] }),
      mkInbound(),
    ]);
    const { system } = await build();
    const idxEvents = system.indexOf('Eventos confirmados pelo backend');
    const idxHistory = system.search(/regras aprendidas|fatos relevantes/i);
    expect(idxEvents).toBeGreaterThan(-1);
    if (idxHistory > -1) {
      expect(idxEvents).toBeLessThan(idxHistory);
    }
  });

  it('filters out events older than 24 hours', async () => {
    const oldSummary = {
      tool_call_id: 'tu_old',
      tool_name: 'schedule_reminder',
      status: 'success',
      side_effect: 'write',
      result_summary: 'lembrete antigo',
      occurred_at: '2026-05-09T14:00:00Z', // > 24h before inbound
    };
    h.recentInConversation.mockResolvedValue([
      mkAssistantMsg({
        ferramentas_chamadas: [oldSummary],
        created_at: new Date('2026-05-09T14:00:00Z'),
        processada_em: new Date('2026-05-09T14:00:00Z'),
      }),
      mkInbound({ created_at: new Date('2026-05-11T15:00:00Z') }),
    ]);
    const { system } = await build({ inbound: mkInbound({ created_at: new Date('2026-05-11T15:00:00Z') }) });
    expect(system).not.toContain('lembrete antigo');
  });

  it('prioritizes write/communication side-effect over read when limited to K=5', async () => {
    const reads = Array.from({ length: 6 }, (_, i) => ({
      tool_call_id: 'tu_r' + i,
      tool_name: 'query_balance',
      status: 'success' as const,
      side_effect: 'read' as const,
      result_summary: `consulta saldo ${i}`,
      occurred_at: '2026-05-11T14:55:00Z',
    }));
    const writes = Array.from({ length: 2 }, (_, i) => ({
      tool_call_id: 'tu_w' + i,
      tool_name: 'schedule_reminder',
      status: 'success' as const,
      side_effect: 'write' as const,
      result_summary: `lembrete write ${i}`,
      occurred_at: '2026-05-11T14:58:00Z',
    }));
    h.recentInConversation.mockResolvedValue([
      mkAssistantMsg({ ferramentas_chamadas: [...reads, ...writes] }),
      mkInbound(),
    ]);
    const { system } = await build();
    expect(system).toContain('lembrete write 0');
    expect(system).toContain('lembrete write 1');
  });

  it('omits the events block when no prior assistant turn has tool summaries', async () => {
    h.recentInConversation.mockResolvedValue([
      mkAssistantMsg({ ferramentas_chamadas: [] }),
      mkInbound(),
    ]);
    const { system } = await build();
    // The hierarchy mentions the concept; the actual block (## header with bullet items) must be absent.
    expect(system).not.toMatch(/## Eventos confirmados pelo backend\n-/);
  });

  it('does NOT include error-status summaries in the events block', async () => {
    const errSummary = {
      tool_call_id: 'tu_e',
      tool_name: 'register_transaction',
      status: 'error',
      side_effect: 'write',
      result_summary: 'register_transaction: erro',
      error_summary: 'register_transaction: erro (forbidden)',
      occurred_at: '2026-05-11T14:59:00Z',
    };
    h.recentInConversation.mockResolvedValue([
      mkAssistantMsg({ ferramentas_chamadas: [errSummary] }),
      mkInbound(),
    ]);
    const { system } = await build();
    expect(system).not.toContain('register_transaction: erro');
  });
});

describe('prompt-builder — contradiction overlay', () => {
  it('emits overlay when assistant text contains failure phrase AND a tool with matching domain succeeded', async () => {
    const summary = {
      tool_call_id: 'tu_1',
      tool_name: 'schedule_reminder',
      status: 'success',
      side_effect: 'write',
      result_summary: 'lembrete agendado',
      occurred_at: '2026-05-11T14:59:00Z',
    };
    h.recentInConversation.mockResolvedValue([
      mkAssistantMsg({
        conteudo: 'Não consegui agendar os lembretes — backend retornou erro.',
        ferramentas_chamadas: [summary],
      }),
      mkInbound(),
    ]);
    const { system } = await build();
    expect(system).toMatch(/Conflito detectado/i);
    expect(system).toMatch(/trate.*invalid|descarte|obsolet/i);
  });

  it('does NOT emit overlay when failure phrase has no domain keyword match', async () => {
    const summary = {
      tool_call_id: 'tu_1',
      tool_name: 'schedule_reminder',
      status: 'success',
      side_effect: 'write',
      result_summary: 'lembrete agendado',
      occurred_at: '2026-05-11T14:59:00Z',
    };
    h.recentInConversation.mockResolvedValue([
      mkAssistantMsg({
        conteudo: 'Não consegui consultar o saldo agora — instabilidade externa.',
        ferramentas_chamadas: [summary],
      }),
      mkInbound(),
    ]);
    const { system } = await build();
    expect(system).not.toMatch(/Conflito detectado/i);
  });

  it('does NOT emit overlay when assistant text has no failure phrase', async () => {
    const summary = {
      tool_call_id: 'tu_1',
      tool_name: 'schedule_reminder',
      status: 'success',
      side_effect: 'write',
      result_summary: 'lembrete agendado',
      occurred_at: '2026-05-11T14:59:00Z',
    };
    h.recentInConversation.mockResolvedValue([
      mkAssistantMsg({
        conteudo: 'Agendei os 6 lembretes para você.',
        ferramentas_chamadas: [summary],
      }),
      mkInbound(),
    ]);
    const { system } = await build();
    expect(system).not.toMatch(/Conflito detectado/i);
  });

  it('does NOT emit overlay when the tool failed (status error) — only success matters', async () => {
    const summary = {
      tool_call_id: 'tu_1',
      tool_name: 'schedule_reminder',
      status: 'error',
      side_effect: 'write',
      result_summary: 'schedule_reminder: erro',
      error_summary: 'schedule_reminder: erro (forbidden)',
      occurred_at: '2026-05-11T14:59:00Z',
    };
    h.recentInConversation.mockResolvedValue([
      mkAssistantMsg({
        conteudo: 'Não consegui agendar o lembrete — backend negou.',
        ferramentas_chamadas: [summary],
      }),
      mkInbound(),
    ]);
    const { system } = await build();
    expect(system).not.toMatch(/Conflito detectado/i);
  });
});

describe('prompt-builder — raw conversation history preserved', () => {
  it('leaves assistant message conteudo unchanged in the messages array (no rewrite/collapse)', async () => {
    const summary = {
      tool_call_id: 'tu_1',
      tool_name: 'schedule_reminder',
      status: 'success',
      side_effect: 'write',
      result_summary: 'lembrete agendado',
      occurred_at: '2026-05-11T14:59:00Z',
    };
    const original = 'Não consegui agendar — backend retornou erro';
    h.recentInConversation.mockResolvedValue([
      mkAssistantMsg({ conteudo: original, ferramentas_chamadas: [summary] }),
      mkInbound(),
    ]);
    const { messages } = await build();
    const asst = messages.find((m) => m.role === 'assistant');
    expect(asst!.content).toBe(original);
  });
});
