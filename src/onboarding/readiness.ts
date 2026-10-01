/**
 * Issue #519 §5 — READINESS CANÔNICO por agente. Esta é a fonte ÚNICA de
 * verdade sobre "este (tenant, agente) está pronto para operar?".
 *
 * Consumidores previstos (todos devem chamar ISTO, nunca reimplementar):
 *   - a ativação da saga (`src/onboarding/wizard.ts`);
 *   - o `maia doctor` da issue #517 — o requisito explícito de lá é que a
 *     prontidão seja CALCULADA PELO BACKEND a partir do mesmo contrato que o
 *     runtime usa, e nunca re-derivada como heurística de CLI;
 *   - o dashboard e o go-live checklist do console;
 *   - observabilidade (`agent_readiness_failed_total{check_code}`).
 *
 * ─── A propriedade central ───────────────────────────────────────────────────
 * O bug que este módulo existe para matar é o falso positivo por COMPOSIÇÃO
 * CRUZADA: "existe algum profile ativo" + "existe algum canal conectado" ⇒
 * "pronto", mesmo quando o profile é do agente A e o canal é do agente B (ou
 * de outro tenant). Por isso o avaliador é PURO e recebe os fatos com o escopo
 * DONO de cada objeto embutido: ele não confia que o loader filtrou — ele
 * PROVA, descartando todo objeto cujo `(tenant_id, agent_id)` não seja
 * exatamente o par requisitado. Um fato de outro escopo é tratado como
 * ausente, jamais como satisfeito.
 *
 * ─── Fail-closed ─────────────────────────────────────────────────────────────
 * Escopo inválido (vazio, com whitespace, ou os literais reservados `'default'`
 * / `'system'`) NÃO devolve `ready:false` — lança `OnboardingError`. Devolver
 * um relatório para um escopo proibido convidaria um caller a renderizar
 * "quase pronto" para um alvo que nunca pode existir.
 *
 * ─── DECISÃO DE POLÍTICA: canal inválido é EXCLUÍDO, não bloqueante ──────────
 * (Review adversarial do PR #541, achado 1 — a pergunta em aberto era se um
 * canal governado inválido deveria BLOQUEAR o agente inteiro.)
 *
 * A regra implementada, e o contrato que os consumidores podem assumir:
 *
 *   1. os predicados de canal (política do mesmo escopo + `default_role_id`
 *      resolvendo para papel ATIVO + posse da linha provada) precisam valer
 *      PARA O MESMO CANAL. A conjunção é por canal, nunca agregada;
 *   2. o agente fica `ready` quando existe PELO MENOS UM canal que satisfaz a
 *      conjunção inteira;
 *   3. a ativação liga EXATAMENTE esses canais (`activatable_channel_ids`).
 *      Um canal governado que falhe qualquer predicado NÃO é ativado —
 *      continua `active=false`, isto é, fora do roteamento;
 *   4. a exclusão é EXPLÍCITA no veredito: `AgentReadiness.channels` traz o
 *      veredito por canal com os códigos que ele reprovou, e a mensagem do
 *      check `channel_ownership_proven` enumera os excluídos.
 *
 * Por que não a alternativa "todos os canais governados precisam estar
 * prontos": porque ela transforma um canal quebrado em um agente inteiro
 * parado. Um tenant com três linhas, uma delas com o pareamento vencido, não
 * consegue ativar NENHUMA — e a remediação óbvia vira apagar a linha ruim
 * (destrutivo) em vez de consertá-la. A regra escolhida é fail-closed no que
 * importa (nada roteia sem posse E papel válido) e permissiva só no que é
 * seguro (o agente sobe com as linhas que estão de fato prontas).
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './idempotency.js';
import { assertProvisioningScope } from './scope.js';

export type ReadinessCheckStatus = 'pass' | 'fail';
export type ReadinessSeverity = 'blocking' | 'advisory';

/**
 * SC03 — os checks do MOTOR REMOTO (spec §4.1, §5.10.1, §9.4).
 *
 * São cinco porque são cinco perguntas diferentes, e o operador precisa saber
 * QUAL delas reprovou: "não há evidência de implantação aprovada" (bundle),
 * "a política de dados do piloto não está pronta", "não há limites finitos
 * aprovados", "o pin de runtime não casa com o adaptador que está rodando" e
 * "a linha de política do agente não é um binding válido". Colapsá-las em um
 * `engine_ready` booleano jogaria fora exatamente a parte acionável.
 *
 * O sexto código (`engine_admission_open`) NÃO é do deployment: é da ADMISSÃO.
 * O kill switch (§5.10.2) só impede admissões NOVAS, e sem um check próprio
 * ele ficaria invisível no relatório (a UI voltaria a "verde" com o Hermes
 * morto) ou seria colapsado dentro de um check de deployment — dizendo que o
 * bundle não está aprovado quando ele está. São fatos diferentes.
 */
export const ENGINE_READINESS_CHECK_CODES = [
  'engine_binding_valid',
  'engine_bundle_approved',
  'engine_data_policy_ready',
  'engine_limits_configured',
  'engine_runtime_compatible',
  'engine_admission_open',
] as const;

export type EngineReadinessCheckCode = (typeof ENGINE_READINESS_CHECK_CODES)[number];

/**
 * Códigos ESTÁVEIS. São contrato público (label de métrica, chave de i18n da
 * remediation, asserção de teste do doctor) — renomear um é breaking change.
 */
export const READINESS_CHECK_CODES = [
  'tenant_exists',
  'tenant_enabled',
  'agent_exists',
  'agent_belongs_to_tenant',
  'profile_active',
  'capability_grant_present',
  'required_packs_granted',
  'tool_permissions_coherent',
  'default_role_resolved',
  'channel_declared',
  'channel_policy_resolved',
  'channel_policy_role_active',
  'channel_ownership_proven',
  'channel_online',
  'schema_ready',
  'governance_no_blocking_pending',
  'agent_activated',
  ...ENGINE_READINESS_CHECK_CODES,
] as const;

export type ReadinessCheckCode = (typeof READINESS_CHECK_CODES)[number];

export type ReadinessCheck = {
  code: ReadinessCheckCode;
  status: ReadinessCheckStatus;
  severity: ReadinessSeverity;
  /** Mensagem SANITIZADA: sem telefone, e-mail, segredo, QR ou stack. */
  message: string;
  /** O que o operador deve fazer. Vazio quando o check passou. */
  remediation: string;
};

/**
 * O veredito POR CANAL. Existe porque os checks de canal são um conjunto de
 * predicados que precisam valer PARA O MESMO canal, e um veredito agregado não
 * consegue dizer isso (ver `evaluateReadinessFacts`, seção 6/7).
 *
 * `activatable` é a conjunção — e é o ÚNICO critério de ativação: a saga liga
 * exatamente os canais com `activatable: true`, nunca "os que têm política".
 */
export type ChannelVerdict = {
  channel_id: string;
  /** Existe `channel_policy` do MESMO (tenant, agente) apontando para o canal. */
  policy_governed: boolean;
  /** TODA política do canal resolve para um papel ATIVO do mesmo escopo. */
  policy_role_active: boolean;
  /** `channel_line_state.state` prova posse da linha (#518). */
  ownership_proven: boolean;
  /** Socket de pé agora. Advisório — não entra em `activatable`. */
  online: boolean;
  /** `policy_governed && policy_role_active && ownership_proven`. */
  activatable: boolean;
  /**
   * Os códigos de check que ESTE canal reprovou. Vazio ⟺ `activatable`. É o
   * que torna a exclusão de um canal governado EXPLÍCITA no veredito, em vez
   * de invisível dentro de um agregado verde.
   */
  failed_checks: ReadinessCheckCode[];
};

