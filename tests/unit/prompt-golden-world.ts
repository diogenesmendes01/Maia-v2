/**
 * Issue #525 — the fixture "world" behind the prompt byte-identity proof.
 *
 * The refactor in this issue moves every DB read out of `prompt-builder.ts` and
 * behind a `TurnContextLoader`. The renderer is supposed to be the SAME code
 * fed from a different place, and "supposed to" is not evidence — so the same
 * fixture data is pushed through the old loading path and the new one and the
 * resulting system prompt is compared byte for byte
 * (`tests/fixtures/prompt-golden.json`).
 *
 * This module holds the data only. It has no vitest imports on purpose: it is
 * consumed from inside `vi.hoisted`/`vi.mock` factories, which run before the
 * spec body, so anything it touches must be import-safe and side-effect free.
 */

export type GoldenScenario = {
  name: string;
  /** `null` exercises the legacy `self_state` fallback. */
  profile: Record<string, unknown> | null;
  self: { system_prompt: string; versao: number; resumo_aprendizados: string } | null;
  /** NEWEST first — the shape `mensagensRepo.recentInConversation` returns. */
  history: Array<Record<string, unknown>>;
  entities: Array<{ id: string; nome: string }>;
  entityStates: Array<{
    entidade_id: string;
    saldo_consolidado: string | null;
    proximo_vencimento: string | null;
  }>;
  facts: Array<{ escopo: string; chave: string; valor: unknown }>;
  rules: Array<{
    id: string;
    tipo: string;
    confianca: string;
    contexto: string;
    acao: string;
  }>;
  memories: Array<{ content: string; proactive_use: boolean; mention_allowed: boolean }>;
  hints: Array<{ hint_text: string }>;
  skills: Array<{ skill_name: string; confidence: string }>;
  /** Combined mentionable+proposed set, in the order the DB returns it. */
  gaps: Array<{ capability_description: string; current_level: string }>;
  procedure: {
    execution: Record<string, unknown>;
    definition: Record<string, unknown>;
  } | null;
  ctx: {
    entidades: string[];
    activeRole?: Record<string, unknown> | null;
    current_role_id?: string | null;
    current_channel_id?: string | null;
    last_scope_hash?: string;
    inbound_conteudo?: string;
  };
  /** Every optional read fails — the availability-degradation path. */
  failOptional?: boolean;
};

const T0 = Date.parse('2026-05-11T15:00:00.000Z');

function msg(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'm-x',
    conversa_id: 'conv-1',
    direcao: 'in',
    tipo: 'texto',
    conteudo: '',
    ferramentas_chamadas: [],
    created_at: new Date(T0),
    ...over,
  };
}

const RICH_HISTORY: Array<Record<string, unknown>> = [
  // Newest first. The most recent assistant turn claims failure while the
  // backend recorded a successful write — the contradiction overlay path.
  msg({
    id: 'm-4',
    direcao: 'out',
    conteudo: 'Não consegui registrar a transação, deu erro no backend.',
    created_at: new Date(T0 - 60_000),
    ferramentas_chamadas: [
      {
        tool_name: 'register_transaction',
        status: 'success',
        side_effect: 'write',
        result_summary: 'Transação de R$ 120,00 registrada',
        occurred_at: new Date(T0 - 61_000).toISOString(),
        tool_call_id: 'tc-1',
        result_keys: { transacao_id: 'tx-1' },
      },
      {
        tool_name: 'query_balance',
        status: 'success',
        side_effect: 'read',
        result_summary: 'Saldo consolidado consultado',
        occurred_at: new Date(T0 - 62_000).toISOString(),
        tool_call_id: 'tc-2',
      },
    ],
  }),
  msg({ id: 'm-3', conteudo: 'registra 120 reais de mercado', created_at: new Date(T0 - 120_000) }),
  msg({
    id: 'm-2',
    direcao: 'out',
    tipo: 'evento',
    conteudo: '',
    created_at: new Date(T0 - 180_000),
    ferramentas_chamadas: [
      {
        tool_name: 'schedule_reminder',
        status: 'success',
        side_effect: 'write',
        result_summary: 'Lembrete criado para 12/05',
        occurred_at: new Date(T0 - 181_000).toISOString(),
        tool_call_id: 'tc-3',
        result_keys: { series_id: 's-1', occurrence_id: 'o-1' },
      },
    ],
  }),
  msg({ id: 'm-1', conteudo: 'bom dia', created_at: new Date(T0 - 240_000) }),
];

