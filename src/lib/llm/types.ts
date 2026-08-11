/**
 * Contrato provider-neutral do LLM Gateway (issue #508).
 *
 * Esta é a ÚNICA fronteira por onde passam chamadas de chat, classificação e
 * visão da Maia. Nenhum módulo de cognição, agente, skill ou worker deve
 * instanciar `@anthropic-ai/sdk` ou `openai` diretamente — só os adapters em
 * `src/lib/llm/providers/**` têm essa permissão (ver regra ESLint
 * `no-restricted-imports` em `eslint.config.js`).
 *
 * Pontos de extensão já previstos para as issues irmãs:
 *  - #507 (deadline + cancelamento por turno) injeta `LLMExecutionContext`
 *    com `signal` e `deadline_at`. Hoje a maioria dos callers não passa nada;
 *    o gateway trata ambos como opcionais e degrada para o comportamento
 *    legado (sem deadline total).
 *  - #514 (tracing E2E) consome `trace_id` e o evento de uso emitido em
 *    `src/lib/llm/telemetry.ts`.
 */

/**
 * Workload = a INTENÇÃO da chamada, não o módulo que chama. É o eixo por onde
 * o backend decide tier default, política de retry e se fallback é permitido
 * (ver `src/lib/llm/workloads.ts`). O caller NUNCA passa slug de modelo.
 */
export type LLMWorkload =
  | 'reasoner'
  | 'intent_classifier'
  | 'pending_gate'
  | 'memory_classifier'
  | 'conversation_classifier'
  | 'behavioral_hint'
  | 'risk_classifier'
  | 'role_selector'
  | 'procedure_selector'
  | 'procedure_builder'
  | 'step_evaluator'
  | 'capability_proposer'
  | 'calendar_detector'
  | 'drift_detector'
  | 'reflection'
  | 'summarizer'
  | 'skill'
  | 'vision'
  | 'playground'
  | 'probe';
// NOTA: não existe workload `legacy`. Ele foi criado como escape hatch para
// callers ainda não migrados, mas virou um bypass: declarar nada era uma opção,
// e a regra de lint que bloqueia SDK direto não impedia isso. Com todos os call
// sites migrados, o escape hatch sumiu e `workload` é obrigatório em toda a
// superfície — inclusive no facade `callLLM`. O gate em
// tests/unit/lib/llm-workload-declaration.spec.ts impede a reintrodução.

/**
 * Tier = a CLASSE de modelo, resolvida pelo backend a partir das settings
 * dinâmicas (`global_settings` → env). `vision` compartilha o slug de `fast`
 * hoje; existe como tier próprio para que trocar o modelo de visão não exija
 * mexer nos classificadores.
 */
export type LLMTier = 'main' | 'fast' | 'vision';

export type LLMProviderName = 'anthropic' | 'openrouter';

export type LLMImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export type LLMContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: LLMImageMediaType; data: string };
    };

export type LLMMessage = {
  role: 'user' | 'assistant';
  content: string | LLMContentBlock[];
};

export type ToolSchema = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type LLMUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read?: number;
  cache_write?: number;
};

export type LLMResponse = {
  content: string | null;
  tool_uses: Array<{ id: string; tool: string; args: unknown }>;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
  usage: LLMUsage;
  model: string;
};

/**
 * Contexto de execução opcional. Projetado para a issue #507 poder passar
 * deadline/cancelamento sem quebrar callers existentes, e para a #514 poder
 * correlacionar o evento de uso com o trace do turno.
 *
 * `deadline_at` é um instante ABSOLUTO (`Date.now()` + orçamento), não uma
 * duração: o gateway divide o tempo restante entre tentativas, backoff e
 * fallback, e nunca reinicia o relógio a cada retry.
 */
export type LLMExecutionContext = {
  /** Correlaciona a chamada com o turno. NUNCA vira label Prometheus. */
  trace_id?: string;
  /** Cancelamento do caller. Chega até a requisição HTTP do SDK. */
  signal?: AbortSignal;
  /**
   * Instante absoluto (ms epoch) em que a chamada inteira deve estar morta.
   *
   * Opcional, mas NUNCA ausente na prática: quando o caller não declara um, o
   * gateway deriva a partir de `LLM_TURN_DEADLINE_MS`.
   *
   * Declarar serve para APERTAR o limite (é o que a issue #507 faz por turno),
   * nunca para afrouxá-lo: `LLM_TURN_DEADLINE_MS` é TETO, e o gateway aplica
   * `min(deadline_at, now + LLM_TURN_DEADLINE_MS)`. Um valor no futuro
   * distante é silenciosamente reduzido ao teto do operador — o orçamento de
   * quem opera o processo não é sobrescrevível por um caller.
   */
  deadline_at?: number;
};