/**
 * ─── SC03: PORTAS DE EVIDÊNCIA DE IMPLANTAÇÃO ───────────────────────────────
 *
 * O readiness do motor remoto é composto de DADOS TIPADOS APROVADOS, nunca de
 * fatos que o processo infere de si mesmo. Três escolhas explícitas:
 *
 *  1. **Ausência RECUSA.** Não existe default de bundle, de política de dados
 *     nem de limites: um campo ausente reprova o check respectivo. Inventar
 *     `max_iterations` ou "aprovar" um bundle que ninguém aprovou é a via mais
 *     curta para uma admissão remota sem aceite, que é o que o §5.10.1 proíbe.
 *  2. **O portão é FECHADO hoje.** A evidência de implantação REAL (§9.4) ainda
 *     não tem atestador instalado neste repositório — o que existe é o harness
 *     sintético explícito de `src/runtime/engines/hermes-runtime.ts`. A porta
 *     default devolve `null` (`NO_ENGINE_DEPLOYMENT_EVIDENCE`), então qualquer
 *     agente cuja política peça Hermes fica NÃO-pronto até que um atestador
 *     aprovado seja injetado. O que os testes injetam é a fixture SINTÉTICA
 *     completa, que pode ficar pronta sem configurar produção (SC03-AC03).
 *  3. **A classe da evidência viaja junto.** `synthetic` diz que aquilo é o
 *     harness de teste; `approved` é o aceite humano. A admissão remota de
 *     tráfego real continua governada pela escada do canário (P12) — o
 *     readiness não a substitui e não a promove.
 */

/**
 * Espelho EXATO de `ENGINE_KINDS` (`src/runtime/engines/schemas.ts`) e do CHECK
 * `agent_engine_policies_engine_chk` da migration 145. É um espelho com teste
 * de pino (não uma terceira autoridade): a spec SC03 confronta os três, e um
 * valor novo sem update nos três não passa.
 */
export const ENGINE_POLICY_ENGINES = ['maia_react', 'hermes'] as const;
export type EnginePolicyEngine = (typeof ENGINE_POLICY_ENGINES)[number];

/** Uma linha de `agent_engine_policies` (145) como o readiness a consome. */
export type EnginePolicyBindingFactV1 = {
  tenant_id: string;
  agent_id: string;
  channel_id: string;
  /** `maia_react` | `hermes` — validado pelo avaliador puro, não confiado. */
  engine: string;
  /** CAS: a versão que a ativação revalida. */
  row_version: number;
};

export const ENGINE_DEPLOYMENT_EVIDENCE_CLASSES = ['synthetic', 'approved'] as const;
export type EngineDeploymentEvidenceClass = (typeof ENGINE_DEPLOYMENT_EVIDENCE_CLASSES)[number];

/**
 * A evidência de implantação do §9.4/§7.10, como DADO. `revision` é o token de
 * CAS: muda quando qualquer fato abaixo muda. É ele que a ativação revalida —
 * um bundle republicado entre o check e a ativação não pode passar.
 */
export type EngineDeploymentEvidenceV1 = {
  evidence_class: EngineDeploymentEvidenceClass;
  revision: string;
  bundle: { id: string; digest: string; approved_by: string; approved_at: string } | null;
  runtime_pin: { hermes_sha: string; adapter_revision: string; protocol: string } | null;
  data_policy: { policy_id: string; classes: readonly string[]; approved: boolean } | null;
  limits: {
    max_iterations: number;
    max_output_tokens_per_call: number;
    max_inference_calls: number;
  } | null;
};

/**
 * Classes de dado que o PILOTO exige cobrir (§5.10.1: só texto extraído
 * autorizado entra; receptivo-only no gateway/egresso). É um MÍNIMO FECHADO:
 * uma política de dados aprovada que não cubra isto não habilita o piloto. Uma
 * classe a mais é permitida; a ausência de qualquer uma reprova.
 */
export const ENGINE_REQUIRED_DATA_POLICY_CLASSES = ['texto_extraido_aprovado'] as const;

/** O que este build considera "o adaptador que está rodando" (§4.1, §5.10.1). */
export type EngineRuntimeFactsV1 = { adapter_revision: string; protocol: string };

/**
 * Os fatos do motor remoto. `policies` vem do banco (escopo explícito),
 * `evidence` do atestador, `runtime` do build que está rodando, e `kill_switch`
 * da configuração efetiva.
 */
export type EngineReadinessFactsV1 = {
  /**
   * O escopo PEDE o motor remoto. É um FATO do backend (derivado da linha de
   * `agent_engine_policies`), não uma flag global: nenhuma flag liga o Hermes.
   * O avaliador puro o confronta com as linhas de política — o par
   * (requested, policies) inconsistente REPROVA, em vez de ser reconciliado
   * em silêncio.
   */
  requested: boolean;
  policies: readonly EnginePolicyBindingFactV1[];
  kill_switch: boolean;
  runtime: EngineRuntimeFactsV1;
  evidence: EngineDeploymentEvidenceV1 | null;
};

/**
 * Motivos FECHADOS de indisponibilidade. Vocabulário público: o console
 * renderiza isto e o teste de aceite o confronta. Texto livre do provedor nunca
 * entra aqui.
 */
export const ENGINE_UNAVAILABLE_REASONS = [
  'binding_missing',
  'binding_invalid',
  'evidence_absent',
  'bundle_unapproved',
  'data_policy_not_ready',
  'limits_missing',
  'runtime_incompatible',
  'kill_switch',
] as const;
export type EngineUnavailableReason = (typeof ENGINE_UNAVAILABLE_REASONS)[number];

/**
 * A projeção do motor remoto no relatório. É o que o console lê para mostrar
 * INDISPONIBILIDADE em vez de inventar "pronto" (SC03-AC04):
 *
 *  - `requested` falso = nenhuma linha de política pede Hermes; os checks do
 *    motor não se aplicam e nada é consultado (nem worker, nem credencial);
 *  - `available` é a conjunção dos SEIS checks, e `unavailable_reason` diz qual
 *    fato fechou a porta;
 *  - `binding_revision`/`evidence_revision` são os tokens que a ativação
 *    revalida sob CAS.
 *
 * Quem lê este objeto tem de olhar `requested` PRIMEIRO: num escopo que não
 * pede o motor remoto, `available` é `true` porque NENHUM check se aplica — e
 * isso significa "o motor remoto não está em jogo aqui, o local atende", não
 * "o motor remoto está disponível".
 *
 * ─── Narrowing por canal: preservado, e a diferença fica aqui ──────────────
 *
 * A chave de `agent_engine_policies` (145) é (tenant, agente, CANAL): uma linha
 * por canal. Este módulo NÃO a amplia para uma chave per-agent global — um canal
 * sem linha continua em `maia_react`, e `requested` é DERIVADO das linhas (alguma
 * pede `hermes`), nunca o contrário. É uma diferença real em relação à leitura
 * per-agent da SPEC, deliberada e fail-closed: o efeito de ligar o motor remoto
 * para o agente inteiro exigiria uma linha por canal, e um canal esquecido
 * atendendo pelo motor errado seria pior que a fricção de gravá-las.
 */
export type EngineReadinessProjection = {
  requested: boolean;
  kill_switch: boolean;
  evidence_class: EngineDeploymentEvidenceClass | null;
  binding_revision: string | null;
  evidence_revision: string | null;
  available: boolean;
  unavailable_reason: EngineUnavailableReason | null;
};

