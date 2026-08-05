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
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './idempotency.js';
import { assertProvisioningScope } from './scope.js';

export type ReadinessCheckStatus = 'pass' | 'fail';
export type ReadinessSeverity = 'blocking' | 'advisory';

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

export type AgentReadiness = {
  tenant_id: string;
  agent_id: string;
  /** `true` ⟺ TODO check `blocking` está `pass`. Advisórios não bloqueiam. */
  ready: boolean;
  checks: ReadinessCheck[];
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
  // Um canal é "governado" quando existe política DO MESMO escopo apontando
  // para ele. Cruzar canal de um agente com política de outro é precisamente o
  // falso positivo que a issue descreve.
  const governedChannels = scopedChannels.filter((c) =>
    scopedPolicies.some((p) => p.channel_id === c.id),
  );
  checks.push(
    check(
      'channel_policy_resolved',
      governedChannels.length > 0,
      'blocking',
      'nenhum canal deste agente tem channel_policy do mesmo escopo',
      'Crie a política do canal (o wizard a materializa junto com `declare_channel`).',
      'política de canal resolvida',
    ),
  );

  const activeRoleIds = new Set(scopedRoles.filter((r) => r.active).map((r) => r.id));
  const policyRoleOk = governedChannels.some((c) =>
    scopedPolicies.some((p) => p.channel_id === c.id && activeRoleIds.has(p.default_role_id)),
  );
  checks.push(
    check(
      'channel_policy_role_active',
      policyRoleOk,
      'blocking',
      'o `default_role_id` da política não resolve para um papel ATIVO deste agente',
      'Reative o papel padrão ou aponte a política para um papel ativo do mesmo (tenant, agente).',
      'papel padrão da política ativo',
    ),
  );

  // (7) Posse da linha vs. estar online — dimensões distintas (#518).
  // POSSE provada é bloqueante: sem ela a linha não é do agente.
  // ONLINE é advisório: um socket caído é operacional e se recupera sozinho;
  // bloquear a ativação por causa dele impediria configurar fora do ar.
  const ownershipProven = governedChannels.some(
    (c) => c.line_state !== null && (OWNERSHIP_PROVEN_LINE_STATES as readonly string[]).includes(c.line_state),
  );
  checks.push(
    check(
      'channel_ownership_proven',
      ownershipProven,
      'blocking',
      'nenhuma linha governada deste agente provou posse (pareamento não concluído)',
      'Conclua o pareamento da linha (passo `start_pairing` → `confirm_channel_ready`).',
      'posse da linha provada',
    ),
  );
  checks.push(
    check(
      'channel_online',
      governedChannels.some((c) => c.line_state === 'connected'),
      'advisory',
      'nenhuma linha governada está conectada no momento',
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

  const ready = checks.every((c) => c.severity !== 'blocking' || c.status === 'pass');

  return {
    tenant_id: req.tenant_id,
    agent_id: req.agent_id,
    ready,
    checks,
    evaluated_at: now.toISOString(),
    configuration_fingerprint: configurationFingerprint(facts),
    schema_fingerprint: schemaFingerprint(facts.schema),
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
    profile: facts.profile && owns(facts.profile, req)
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

/**
 * A API PÚBLICA consumida por #517 (doctor), pela ativação, pelo dashboard e
 * pelo checklist. Valida o escopo fail-closed, carrega os fatos e delega ao
 * avaliador puro.
 *
 * @throws OnboardingError('invalid_scope' | 'forbidden_scope_literal')
 */
export async function evaluateAgentReadiness(
  scope: { tenant_id: string; agent_id: string },
  deps?: { loadFacts?: ReadinessFactsLoader; now?: Date },
): Promise<AgentReadiness> {
  assertProvisioningScope(scope);
  const loadFacts =
    deps?.loadFacts ??
    // Import tardio: mantém o avaliador puro importável (doctor, testes,
    // ferramentas) sem arrastar o pool do Postgres junto.
    (await import('./readiness-facts.js')).loadReadinessFactsFromDb;
  const facts = await loadFacts({ tenant_id: scope.tenant_id, agent_id: scope.agent_id });
  return evaluateReadinessFacts(facts, deps?.now);
}

/** Só os checks bloqueantes que falharam — o que a ativação e o doctor listam. */
export function blockingFailures(readiness: AgentReadiness): ReadinessCheck[] {
  return readiness.checks.filter((c) => c.severity === 'blocking' && c.status === 'fail');
}