/**
 * `tenant_id`/`agent_id` NÃO fazem parte da request: vêm do ALS
 * (`src/db/tenant-context.ts`). Callers comuns não podem declará-los — isso é
 * o que impede um caller de escapar do isolamento por engano.
 */
export type LLMGatewayRequest = {
  workload: LLMWorkload;
  /**
   * Omitido → tier default do workload (`src/lib/llm/workloads.ts`).
   *
   * ## ✅ DECISÃO DO OWNER (issue #534): `tier` NÃO é obrigatório no call site
   *
   * A issue #508 pedia, textualmente, que "todos os callers declarem
   * `workload` e `tier`". A PR #531 tornou `workload` obrigatório e manteve o
   * `tier` centralizado, registrando a divergência como PENDENTE de revisão. A
   * #534 fechou a pendência, e a regra passa a ser esta:
   *
   * > O call site declara **workload**. O backend resolve tier, provider,
   * > modelo e política de fallback centralmente. Exceções são POLÍTICAS
   * > GOVERNADAS (uma linha revisável em `workloads.ts`), nunca overrides
   * > livres do caller.
   *
   * O argumento que sustenta a decisão, para quem revisar isto sem o
   * histórico: o objetivo declarado da própria #508 é "apenas o backend
   * seleciona provider, modelo, tier e política de fallback". Um `tier`
   * obrigatório no call site trabalha CONTRA esse objetivo — transforma a
   * classe de modelo em parâmetro de quem chama, e o call site é justamente
   * quem não tem contexto para decidir custo/qualidade. Foi assim que 13
   * módulos acabaram com slug fixo no código, que é o defeito que a #508
   * existe para consertar.
   *
   * O tier CONTINUA declarado, e de forma mais forte: uma vez por workload, em
   * `src/lib/llm/workloads.ts`, versionado, revisável num diff e impossível de
   * divergir entre dois call sites do mesmo workload. Mudar o tier de um
   * classificador vira uma linha revisada, não um grep por call sites.
   *
   * O parâmetro permanece opcional como escape hatch para o caso legítimo de
   * um workload precisar de tier diferente numa chamada específica (hoje: só a
   * visão, que declara `vision`). Se esse caso deixar de existir, o campo pode
   * sumir — mas obrigá-lo seria mover a decisão para o lugar errado.
   *
   * ⚠️ Consequência prática para quem for adicionar um caller: passar `tier`
   * aqui é um DESVIO da política do workload, e desvio precisa de justificativa
   * no diff. Se a razão for "este workload deveria rodar noutro tier", o lugar
   * da mudança é `workloads.ts`, não o call site.
   */
  tier?: LLMTier;
  system: string;
  messages: LLMMessage[];
  tools?: ToolSchema[];
  max_tokens?: number;
  temperature?: number;
  /** Atribuição de custo por pessoa (opcional). Não vira label Prometheus. */
  pessoa_id?: string;
  ctx?: LLMExecutionContext;
};

/** Resultado da resolução backend-side de provider + modelo. */
export type ResolvedModel = {
  provider: LLMProviderName;
  model: string;
  tier: LLMTier;
};

/**
 * Interface mínima que todo adapter de provider implementa. Mantida
 * `export` para compatibilidade com o contrato histórico de
 * `src/lib/claude.ts`.
 */
export interface LLMProvider {
  name: LLMProviderName;
  call(params: {
    system: string;
    messages: LLMMessage[];
    tools?: ToolSchema[];
    temperature?: number;
    max_tokens?: number;
    model: string;
    /** Sinal efetivo (caller + deadline) já composto pelo gateway. */
    signal?: AbortSignal;
    /** Teto por tentativa, em ms. Nunca maior que o deadline restante. */
    timeout_ms?: number;
  }): Promise<LLMResponse>;
  /** Slug default do provider por tier, usado quando não há settings. */
  envDefault(tier: LLMTier): string;
  /** Fail-closed: a chave do provider ativo está presente? */
  isConfigured(): boolean;
}