export type AgentReadiness = {
  tenant_id: string;
  agent_id: string;
  /** `true` ⟺ TODO check `blocking` está `pass`. Advisórios não bloqueiam. */
  ready: boolean;
  checks: ReadinessCheck[];
  /**
   * SC03 — o veredito do MOTOR REMOTO projetado para o console. Sempre
   * presente: um consumidor nunca precisa adivinhar se o agente pediu Hermes.
   */
  engine: EngineReadinessProjection;
  /**
   * O veredito de CADA canal declarado do escopo (exceto a sonda sintética).
   * Fonte única da decisão de ativação e da explicação ao operador.
   */
  channels: ChannelVerdict[];
  /**
   * Os canais integralmente válidos — o conjunto EXATO que `applyActivate`
   * liga. Um canal governado que não esteja aqui NÃO é ativado, por decisão
   * de política (fail-closed), e o motivo está no seu `ChannelVerdict`.
   */
  activatable_channel_ids: string[];
  evaluated_at: string;
  /**
   * SHA-256 da projeção canônica da configuração que governa este agente.
   * Muda quando profile, grants, papéis, políticas ou canais mudam — é o que
   * a ativação grava na auditoria e o que permite detectar que a configuração
   * mudou DEPOIS da avaliação.
   */
  configuration_fingerprint: string;
  /**
   * SHA-256 do ESTADO VERIFICADO do schema: veredito, heads e o par
   * (estado, checksum) de cada migration. Deliberadamente NÃO é a lista de
   * ids — essa seria idêntica para um schema saudável e um sujo, que é
   * exatamente a confusão que a fingerprint existe para impedir.
   */
  schema_fingerprint: string;
};

// ─── Fatos crus ───────────────────────────────────────────────────────────────
// Todo objeto carrega o escopo do seu DONO. O avaliador re-verifica; o loader
// não é confiável por construção (é código de I/O, e um `WHERE` esquecido é
// exatamente o modo de falha que estamos defendendo).

type Scoped = { tenant_id: string; agent_id: string };

/**
 * Estado do schema como o readiness o consome — a PROJEÇÃO do veredito
 * canônico de `src/migrations/` (`getSchemaReadiness`), nunca uma re-derivação
 * a partir de `schema_migrations`.
 *
 * `ready` é o veredito; `verified` é a evidência por migration, e é ela (e não
 * a lista de ids) que entra no `schema_fingerprint`.
 */
export type SchemaFacts = {
  /** Veredito canônico. `false` também quando o estado não pôde ser apurado. */
  ready: boolean;
  state: 'ready' | 'blocked' | 'unknown';
  expected_head: string | null;
  applied_head: string | null;
  /** Ids verificados como aplicados (checksum confere). */
  applied_migrations: string[];
  /** Ids que este build ainda aplicaria (`pending` + `failed`). */
  pending_migrations: string[];
  /** Bloqueadores por CÓDIGO estável — nunca SQL, DSN ou texto de driver. */
  blockers: Array<{ kind: string; id: string | null }>;
  /** Estado + checksum de cada migration conhecida (artefato ∪ ledger). */
  verified: Array<{ id: string; state: string; checksum: string | null }>;
};

export type ReadinessFacts = {
  requested: { tenant_id: string; agent_id: string };
  tenant: { id: string; status: string } | null;
  agent: { id: string; tenant_id: string; status: string } | null;
  profile: (Scoped & { id: string; version: number; status: string }) | null;
  tool_grant:
    | (Scoped & { granted_packs: string[]; granted_tools: string[]; denied_tools: string[] })
    | null;
  roles: Array<Scoped & { id: string; role_key: string; active: boolean; is_default: boolean }>;
  channels: Array<
    Scoped & {
      id: string;
      channel_type: string;
      active: boolean;
      is_synthetic: boolean;
      /** Estado operacional de #518 (`channel_line_state.state`). */
      line_state: string | null;
    }
  >;
  policies: Array<Scoped & { id: string; channel_id: string; default_role_id: string }>;
  /** Packs que a plataforma exige de todo agente (`BASE_AGENT_PACKS`). */
  required_packs: string[];
  schema: SchemaFacts;
  /** Itens de governança abertos que bloqueiam operação (drift crítico não resolvido). */
  blocking_governance_items: number;
  /**
   * SC03 — os fatos do MOTOR REMOTO.
   *
   * AUSENTE vale "nenhuma política deste escopo pede Hermes", e nesse caso os
   * seis checks do motor passam como NÃO APLICÁVEIS — é o comportamento que
   * mantém todo agente que nunca pediu Hermes exatamente como estava antes
   * desta spec.
   *
   * Quem chama `evaluateAgentReadiness` não depende desta conveniência: a
   * função SEMPRE busca as linhas de política pela porta (e uma falha de
   * leitura sobe como exceção, nunca como "sem linha") antes de avaliar. A
   * ausência só é possível quando um chamador monta os fatos à mão — testes do
   * avaliador puro e fixtures sintéticas.
   */
  engine?: EngineReadinessFactsV1 | null;
};

/**
 * Estados de linha (#518) que PROVAM posse da linha. Exportado porque é um
 * literal do vocabulário de `channel_line_state.state`: se ele divergir do
 * CHECK daquela coluna, o check `channel_ownership_proven` nunca passa e
 * nenhum agente jamais ativa — falha silenciosa, sem 23514 para denunciar.
 * `tests/unit/onboarding/schema-constraint-compatibility.spec.ts` confronta.
 */
export const OWNERSHIP_PROVEN_LINE_STATES = ['connected', 'verified_offline'] as const;

function owns(scope: { tenant_id: string; agent_id: string }, requested: Scoped): boolean {
  return scope.tenant_id === requested.tenant_id && scope.agent_id === requested.agent_id;
}

/**
 * Mensagem SANITIZADA do `schema_ready` reprovado: só códigos de bloqueador e
 * ids de migration, nunca `detail` cru (que é operador-facing mas longo) e
 * jamais SQL/DSN. A mensagem é persistida no resultado do passo.
 */
function describeSchemaBlockage(schema: SchemaFacts): string {
  if (schema.state === 'unknown') {
    return 'estado do schema não pôde ser apurado — fail-closed';
  }
  const head = schema.blockers
    .slice(0, 5)
    .map((b) => (b.id ? `${b.kind}(${b.id})` : b.kind))
    .join(', ');
  const extra = schema.blockers.length > 5 ? ` e mais ${schema.blockers.length - 5}` : '';
  return head
    ? `schema bloqueado: ${head}${extra}`
    : `schema bloqueado (${schema.pending_migrations.length} migration(s) pendente(s))`;
}

function check(
  code: ReadinessCheckCode,
  ok: boolean,
  severity: ReadinessSeverity,
  failMessage: string,
  remediation: string,
  passMessage: string,
): ReadinessCheck {
  return ok
    ? { code, status: 'pass', severity, message: passMessage, remediation: '' }
    : { code, status: 'fail', severity, message: failMessage, remediation };
}

// ─── SC03: os checks do motor remoto ─────────────────────────────────────────
//
// Precedência FECHADA dos motivos: o primeiro da lista que morder é o motivo
// reportado, para que o mesmo estado produza sempre a mesma explicação (o
// console renderiza isso).

const ENGINE_REASON_PRECEDENCE: readonly EngineUnavailableReason[] = [
  'kill_switch',
  'binding_missing',
  'binding_invalid',
  'evidence_absent',
  'bundle_unapproved',
  'data_policy_not_ready',
  'limits_missing',
  'runtime_incompatible',
];

/** O motivo mais grave entre os que morderam, na ordem acima. */
function dominantEngineReason(reasons: readonly EngineUnavailableReason[]): EngineUnavailableReason | null {
  for (const r of ENGINE_REASON_PRECEDENCE) if (reasons.includes(r)) return r;
  return null;
}