function longText(prefix: string, bytes: number): string {
  return prefix + 'x'.repeat(Math.max(0, bytes - prefix.length));
}

export const SCENARIOS: GoldenScenario[] = [
  {
    name: 'minimal-self-state-fallback',
    profile: null,
    self: { system_prompt: 'Você é a Maia.', versao: 3, resumo_aprendizados: '(vazio)' },
    history: [],
    entities: [],
    entityStates: [],
    facts: [],
    rules: [],
    memories: [],
    hints: [],
    skills: [],
    gaps: [],
    procedure: null,
    ctx: { entidades: ['ent-0'] },
  },
  {
    name: 'no-self-state-row-at-all',
    profile: null,
    self: null,
    history: [],
    entities: [{ id: 'ent-0', nome: 'Casa' }],
    entityStates: [],
    facts: [],
    rules: [],
    memories: [],
    hints: [],
    skills: [],
    gaps: [],
    procedure: null,
    ctx: { entidades: ['ent-0'] },
  },
  {
    name: 'rich-profile-v2-every-section',
    profile: {
      id: 'prof-1',
      version: 7,
      status: 'active',
      profile_body: {
        core_immutable: {
          identity_block: 'Você é a Maia, copiloto financeiro.',
          principles: ['Nunca invente números.', 'Confirme antes de gastar.'],
        },
        operational_profile: {
          voice: { tom: 'direto' },
        },
      },
    },
    self: { system_prompt: 'IGNORADO', versao: 1, resumo_aprendizados: 'IGNORADO' },
    history: RICH_HISTORY,
    entities: [
      { id: 'ent-a', nome: 'Padaria Central' },
      { id: 'ent-b', nome: 'Pessoa Física' },
    ],
    entityStates: [
      { entidade_id: 'ent-a', saldo_consolidado: '1234.50', proximo_vencimento: '2026-05-20' },
      { entidade_id: 'ent-b', saldo_consolidado: null, proximo_vencimento: null },
    ],
    facts: [
      { escopo: 'global', chave: 'moeda', valor: { content: 'BRL' } },
      { escopo: 'entidade:ent-a', chave: 'contador', valor: { content: 'Dona Rita' } },
    ],
    rules: [
      {
        id: 'rule-aaaaaaaa-1111',
        tipo: 'classificacao',
        confianca: '0.90',
        contexto: 'compra em mercado',
        acao: 'classificar como alimentação',
      },
      {
        id: 'rule-bbbbbbbb-2222',
        tipo: 'classificacao',
        confianca: '0.55',
        contexto: 'posto de gasolina',
        acao: 'classificar como transporte',
      },
    ],
    memories: [
      { content: 'Prefere resumos curtos.', proactive_use: true, mention_allowed: true },
      // proactive_use=false + no keyword overlap with the inbound → filtered out.
      { content: 'Comentou sobre viagem para Bariloche.', proactive_use: false, mention_allowed: true },
      // mention_allowed=false → never rendered literally.
      { content: 'Dado sensível de saúde.', proactive_use: true, mention_allowed: false },
    ],
    hints: [{ hint_text: 'Responda em no máximo 3 frases.' }, { hint_text: 'Use R$ com vírgula.' }],
    skills: [
      { skill_name: 'classificar_despesa', confidence: '0.910' },
      { skill_name: 'agendar_lembrete', confidence: '0.720' },
      { skill_name: 'conciliar_extrato', confidence: '0.310' },
    ],
    gaps: [
      { capability_description: 'emitir nota fiscal', current_level: 'mentionable' },
      { capability_description: 'integrar com o banco X', current_level: 'proposed' },
      { capability_description: 'ler boleto por foto', current_level: 'mentionable' },
    ],
    procedure: {
      execution: {
        id: 'exec-1',
        definition_id: 'def-1',
        current_step_id: 'coletar_dados',
        execution_state: { cliente: 'Padaria Central', valor: 120 },
      },
      definition: {
        id: 'def-1',
        nome: 'Fechamento mensal',
        version_number: 2,
        steps: [
          {
            id: 'coletar_dados',
            intencao: 'Reunir os lançamentos do mês',
            como: 'Peça o extrato e confirme as categorias',
            sucesso_criteria_ref: 'crit-1',
            armadilhas: ['não assumir categoria', 'não inventar valores'],
          },
        ],
        success_criteria: [{ id: 'crit-1', type: 'checklist' }],
      },
    },
    ctx: {
      entidades: ['ent-a', 'ent-b'],
      activeRole: {
        id: 'role-1',
        is_default: false,
        display_name: 'Atendimento',
        description: 'Modo de atendimento ao cliente final.',
        prompt_addendum: 'Nunca prometa prazo sem confirmar.',
      },
      current_role_id: 'role-1',
      current_channel_id: 'chan-1',
      last_scope_hash: 'hash-antigo',
      inbound_conteudo: 'registra 120 reais de mercado',
    },
  },
  {
    name: 'budget-truncation-every-section',
    profile: null,
    self: { system_prompt: 'Você é a Maia.', versao: 9, resumo_aprendizados: 'linha 1\nlinha 2' },
    history: Array.from({ length: 14 }, (_, i) =>
      msg({
        id: `h-${i}`,
        direcao: i % 2 === 0 ? 'in' : 'out',
        conteudo: longText(`msg-${i}-`, 3_000),
        created_at: new Date(T0 - i * 1_000),
      }),
    ),
    entities: Array.from({ length: 30 }, (_, i) => ({
      id: `e-${i}`,
      nome: longText(`Entidade-${i}-`, 400),
    })),
    entityStates: Array.from({ length: 30 }, (_, i) => ({
      entidade_id: `e-${i}`,
      saldo_consolidado: `${i}.00`,
      proximo_vencimento: null,
    })),
    facts: Array.from({ length: 40 }, (_, i) => ({
      escopo: 'global',
      chave: `k-${i}`,
      valor: { content: longText(`v-${i}-`, 500) },
    })),
    rules: Array.from({ length: 40 }, (_, i) => ({
      id: `rule-${String(i).padStart(8, '0')}-zzzz`,
      tipo: 'classificacao',
      confianca: '0.50',
      contexto: longText(`ctx-${i}-`, 400),
      acao: 'classificar',
    })),
    memories: Array.from({ length: 50 }, (_, i) => ({
      content: longText(`mem-${i}-`, 400),
      proactive_use: true,
      mention_allowed: true,
    })),
    hints: Array.from({ length: 40 }, (_, i) => ({ hint_text: longText(`hint-${i}-`, 300) })),
    skills: Array.from({ length: 20 }, (_, i) => ({
      skill_name: longText(`skill-${i}-`, 300),
      confidence: i % 2 === 0 ? '0.900' : '0.200',
    })),
    gaps: Array.from({ length: 20 }, (_, i) => ({
      capability_description: longText(`gap-${i}-`, 300),
      current_level: i % 2 === 0 ? 'mentionable' : 'proposed',
    })),
    procedure: null,
    ctx: { entidades: Array.from({ length: 30 }, (_, i) => `e-${i}`) },
  },
  {
    name: 'optional-sections-all-degraded',
    profile: null,
    self: { system_prompt: 'Você é a Maia.', versao: 2, resumo_aprendizados: '(vazio)' },
    history: [],
    entities: [{ id: 'ent-0', nome: 'Casa' }],
    entityStates: [{ entidade_id: 'ent-0', saldo_consolidado: '10.00', proximo_vencimento: null }],
    facts: [],
    rules: [],
    memories: [],
    hints: [],
    skills: [],
    gaps: [],
    procedure: null,
    ctx: { entidades: ['ent-0'] },
    failOptional: true,
  },
];