/**
 * Fingerprint das linhas de política do escopo — o token de CAS do BINDING.
 *
 * Só linhas do escopo entram. `null` quando não há nenhuma. É determinístico
 * (ordenado por `channel_id`) porque ele é comparado entre duas leituras: uma
 * ordem de linha instável faria a ativação recusar por um motivo que não
 * aconteceu.
 */
export function engineBindingRevision(
  policies: readonly EnginePolicyBindingFactV1[],
  scope: { tenant_id: string; agent_id: string },
): string | null {
  const owned = policies.filter((p) => owns(p, scope));
  if (owned.length === 0) return null;
  const projection = owned
    .map((p) => ({ channel_id: p.channel_id, engine: p.engine, row_version: p.row_version }))
    .sort((a, b) => a.channel_id.localeCompare(b.channel_id));
  return createHash('sha256').update(canonicalJson(projection), 'utf8').digest('hex');
}

/** Um check do motor: `blocking` como todos os outros checks de decisão. */
function engineCheck(
  code: EngineReadinessCheckCode,
  ok: boolean,
  failMessage: string,
  remediation: string,
  passMessage: string,
): ReadinessCheck {
  return check(code, ok, 'blocking', failMessage, remediation, passMessage);
}

const ENGINE_NOT_APPLICABLE = (code: EngineReadinessCheckCode): ReadinessCheck =>
  engineCheck(
    code,
    true,
    '',
    '',
    'nenhuma política deste escopo pede o motor remoto — check não aplicável',
  );

/**
 * Os seis checks do motor + a projeção que o console lê.
 *
 * A REGRA CENTRAL: nada aqui é inferido do processo. Bundle, política de dados,
 * limites e pin vêm da evidência tipada; ausência de qualquer um REPROVA (não
 * existe default). E o par (requested, policies) precisa ser CONSISTENTE — um
 * fato que diz "este agente pede Hermes" sem a linha de política que o liga, ou
 * uma linha `hermes` que o fato não reconhece, reprova: é exatamente a
 * divergência que faria uma auditoria e um roteamento discordarem.
 */
function evaluateEngineChecks(facts: ReadinessFacts): {
  checks: ReadinessCheck[];
  projection: EngineReadinessProjection;
} {
  const req = facts.requested;
  const engine = facts.engine ?? null;

  if (engine === null) {
    return {
      checks: ENGINE_READINESS_CHECK_CODES.map(ENGINE_NOT_APPLICABLE),
      projection: {
        requested: false,
        kill_switch: false,
        evidence_class: null,
        binding_revision: null,
        evidence_revision: null,
        available: true,
        unavailable_reason: null,
      },
    };
  }

  const owned = engine.policies.filter((p) => owns(p, req));
  const foreignRows = engine.policies.length - owned.length;
  const scopedChannelIds = new Set(
    facts.channels.filter((c) => owns(c, req)).map((c) => c.id),
  );
  // Uma linha inválida: engine fora do vocabulário, versão de CAS que não é
  // inteiro >= 1, ou canal que NÃO é deste escopo (a FK composta da 145 impede
  // no banco; aqui é a re-verificação do avaliador sobre fatos que ele não
  // confia). Escopo errado conta como linha inválida, nunca como ausência.
  const invalidRows = owned.filter(
    (p) =>
      !(ENGINE_POLICY_ENGINES as readonly string[]).includes(p.engine) ||
      !Number.isInteger(p.row_version) ||
      p.row_version < 1 ||
      !scopedChannelIds.has(p.channel_id),
  );
  const bindingRevision = engineBindingRevision(engine.policies, req);

  const requested = engine.requested;
  const reasons: EngineUnavailableReason[] = [];
  if (requested && engine.kill_switch) reasons.push('kill_switch');

  // (1) Binding. `requested` sem linha `hermes` é binding AUSENTE; linha
  // `hermes` que o fato não reconhece é binding INCONSISTENTE. Os dois são
  // fail-closed: ligar o Hermes é uma linha, e uma linha tem de existir e ser
  // legível.
  const anyHermesRow = owned.some((p) => p.engine === 'hermes');
  const bindingOk =
    invalidRows.length === 0 &&
    foreignRows === 0 &&
    (!requested || anyHermesRow) &&
    (requested || !anyHermesRow);
  if (!bindingOk) {
    // A razão segue a CAUSA: sem NENHUMA linha do escopo o agente não está
    // ligado a motor nenhum (`binding_missing`); havendo linha, ela está
    // ilegível, fora do escopo ou contradizendo o próprio pedido
    // (`binding_invalid`). Colapsar as duas faria o console mandar o operador
    // gravar uma linha que já existe.
    reasons.push(owned.length === 0 ? 'binding_missing' : 'binding_invalid');
  }
  const bindingMessage = bindingOk
    ? `${owned.length} linha(s) de política válida(s) no escopo`
    : foreignRows > 0
      ? `binding de engine inválido: ${foreignRows} linha(s) fora deste escopo (tenant/agente) não podem governar este agente`
      : invalidRows.length > 0
        ? `binding de engine inválido: ${invalidRows.length} linha(s) com canal, motor ou versão de CAS inválidos`
        : 'o agente está configurado para o motor remoto mas não há linha de política que o ligue';

  // (2)-(5) Deployment. Só fazem sentido quando o motor remoto é pedido; sem
  // pedido eles são não aplicáveis (e nenhuma evidência é consultada).
  const evidence = engine.evidence;
  const bundleOk =
    evidence !== null &&
    evidence.bundle !== null &&
    evidence.bundle.id.trim() !== '' &&
    evidence.bundle.digest.trim() !== '' &&
    evidence.bundle.approved_at.trim() !== '' &&
    (evidence.evidence_class !== 'approved' || evidence.bundle.approved_by.trim() !== '');
  const dataPolicy = evidence?.data_policy ?? null;
  const dataPolicyOk =
    dataPolicy !== null &&
    dataPolicy.approved === true &&
    ENGINE_REQUIRED_DATA_POLICY_CLASSES.every((c) => dataPolicy.classes.includes(c));
  const limits = evidence?.limits ?? null;
  const limitsOk =
    limits !== null &&
    [limits.max_iterations, limits.max_output_tokens_per_call, limits.max_inference_calls].every(
      (v) => Number.isInteger(v) && v > 0,
    );
  const pin = evidence?.runtime_pin ?? null;
  const pinOk =
    pin !== null &&
    pin.hermes_sha.trim() !== '' &&
    pin.adapter_revision === engine.runtime.adapter_revision &&
    pin.protocol === engine.runtime.protocol;

  if (requested && !bundleOk) reasons.push(evidence === null ? 'evidence_absent' : 'bundle_unapproved');
  if (requested && !dataPolicyOk) reasons.push('data_policy_not_ready');
  if (requested && !limitsOk) reasons.push('limits_missing');
  if (requested && !pinOk) reasons.push('runtime_incompatible');

  const checks: ReadinessCheck[] = [
    engineCheck(
      'engine_binding_valid',
      bindingOk,
      bindingMessage,
      'Grave a linha de política do canal no passo do console (um motor por canal) e garanta que ela pertence a ESTE (tenant, agente).',
      bindingMessage,
    ),
    requested
      ? engineCheck(
          'engine_bundle_approved',
          bundleOk,
          evidence === null
            ? 'nenhuma evidência de implantação aprovada para este escopo — o motor remoto não é admitido sem atestação'
            : 'bundle do motor remoto sem atestação de aprovação (id, digest e ator de aprovação são obrigatórios)',
          'Publique e APROVE o bundle do runtime remoto; a evidência é dado do backend, nunca input do modelo.',
          `bundle ${evidence?.bundle?.id ?? ''} atestado (${evidence?.evidence_class ?? ''})`,
        )
      : ENGINE_NOT_APPLICABLE('engine_bundle_approved'),
    requested
      ? engineCheck(
          'engine_data_policy_ready',
          dataPolicyOk,
          dataPolicy === null
            ? 'política de dados do piloto ausente para este escopo'
            : `política de dados não pronta: aprovada=${String(dataPolicy.approved)}, classes exigidas ausentes (${ENGINE_REQUIRED_DATA_POLICY_CLASSES.filter((c) => !dataPolicy.classes.includes(c)).join(', ') || 'nenhuma'})`,
          'Aprove a política de dados do piloto cobrindo as classes exigidas (§5.10.1) antes de admitir o motor remoto.',
          `política de dados ${dataPolicy?.policy_id ?? ''} pronta para as classes do piloto`,
        )
      : ENGINE_NOT_APPLICABLE('engine_data_policy_ready'),
    requested
      ? engineCheck(
          'engine_limits_configured',
          limitsOk,
          limits === null
            ? 'limites finitos do executor ausentes — nenhum default é inventado'
            : 'limites do executor precisam ser inteiros positivos (iterações, tokens por call e inferências)',
          'Aprove limites finitos versionados para este agente (agent_execution_limits). Ausência impede admissão.',
          'limites finitos aprovados',
        )
      : ENGINE_NOT_APPLICABLE('engine_limits_configured'),
    requested
      ? engineCheck(
          'engine_runtime_compatible',
          pinOk,
          pin === null
            ? 'pin de runtime ausente na evidência (sha do runtime, revisão do adaptador e protocolo)'
            : `pin de runtime incompatível com o adaptador em execução: adaptador=${pin.adapter_revision}/${engine.runtime.adapter_revision}, protocolo=${pin.protocol}/${engine.runtime.protocol}`,
          'Republicação do runtime exige evidência nova: o pin tem de casar com o adaptador e o protocolo deste build.',
          'pin de runtime compatível com este build',
        )
      : ENGINE_NOT_APPLICABLE('engine_runtime_compatible'),
    requested
      ? engineCheck(
          'engine_admission_open',
          !engine.kill_switch,
          'kill switch ativo: novas admissões do motor remoto estão bloqueadas (o motor local continua atendendo)',
          'Desligue MAIA_HERMES_KILL_SWITCH quando a condição que o acionou for resolvida. Turnos já pinados não mudam de motor.',
          'admissão do motor remoto aberta',
        )
      : ENGINE_NOT_APPLICABLE('engine_admission_open'),
  ];

  const available = checks.every((c) => c.status === 'pass');
  return {
    checks,
    projection: {
      requested,
      kill_switch: engine.kill_switch,
      evidence_class: evidence?.evidence_class ?? null,
      binding_revision: bindingRevision,
      evidence_revision: evidence?.revision ?? null,
      available,
      unavailable_reason: available ? null : dominantEngineReason(reasons),
    },
  };
}

/**
 * O AVALIADOR PURO. Sem I/O, sem relógio implícito (o `now` é injetado), sem
 * ALS. Todo teste de readiness — inclusive os de composição cruzada — roda
 * contra esta função.
 */
export function evaluateReadinessFacts(
  facts: ReadinessFacts,
  now: Date = new Date(),
): AgentReadiness {
  const req = facts.requested;
  const checks: ReadinessCheck[] = [];

  // (1) Tenant.
  const tenantOk = facts.tenant !== null && facts.tenant.id === req.tenant_id;
  checks.push(
    check(
      'tenant_exists',
      tenantOk,
      'blocking',
      'tenant não encontrado',
      'Crie o tenant pelo passo `provision_tenant` do wizard antes de configurar o agente.',
      'tenant encontrado',
    ),
  );
  checks.push(
    check(
      'tenant_enabled',
      tenantOk && facts.tenant!.status === 'active',
      'blocking',
      'tenant existe mas não está habilitado',
      'Reative o tenant no console (Tenants → Reativar) antes de ativar qualquer agente dele.',
      'tenant habilitado',
    ),
  );

  // (2) Agente. Os dois códigos continuam existindo (são contrato público:
  // label de métrica e chave de i18n), mas eles NÃO distinguem mais "não
  // existe" de "existe em outro tenant" — e isso é a correção, não uma perda.
  //
  // O loader lê `agents` pelo PAR completo, então um agente alheio nunca chega
  // até aqui; e o avaliador puro descarta, por `owns`, qualquer fato de escopo
  // errado que um caller injete. As duas mensagens são portanto IDÊNTICAS em
  // conteúdo informativo: tenant errado é indistinguível de ausência. Confirmar
  // a existência de um agente de outro tenant a quem tem o id é vazamento de
  // existência — o diagnóstico global vive em
  // `diagnoseAgentOwnershipGlobally` (só `founder`, auditado).
  const agentExists =
    facts.agent !== null &&
    facts.agent.id === req.agent_id &&
    facts.agent.tenant_id === req.tenant_id;
  checks.push(
    check(
      'agent_exists',
      agentExists,
      'blocking',
      'nenhum agente com este id neste (tenant, agente)',
      'Crie o agente pelo passo `provision_agent` do wizard.',
      'agente encontrado',
    ),
  );
  const agentInTenant = agentExists;
  checks.push(
    check(
      'agent_belongs_to_tenant',
      agentInTenant,
      'blocking',
      'nenhum agente com este id neste (tenant, agente)',
      'Verifique o par (tenant, agente): readiness NUNCA compõe recursos de escopos diferentes.',
      'agente pertence ao tenant',
    ),
  );

  // (3) Profile operacional ATIVO — e do escopo certo. `identity-slice-builder`
  // devolve `null` sem ele: a linha entraria em roteamento para responder sem
  // identidade operacional aprovada.
  const profile = facts.profile && owns(facts.profile, req) ? facts.profile : null;
  checks.push(
    check(
      'profile_active',
      profile !== null && profile.status === 'active',
      'blocking',
      'nenhum profile operacional ATIVO para este (tenant, agente)',
      'Aprove e ative uma versão do profile operacional (console → Identidades → Aprovar & ativar).',
      'profile operacional ativo',
    ),
  );

  // (4) Capability grant. Um agente sem linha em `agent_tool_grants` cai no
  // piso fail-closed no runtime — visível aqui em vez de só na primeira falha.
  const grant = facts.tool_grant && owns(facts.tool_grant, req) ? facts.tool_grant : null;
  checks.push(
    check(
      'capability_grant_present',
      grant !== null,
      'blocking',
      'agente sem concessão de capacidades (agent_tool_grants)',
      'Rode o passo `apply_capability_packs` do wizard para materializar a concessão do agente.',
      'concessão de capacidades presente',
    ),
  );

  const missingPacks = grant
    ? facts.required_packs.filter((p) => !grant.granted_packs.includes(p))
    : facts.required_packs;
  checks.push(
    check(
      'required_packs_granted',
      grant !== null && missingPacks.length === 0,
      'blocking',
      `packs obrigatórios ausentes: ${missingPacks.join(', ') || '(desconhecido)'}`,
      'Reaplique os packs de baseline no passo `apply_capability_packs`.',
      'packs obrigatórios concedidos',
    ),
  );

  // Coerência: uma tool não pode estar concedida E negada. O runtime resolve
  // isso fail-closed (negação vence), mas a configuração é contraditória e o
  // operador acha que concedeu algo que nunca aparece.
  const contradictory = grant
    ? grant.granted_tools.filter((t) => grant.denied_tools.includes(t))
    : [];
  checks.push(
    check(
      'tool_permissions_coherent',
      grant !== null && contradictory.length === 0,
      'blocking',
      `tools simultaneamente concedidas e negadas: ${contradictory.join(', ') || '(sem concessão)'}`,
      'Remova as tools conflitantes de `denied_tools` ou de `granted_tools` — a negação sempre vence no runtime.',
      'permissões de tools coerentes',
    ),
  );

  // (5) Papel padrão resolvido: ATIVO, default e do mesmo escopo.
  const scopedRoles = facts.roles.filter((r) => owns(r, req));
  const defaultRoles = scopedRoles.filter((r) => r.is_default && r.active);
  checks.push(
    check(
      'default_role_resolved',
      defaultRoles.length === 1,
      'blocking',
      defaultRoles.length === 0
        ? 'nenhum papel padrão ATIVO para este agente'
        : 'mais de um papel padrão ativo — a resolução seria ambígua',
      'Garanta exatamente UM papel com `is_default=true` e `active=true` (passo `configure_role`).',
      'papel padrão resolvido',
    ),
  );

  // (6) Canal. A sonda sintética (094) é excluída: ela existe para testar o
  // agente, e contá-la faria um agente sem NENHUMA linha real parecer pronto.
  const scopedChannels = facts.channels.filter((c) => owns(c, req) && !c.is_synthetic);
  checks.push(
    check(
      'channel_declared',
      scopedChannels.length > 0,
      'blocking',
      'nenhum canal declarado para este (tenant, agente)',
      'Declare a linha no passo `declare_channel` do wizard.',
      'canal declarado',
    ),
  );

  const scopedPolicies = facts.policies.filter((p) => owns(p, req));
  const activeRoleIds = new Set(scopedRoles.filter((r) => r.active).map((r) => r.id));

  // ─── A CONJUNÇÃO É POR CANAL (review adversarial do PR #541, achado 1) ─────
  //
  // O defeito anterior: `channel_policy_role_active` e `channel_ownership_proven`
  // eram dois `.some()` INDEPENDENTES sobre o conjunto de canais governados.
  // Dois canais do MESMO (tenant, agente) bastavam para pintar tudo de verde
  // sem que nenhum dos dois fosse operável:
  //
  //   canal A — política aponta para papel ATIVO, mas a linha nunca provou
  //             posse  ⇒ satisfaz `channel_policy_role_active`;
  //   canal B — linha `connected` (posse provada), mas a política aponta para
  //             papel INATIVO ⇒ satisfaz `channel_ownership_proven`.
  //
  // Os dois checks passavam, `ready` ficava `true`, e a ativação (que
  // selecionava canais só pela EXISTÊNCIA de política) ligava os dois: A
  // passava a rotear sem posse da linha e B com papel inválido. Era o mesmo
  // falso positivo por composição cruzada que este módulo existe para matar —
  // só que INTRA-agente, e por isso invisível para os testes cross-tenant e
  // cross-agent.
  //
  // Agora cada canal recebe um veredito PRÓPRIO e os checks agregados
  // perguntam "existe UM canal que satisfaz a conjunção inteira?".
  //
  // Note o `every` (e não `some`) em `policy_role_active`: hoje
  // `channel_policies` tem unique em `channel_id`, então há no máximo uma
  // política por canal e os dois quantificadores coincidem. `every` é a
  // escolha fail-closed para o dia em que esse unique mudar — um canal com uma
  // política válida e outra apontando para papel inativo é ambíguo, e ambíguo
  // não roteia.
  const channelVerdicts: ChannelVerdict[] = scopedChannels.map((c) => {
    const policies = scopedPolicies.filter((p) => p.channel_id === c.id);
    const policy_governed = policies.length > 0;
    const policy_role_active =
      policy_governed && policies.every((p) => activeRoleIds.has(p.default_role_id));
    const ownership_proven =
      c.line_state !== null &&
      (OWNERSHIP_PROVEN_LINE_STATES as readonly string[]).includes(c.line_state);
    const online = c.line_state === 'connected';
    const failed_checks: ReadinessCheckCode[] = [];
    if (!policy_governed) failed_checks.push('channel_policy_resolved');
    if (!policy_role_active) failed_checks.push('channel_policy_role_active');
    if (!ownership_proven) failed_checks.push('channel_ownership_proven');
    return {
      channel_id: c.id,
      policy_governed,
      policy_role_active,
      ownership_proven,
      online,
      activatable: policy_governed && policy_role_active && ownership_proven,
      failed_checks,
    };
  });

  const governedChannels = channelVerdicts.filter((v) => v.policy_governed);
  const roleOkChannels = governedChannels.filter((v) => v.policy_role_active);
  const activatableChannels = channelVerdicts.filter((v) => v.activatable);
  // Governados que ficaram de fora: a decisão de política é FAIL-CLOSED — eles
  // não são ativados, e a exclusão é dita em voz alta na mensagem do check e
  // em `AgentReadiness.channels`.
  const excludedGoverned = governedChannels.filter((v) => !v.activatable);
  const excludedNote =
    excludedGoverned.length > 0
      ? ` (${excludedGoverned.length} canal(is) governado(s) EXCLUÍDO(S) da ativação: ${excludedGoverned
          .map((v) => `${v.channel_id}[${v.failed_checks.join('+')}]`)
          .join(', ')})`
      : '';

  checks.push(
    check(
      'channel_policy_resolved',
      governedChannels.length > 0,
      'blocking',
      'nenhum canal deste agente tem channel_policy do mesmo escopo',
      'Crie a política do canal (o wizard a materializa junto com `declare_channel`).',
      `política de canal resolvida em ${governedChannels.length} canal(is)`,
    ),
  );

  checks.push(
    check(
      'channel_policy_role_active',
      roleOkChannels.length > 0,
      'blocking',
      'nenhum canal governado deste agente tem política apontando para um papel ATIVO',
      'Reative o papel padrão ou aponte a política para um papel ativo do mesmo (tenant, agente).',
      `papel padrão da política ativo em ${roleOkChannels.length} canal(is)`,
    ),
  );

  // (7) Posse da linha vs. estar online — dimensões distintas (#518).
  // POSSE provada é bloqueante: sem ela a linha não é do agente.
  // ONLINE é advisório: um socket caído é operacional e se recupera sozinho;
  // bloquear a ativação por causa dele impediria configurar fora do ar.
  //
  // Este é o check que FECHA a conjunção: ele não pergunta "alguma linha
  // governada provou posse?", mas "algum canal governado com papel ativo
  // provou posse?" — o mesmo canal, os três predicados.
  checks.push(
    check(
      'channel_ownership_proven',
      activatableChannels.length > 0,
      'blocking',
      `nenhum canal deste agente satisfaz política + papel ativo + posse provada AO MESMO TEMPO${excludedNote}`,
      'Conclua o pareamento da linha governada (passo `start_pairing` → `confirm_channel_ready`) e garanta que a política DELA aponte para um papel ativo.',
      `${activatableChannels.length} canal(is) integralmente válido(s)${excludedNote}`,
    ),
  );
  checks.push(
    check(
      'channel_online',
      activatableChannels.some((v) => v.online),
      'advisory',
      'nenhum canal integralmente válido está conectado no momento',
      'A linha reconecta sozinha; se persistir, use `repair` no console de linhas.',
      'linha conectada',
    ),
  );

  // (8) Schema pronto (#516). O VEREDITO CANÔNICO de `src/migrations/`, não uma
  // contagem de linhas do ledger: `dirty`, `failed`, `running`, checksum
  // divergente/desconhecido e arquivo ausente reprovam tanto quanto uma
  // migration pendente. Fail-closed também no `unknown` (o estado não pôde ser
  // apurado ⇒ não pronto).
  checks.push(
    check(
      'schema_ready',
      facts.schema.ready,
      'blocking',
      describeSchemaBlockage(facts.schema),
      'Rode `npm run db:migrate` (ou `npm run db:migrate -- status`) e resolva os bloqueadores antes de ativar o agente.',
      'schema verificado e compatível',
    ),
  );

  // (9) Governança sem pendência bloqueante.
  checks.push(
    check(
      'governance_no_blocking_pending',
      facts.blocking_governance_items === 0,
      'blocking',
      `${facts.blocking_governance_items} pendência(s) de governança bloqueante(s) em aberto`,
      'Resolva os alertas de drift críticos abertos deste agente antes de ativá-lo.',
      'sem pendência bloqueante de governança',
    ),
  );

  // (10) ADVISÓRIO por construção: readiness é a PRECONDIÇÃO da ativação, então
  // exigir `status='active'` aqui seria circular. O check existe para o doctor
  // distinguir "pronto e ativo" de "pronto, mas ainda não ativado".
  checks.push(
    check(
      'agent_activated',
      agentInTenant && facts.agent!.status === 'active',
      'advisory',
      'agente pronto porém ainda não ativado',
      'Rode o passo `activate` do wizard para ativar o agente explicitamente.',
      'agente ativado',
    ),
  );

  // (11) SC03 — o motor remoto. Os checks do deployment + a admissão. Sem
  // política que peça Hermes eles são não aplicáveis, e o relatório continua
  // idêntico ao de antes desta spec.
  const engine = evaluateEngineChecks(facts);
  checks.push(...engine.checks);

  const ready = checks.every((c) => c.severity !== 'blocking' || c.status === 'pass');

  return {
    tenant_id: req.tenant_id,
    agent_id: req.agent_id,
    ready,
    checks,
    engine: engine.projection,
    channels: channelVerdicts,
    // O conjunto que a ativação vai ligar — nada mais, nada menos. Ordenado
    // para que o veredito seja determinístico (ele é comparado, logado e
    // conferido contra o que a transação relê sob o lock).
    activatable_channel_ids: activatableChannels.map((v) => v.channel_id).sort(),
    evaluated_at: now.toISOString(),
    configuration_fingerprint: configurationFingerprint(facts),
    schema_fingerprint: schemaFingerprint(facts.schema),
  };
}

/**
 * A parte do motor remoto dentro da fingerprint de configuração. Só o que
 * GOVERNA a decisão: o pedido, o kill switch em vigor, o pin deste build, as
 * linhas de política (canal + motor + versão de CAS) e a revisão da evidência.
 * Nada de conteúdo de bundle nem de credencial.
 */
function engineProjectionForFingerprint(facts: ReadinessFacts): unknown {
  const engine = facts.engine ?? null;
  if (engine === null) return null;
  const req = facts.requested;
  return {
    requested: engine.requested,
    kill_switch: engine.kill_switch,
    runtime: {
      adapter_revision: engine.runtime.adapter_revision,
      protocol: engine.runtime.protocol,
    },
    policies: engine.policies
      .filter((p) => owns(p, req))
      .map((p) => ({ channel_id: p.channel_id, engine: p.engine, row_version: p.row_version }))
      .sort((a, b) => a.channel_id.localeCompare(b.channel_id)),
    evidence_class: engine.evidence?.evidence_class ?? null,
    evidence_revision: engine.evidence?.revision ?? null,
  };
}

/**
 * Projeção canônica da configuração governante. Deliberadamente NÃO inclui
 * `channels.external_id` (é o número de telefone da linha — PII, e o
 * fingerprint aparece em auditoria). Inclui o `id` do canal, que já identifica
 * a linha sem expor o número.
 */
export function configurationFingerprint(facts: ReadinessFacts): string {
  const req = facts.requested;
  const grant = facts.tool_grant && owns(facts.tool_grant, req) ? facts.tool_grant : null;
  const projection = {
    tenant: facts.tenant ? { id: facts.tenant.id, status: facts.tenant.status } : null,
    agent: facts.agent ? { id: facts.agent.id, status: facts.agent.status } : null,
    profile:
      facts.profile && owns(facts.profile, req)
        ? { version: facts.profile.version, status: facts.profile.status }
        : null,
    grant: grant
      ? {
          packs: [...grant.granted_packs].sort(),
          tools: [...grant.granted_tools].sort(),
          denied: [...grant.denied_tools].sort(),
        }
      : null,
    roles: facts.roles
      .filter((r) => owns(r, req))
      .map((r) => ({ id: r.id, key: r.role_key, active: r.active, is_default: r.is_default }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    channels: facts.channels
      .filter((c) => owns(c, req))
      .map((c) => ({
        id: c.id,
        type: c.channel_type,
        active: c.active,
        synthetic: c.is_synthetic,
        line_state: c.line_state,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    policies: facts.policies
      .filter((p) => owns(p, req))
      .map((p) => ({ id: p.id, channel_id: p.channel_id, default_role_id: p.default_role_id }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    required_packs: [...facts.required_packs].sort(),
    // SC03 — a POLÍTICA DE MOTOR entra na projeção: ligar/desligar Hermes num
    // canal, ou trocar o motor, muda a configuração que governa o agente. Sem
    // isto a fingerprint da auditoria seria idêntica antes e depois de um
    // agente passar a pedir o motor remoto — que é exatamente o fato que o
    // carimbo existe para registrar.
    engine: engineProjectionForFingerprint(facts),
  };
  return createHash('sha256').update(canonicalJson(projection), 'utf8').digest('hex');
}

/**
 * Fingerprint do SCHEMA VERIFICADO.
 *
 * Inclui o veredito, os heads e o par (estado, checksum) de cada migration —
 * NÃO a lista de ids. A versão anterior hasheava só os ids "aplicados", e por
 * isso produzia o MESMO valor para um schema íntegro e para um schema com
 * migration `dirty`, checksum divergente ou arquivo ausente: o carimbo que a
 * ativação grava na auditoria não distinguia os dois casos que ele existe para
 * distinguir.
 */
export function schemaFingerprint(
  schema: Pick<SchemaFacts, 'state' | 'expected_head' | 'applied_head' | 'verified'>,
): string {
  const projection = {
    state: schema.state,
    expected_head: schema.expected_head,
    applied_head: schema.applied_head,
    verified: [...schema.verified]
      .map((e) => ({ id: e.id, state: e.state, checksum: e.checksum }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash('sha256').update(canonicalJson(projection), 'utf8').digest('hex');
}

/** Porta de carregamento dos fatos — injetável para teste sem banco. */
export type ReadinessFactsLoader = (scope: {
  tenant_id: string;
  agent_id: string;
}) => Promise<ReadinessFacts>;

// ─── SC03: as portas do motor remoto ─────────────────────────────────────────

/**
 * Porta das LINHAS DE POLÍTICA (`agent_engine_policies`, 145) do escopo.
 *
 * Escopo EXPLÍCITO, não ALS — pelo mesmo motivo do loader de fatos: aqui se
 * avalia um par ARBITRÁRIO (a ativação de uma run, o doctor, o console), que
 * não é o par sob o qual o processo está rodando.
 *
 * Falha de leitura SOBE (nunca vira "sem linha"): um banco quebrado não pode
 * fazer um agente que pede o motor remoto parecer um agente sem pedido.
 */
export type EnginePolicyLoader = (
  scope: { tenant_id: string; agent_id: string },
) => Promise<readonly EnginePolicyBindingFactV1[]>;

/** Porta da EVIDÊNCIA de implantação do §9.4. `null` = não há atestação. */
export type EngineEvidenceLoader = (
  scope: { tenant_id: string; agent_id: string },
) => Promise<EngineDeploymentEvidenceV1 | null>;

/**
 * A porta default HOJE: nenhuma atestação de implantação existe neste
 * repositório. Não é um "modo degradado" — é o portão FECHADO do §9.4, e o
 * efeito é que qualquer agente que peça o motor remoto fica não-pronto até que
 * um atestador aprovado seja instalado. O harness SINTÉTICO é a evidência que
 * os testes injetam (SC03-AC03), e ele não configura produção.
 */
export const NO_ENGINE_DEPLOYMENT_EVIDENCE: EngineEvidenceLoader = async () => null;

/**
 * O que este build considera o adaptador/protocolo em execução. Import tardio
 * para não arrastar o motor (nem o grafo de histórico) para dentro de quem só
 * quer o avaliador puro.
 */
async function defaultEngineRuntime(): Promise<EngineRuntimeFactsV1> {
  const engine = await import('@/runtime/engines/hermes-engine.js');
  const protocol = await import('@/integrations/hermes/protocol.js');
  return {
    adapter_revision: engine.HERMES_ENGINE_ADAPTER_REVISION,
    protocol: protocol.HERMES_WORKER_PROTOCOL_VERSION,
  };
}

/** O kill switch EFETIVO do processo — a mesma porta que o seletor consulta. */
async function defaultKillSwitch(): Promise<boolean> {
  const { contractEnv } = await import('@/config/contract-env.js');
  return contractEnv.MAIA_HERMES_KILL_SWITCH;
}

export type AgentReadinessDeps = {
  loadFacts?: ReadinessFactsLoader;
  /** Default: leitura por `db` das linhas de política do escopo. */
  loadEnginePolicies?: EnginePolicyLoader;
  /** Default: `NO_ENGINE_DEPLOYMENT_EVIDENCE` (portão fechado). */
  loadEngineEvidence?: EngineEvidenceLoader;
  /** Default: o adaptador/protocolo deste build. */
  engineRuntime?: EngineRuntimeFactsV1;
  /** Default: `MAIA_HERMES_KILL_SWITCH` da configuração efetiva. */
  killSwitch?: () => Promise<boolean> | boolean;
  now?: Date;
};

/** `true` ⟺ alguma linha do escopo pede o motor remoto. */
export function engineRequestedBy(
  policies: readonly EnginePolicyBindingFactV1[],
  scope: { tenant_id: string; agent_id: string },
): boolean {
  return policies.filter((p) => owns(p, scope)).some((p) => p.engine === 'hermes');
}

/**
 * A API PÚBLICA consumida por #517 (doctor), pela ativação, pelo dashboard e
 * pelo checklist. Valida o escopo fail-closed, carrega os fatos e delega ao
 * avaliador puro.
 *
 * ─── SC03: o que muda aqui ──────────────────────────────────────────────────
 *
 *  1. as LINHAS DE POLÍTICA são lidas para o escopo (e uma falha de leitura
 *     sobe). É delas que sai "este agente pede o motor remoto?";
 *  2. a EVIDÊNCIA de implantação é consultada SÓ quando o motor remoto é
 *     pedido. Desabilitado não consulta worker nem credencial (SC03-AC02) — e
 *     o teste prova isso com uma porta que explode se for chamada;
 *  3. o par (requested, policies) vai para o avaliador puro, que o confronta.
 *
 * @throws OnboardingError('invalid_scope' | 'forbidden_scope_literal')
 */
export async function evaluateAgentReadiness(
  scope: { tenant_id: string; agent_id: string },
  deps?: AgentReadinessDeps,
): Promise<AgentReadiness> {
  assertProvisioningScope(scope);
  const loadFacts =
    deps?.loadFacts ??
    // Import tardio: mantém o avaliador puro importável (doctor, testes,
    // ferramentas) sem arrastar o pool do Postgres junto.
    (await import('./readiness-facts.js')).loadReadinessFactsFromDb;
  const loadPolicies =
    deps?.loadEnginePolicies ??
    (await import('@/db/repositories/engine-policy-repos.js')).loadEnginePolicyBindingsFromDb;
  const loadEvidence = deps?.loadEngineEvidence ?? NO_ENGINE_DEPLOYMENT_EVIDENCE;

  const requestedScope = { tenant_id: scope.tenant_id, agent_id: scope.agent_id };
  const [facts, policies] = await Promise.all([loadFacts(requestedScope), loadPolicies(requestedScope)]);
  const requested = engineRequestedBy(policies, requestedScope);
  const evidence = requested ? await loadEvidence(requestedScope) : null;
  const runtime = deps?.engineRuntime ?? (requested ? await defaultEngineRuntime() : null);
  // SC03-AC02 — sem pedido, o kill switch NÃO é consultado: a configuração do
  // motor remoto não é lida para um agente que não usa o motor remoto. Com
  // pedido, a porta injetada vence o default.
  const killSwitch = requested
    ? deps?.killSwitch
      ? await deps.killSwitch()
      : await defaultKillSwitch()
    : false;

  return evaluateReadinessFacts(
    {
      ...facts,
      engine: {
        requested,
        policies,
        kill_switch: killSwitch === true,
        // Sem pedido, o pin deste build não é lido: não há pergunta de
        // compatibilidade a responder, e a leitura do motor seria trabalho
        // pago por um agente que não usa o motor remoto.
        runtime: runtime ?? { adapter_revision: '', protocol: '' },
        evidence,
      },
    },
    deps?.now,
  );
}

export type EngineRevalidationResult =
  | { ok: true }
  | { ok: false; code: 'engine_readiness_stale'; message: string };

/**
 * SC03 — REVALIDAÇÃO sob CAS, no momento da ativação.
 *
 * O que ela responde: "o retrato que autorizou a ativação ainda é o retrato do
 * backend?". Duas comparações, ambas contra o que o relatório carregou:
 *
 *  - `binding_revision` (das linhas de política, 145) — relida pela porta do
 *    chamador, que na ativação é o MESMO `tx` da escrita;
 *  - `evidence_revision` (da evidência de implantação) — relida pela porta.
 *
 * Discorda em qualquer das duas ⇒ recusa, com motivo fechado e SEM escrever
 * nada: nenhuma admissão nova nasce de um retrato velho.
 *
 * Nada é consultado quando o agente NÃO pede o motor remoto — a revalidação de
 * um agente local não chama o atestador (SC03-AC02).
 */
export async function revalidateEngineReadiness(input: {
  expected: EngineReadinessProjection | null;
  scope: { tenant_id: string; agent_id: string };
  loadEnginePolicies: EnginePolicyLoader;
  loadEngineEvidence: EngineEvidenceLoader;
}): Promise<EngineRevalidationResult> {
  const expected = input.expected;
  // `!expected` e não `expected === null`: um relatório INJETADO (testes,
  // replay antigo) pode não trazer a projeção. Ausência dela significa
  // "nenhum pedido de motor remoto observado", e nesse caso não há nada a
  // revalidar — e nada é consultado.
  if (!expected || !expected.requested) return { ok: true };

  const policies = await input.loadEnginePolicies(input.scope);
  const bindingRevision = engineBindingRevision(policies, input.scope);
  if (bindingRevision !== expected.binding_revision) {
    return {
      ok: false,
      code: 'engine_readiness_stale',
      message:
        'a política de motor do agente mudou entre o check e a ativação — reavalie o readiness antes de ativar',
    };
  }

  const evidence = await input.loadEngineEvidence(input.scope);
  if ((evidence?.revision ?? null) !== expected.evidence_revision) {
    return {
      ok: false,
      code: 'engine_readiness_stale',
      message:
        'a evidência de implantação do motor remoto mudou entre o check e a ativação — reavalie o readiness antes de ativar',
    };
  }

  return { ok: true };
}

/** Só os checks bloqueantes que falharam — o que a ativação e o doctor listam. */
export function blockingFailures(readiness: AgentReadiness): ReadinessCheck[] {
  return readiness.checks.filter((c) => c.severity === 'blocking' && c.status === 'fail');
}
