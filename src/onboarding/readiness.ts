/**
 * Issue #519 §5 — READINESS CANÔNICO por `tenant_id + agent_id`.
 *
 * O problema que isto resolve é o falso positivo de "go live". Antes existiam
 * três respostas diferentes para "o agente está pronto?":
 *
 *   - o dashboard somava sinais GLOBAIS (existe algum profile ativo? existe
 *     algum canal?), sem provar que os dois eram do MESMO agente — o profile do
 *     agente A mais o canal do agente B deixavam os dois "prontos";
 *   - o go-live checklist do console olhava três pré-condições por agente;
 *   - `evaluateLineReadiness` (#518) olhava as pré-condições da LINHA.
 *
 * Este módulo é a resposta única. Wizard, dashboard, checklist, ativação e
 * observabilidade passam a perguntar aqui. A regra de ouro da issue: **é
 * proibido compor readiness com recursos de agentes diferentes** — toda
 * consulta abaixo carrega o par (tenant, agent), e o que vem do banco é
 * reconferido contra o escopo pedido antes de contar como evidência.
 *
 * O que este módulo NÃO faz: decidir. Ele produz um laudo tipado. Quem ativa é
 * `service.ts`, dentro da transição atômica, e reavaliando — porque um laudo
 * lido há 30 segundos não é prova de nada no instante do commit.
 */
import { createHash } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { CONTRACT_VERSION } from '@/config/contract.js';
import {
  tenantsRepo,
  agentsRepo,
  operationalProfileVersionsRepo,
  rolesRepo,
  channelPoliciesRepo,
  agentToolGrantsRepo,
  channelLineStateRepo,
} from '@/db/repositories.js';
import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';

/** Severidade de um check. Só `blocking` impede a ativação. */
export type ReadinessSeverity = 'blocking' | 'advisory';

export type ReadinessStatus = 'pass' | 'fail' | 'skipped';

/**
 * Códigos ESTÁVEIS. São contrato público: aparecem em métrica
 * (`agent_readiness_failed_total{check_code}`), em runbook e na UI. Renomear um
 * código é uma quebra — adicione um novo em vez de reaproveitar.
 */
export const READINESS_CHECK_CODES = [
  'tenant_exists',
  'tenant_active',
  'agent_exists',
  'agent_in_tenant',
  'agent_profile_active',
  'agent_tool_grant',
  'default_role_active',
  'whatsapp_line_declared',
  'whatsapp_line_scope',
  'whatsapp_line_verified',
  'channel_policy_resolved',
  'channel_routing_active',
  'schema_applied',
  'configuration_contract',
] as const;
export type ReadinessCheckCode = (typeof READINESS_CHECK_CODES)[number];

export interface ReadinessCheck {
  code: ReadinessCheckCode;
  status: ReadinessStatus;
  severity: ReadinessSeverity;
  /** Mensagem SANITIZADA em pt-BR — nunca erro cru, nunca dado pessoal. */
  message: string;
  /** O que o operador deve fazer. Vazio quando o check passou. */
  remediation: string | null;
}

export interface AgentReadiness {
  tenant_id: string;
  agent_id: string;
  ready: boolean;
  checks: ReadinessCheck[];
  evaluated_at: Date;
  /**
   * Impressão digital da CONFIGURAÇÃO resolvida deste agente (perfil ativo,
   * packs, papel padrão, política, canal). Muda quando qualquer peça muda — é
   * o que permite gravar na auditoria de ativação exatamente O QUE foi
   * aprovado, e detectar que a configuração mudou depois.
   */
  configuration_fingerprint: string;
  /** Impressão digital do conjunto de migrations aplicadas. */
  schema_fingerprint: string;
}

// ---------------------------------------------------------------------------
// Injeção de dependências (mesmo precedente de `auth-resolver.ts`)
// ---------------------------------------------------------------------------

export interface ReadinessDeps {
  tenantsRepo: Pick<typeof tenantsRepo, 'findById'>;
  agentsRepo: Pick<typeof agentsRepo, 'findById'>;
  operationalProfileVersionsRepo: Pick<typeof operationalProfileVersionsRepo, 'getActive'>;
  rolesRepo: Pick<typeof rolesRepo, 'getDefault'>;
  channelPoliciesRepo: Pick<typeof channelPoliciesRepo, 'getByChannelId'>;
  agentToolGrantsRepo: Pick<typeof agentToolGrantsRepo, 'findForCurrentAgent'>;
  channelLineStateRepo: Pick<typeof channelLineStateRepo, 'listLinesForScope'>;
  /** Ids das migrations aplicadas. Injetável para o teste não precisar de DB. */
  appliedMigrations: () => Promise<string[]>;
  /** Wrapper de contexto — sobrescrito no teste por um passthrough. */
  withScope: <T>(scope: { tenant_id: string; agent_id: string }, fn: () => Promise<T>) => Promise<T>;
}

/**
 * Lista as migrations aplicadas (`schema_migrations`, criada por
 * `scripts/migrate.ts`). Se a tabela não existir, devolvemos vazio e o check
 * `schema_applied` FALHA — fail-closed: um banco sem controle de schema não é
 * um banco pronto para ativar um agente.
 *
 * MEMOIZADO com TTL curto: o conjunto de migrations só muda num deploy, e o
 * laudo é reavaliado a cada poll da tela do wizard (5s). Sem o memo, cada
 * render pagaria uma varredura da tabela inteira por nada. O TTL, em vez de um
 * cache eterno, faz um processo de longa vida enxergar uma migration aplicada
 * por fora sem exigir restart.
 */
const MIGRATIONS_CACHE_MS = 30_000;
let migrationsCache: { at: number; ids: string[] } | null = null;

async function readAppliedMigrations(): Promise<string[]> {
  const now = Date.now();
  if (migrationsCache && now - migrationsCache.at < MIGRATIONS_CACHE_MS) {
    return migrationsCache.ids;
  }
  try {
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM schema_migrations ORDER BY id`,
    );
    const list =
      (rows as unknown as { rows?: Array<{ id: string }> }).rows ??
      (rows as unknown as Array<{ id: string }>);
    const ids = list.map((r) => r.id);
    migrationsCache = { at: now, ids };
    return ids;
  } catch {
    // NÃO memoiza a falha: um erro transitório de conexão não pode congelar o
    // laudo em "schema ausente" por 30 segundos.
    return [];
  }
}

/** Test seam: descarta o memo entre specs. */
export function _resetMigrationsCacheForTests(): void {
  migrationsCache = null;
}

const DEFAULT_DEPS: ReadinessDeps = {
  tenantsRepo,
  agentsRepo,
  operationalProfileVersionsRepo,
  rolesRepo,
  channelPoliciesRepo,
  agentToolGrantsRepo,
  channelLineStateRepo,
  appliedMigrations: readAppliedMigrations,
  withScope: (scope, fn) => runWithTenantContext(scope, fn),
};

// ---------------------------------------------------------------------------

function pass(code: ReadinessCheckCode, message: string, severity: ReadinessSeverity = 'blocking'): ReadinessCheck {
  return { code, status: 'pass', severity, message, remediation: null };
}

function fail(
  code: ReadinessCheckCode,
  message: string,
  remediation: string,
  severity: ReadinessSeverity = 'blocking',
): ReadinessCheck {
  return { code, status: 'fail', severity, message, remediation };
}

function skipped(code: ReadinessCheckCode, message: string, severity: ReadinessSeverity = 'blocking'): ReadinessCheck {
  return { code, status: 'skipped', severity, message, remediation: 'Resolva os checks anteriores primeiro.' };
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * O readiness canônico.
 *
 * Ordem deliberada — do escopo para dentro. Cada camada só é consultada se a
 * anterior provou o vínculo: perguntar pelo perfil de um agente que não
 * pertence ao tenant já seria compor readiness com recurso alheio.
 */
export async function evaluateAgentReadiness(
  tenantId: string,
  agentId: string,
  deps: ReadinessDeps = DEFAULT_DEPS,
): Promise<AgentReadiness> {
  const checks: ReadinessCheck[] = [];
  const evaluated_at = new Date();

  // Peças da configuração que compõem o fingerprint. Só é preenchido com o que
  // FOI PROVADO pertencer ao par — nunca com o que "existia por aí".
  const fingerprintParts: Record<string, string | null> = {
    contract_version: CONTRACT_VERSION,
    tenant_id: tenantId,
    agent_id: agentId,
    profile_version_id: null,
    granted_packs: null,
    default_role_id: null,
    channel_id: null,
    channel_policy_id: null,
  };

  const migrations = await deps.appliedMigrations();
  const schema_fingerprint = sha256(migrations.join('\n'));
  checks.push(
    migrations.length > 0
      ? pass('schema_applied', `${migrations.length} migrations aplicadas.`)
      : fail(
          'schema_applied',
          'Não foi possível confirmar o schema aplicado (tabela schema_migrations ausente ou vazia).',
          'Rode `npm run db:migrate` contra este banco antes de ativar qualquer agente.',
        ),
  );

  // O contrato de configuração (#515) já falha fechado no boot; aqui só
  // registramos a versão vigente para o laudo ser auto-contido.
  checks.push(
    pass('configuration_contract', `Contrato de configuração ${CONTRACT_VERSION} carregado.`),
  );

  // ── escopo ────────────────────────────────────────────────────────────────
  const tenant = await deps.tenantsRepo.findById(tenantId);
  if (!tenant) {
    checks.push(
      fail(
        'tenant_exists',
        'Tenant não encontrado.',
        'Verifique o tenant selecionado — a run aponta para um tenant que não existe.',
      ),
    );
    return finalize(tenantId, agentId, checks, evaluated_at, fingerprintParts, schema_fingerprint, [
      'tenant_active',
      'agent_exists',
      'agent_in_tenant',
      'agent_profile_active',
      'agent_tool_grant',
      'default_role_active',
      'whatsapp_line_declared',
      'whatsapp_line_scope',
      'whatsapp_line_verified',
      'channel_policy_resolved',
      'channel_routing_active',
    ]);
  }
  checks.push(pass('tenant_exists', `Tenant '${tenant.id}' existe.`));
  checks.push(
    tenant.status === 'active'
      ? pass('tenant_active', 'Tenant habilitado.')
      : fail(
          'tenant_active',
          `Tenant está '${tenant.status}'.`,
          'Reative o tenant antes de colocar o agente no ar.',
        ),
  );

  const agent = await deps.agentsRepo.findById(agentId);
  if (!agent) {
    checks.push(
      fail('agent_exists', 'Agente não encontrado.', 'Conclua o passo de criação do agente.'),
    );
    return finalize(tenantId, agentId, checks, evaluated_at, fingerprintParts, schema_fingerprint, [
      'agent_in_tenant',
      'agent_profile_active',
      'agent_tool_grant',
      'default_role_active',
      'whatsapp_line_declared',
      'whatsapp_line_scope',
      'whatsapp_line_verified',
      'channel_policy_resolved',
      'channel_routing_active',
    ]);
  }
  checks.push(pass('agent_exists', `Agente '${agent.id}' existe.`));

  // O check que impede a composição cruzada. `agentsRepo.findById` é lookup por
  // PK (cross-tenant por construção — a tabela `agents` é a âncora do grafo);
  // lookup NÃO é autorização, então o vínculo é provado aqui, explicitamente.
  if (agent.tenant_id !== tenantId) {
    checks.push(
      fail(
        'agent_in_tenant',
        'O agente pertence a outro tenant.',
        'Não é possível compor readiness com recursos de tenants diferentes. Selecione o agente correto.',
      ),
    );
    return finalize(tenantId, agentId, checks, evaluated_at, fingerprintParts, schema_fingerprint, [
      'agent_profile_active',
      'agent_tool_grant',
      'default_role_active',
      'whatsapp_line_declared',
      'whatsapp_line_scope',
      'whatsapp_line_verified',
      'channel_policy_resolved',
      'channel_routing_active',
    ]);
  }
  checks.push(pass('agent_in_tenant', 'Agente pertence ao tenant avaliado.'));

  // ── configuração do agente (tudo sob o ALS do par) ────────────────────────
  const inner = await deps.withScope({ tenant_id: tenantId, agent_id: agentId }, async () => {
    const profile = await deps.operationalProfileVersionsRepo.getActive();
    const grant = await deps.agentToolGrantsRepo.findForCurrentAgent();
    const defaultRole = await deps.rolesRepo.getDefault();
    return { profile, grant, defaultRole };
  });

  if (inner.profile && inner.profile.status === 'active') {
    fingerprintParts.profile_version_id = inner.profile.id;
    checks.push(pass('agent_profile_active', `Perfil operacional v${inner.profile.version} ativo.`));
  } else {
    checks.push(
      fail(
        'agent_profile_active',
        'O agente não tem perfil operacional ativo.',
        'Aprove a versão proposta do perfil (Inbox → Perfis). Sem perfil ativo o agente não tem identidade operacional e não responde.',
      ),
    );
  }

  const packs = (inner.grant?.granted_packs ?? []) as string[];
  if (inner.grant && packs.length > 0) {
    fingerprintParts.granted_packs = [...packs].sort().join(',');
    checks.push(pass('agent_tool_grant', `${packs.length} pack(s) concedido(s).`));
  } else {
    checks.push(
      fail(
        'agent_tool_grant',
        'O agente não tem concessão de ferramentas registrada.',
        'Aplique os capability packs do agente — sem concessão o runtime fecha para zero ferramentas.',
      ),
    );
  }

  if (inner.defaultRole && inner.defaultRole.active) {
    fingerprintParts.default_role_id = inner.defaultRole.id;
    checks.push(pass('default_role_active', `Papel padrão '${inner.defaultRole.role_key}' ativo.`));
  } else {
    checks.push(
      fail(
        'default_role_active',
        inner.defaultRole
          ? 'O papel padrão do agente está desativado.'
          : 'O agente não tem papel padrão.',
        'Crie (ou reative) o papel padrão do agente — a política de canal precisa nomear um papel ativo.',
      ),
    );
  }

  // ── linha WhatsApp ────────────────────────────────────────────────────────
  const lines = await deps.channelLineStateRepo.listLinesForScope({
    tenant_id: tenantId,
    agent_id: agentId,
  });
  // Sonda sintética (094) nunca conta como linha de produção.
  const whatsapp = lines.filter((l) => l.channel_type === 'whatsapp' && !l.is_synthetic);

  if (whatsapp.length === 0) {
    checks.push(
      fail(
        'whatsapp_line_declared',
        'Nenhuma linha WhatsApp declarada para este agente.',
        'Declare a linha (formato E.164 com "+") no passo de canal.',
      ),
    );
    for (const code of [
      'whatsapp_line_scope',
      'whatsapp_line_verified',
      'channel_policy_resolved',
      'channel_routing_active',
    ] as const) {
      checks.push(skipped(code, 'Depende de uma linha declarada.', code === 'channel_routing_active' ? 'advisory' : 'blocking'));
    }
    return finalize(tenantId, agentId, checks, evaluated_at, fingerprintParts, schema_fingerprint, []);
  }
  checks.push(pass('whatsapp_line_declared', `${whatsapp.length} linha(s) WhatsApp declarada(s).`));

  // Defesa em profundidade: `listLinesForScope` já filtra pelo par, mas o laudo
  // não confia na consulta — ele reconfere cada row. Uma row fora do escopo
  // aqui significa bug de repo, e o laudo tem de recusar, não normalizar.
  const foreign = whatsapp.filter((l) => l.tenant_id !== tenantId || l.agent_id !== agentId);
  if (foreign.length > 0) {
    checks.push(
      fail(
        'whatsapp_line_scope',
        'Há linha fora do escopo (tenant/agente) na listagem.',
        'Falha de integridade — não ative. Abra um incidente com o correlation id desta run.',
      ),
    );
    return finalize(tenantId, agentId, checks, evaluated_at, fingerprintParts, schema_fingerprint, [
      'whatsapp_line_verified',
      'channel_policy_resolved',
      'channel_routing_active',
    ]);
  }
  checks.push(pass('whatsapp_line_scope', 'Todas as linhas pertencem a este tenant/agente.'));

  // POSSE PROVADA. `verified_at` (#518) é o que distingue "alguém digitou um
  // número" de "o WhatsApp desta linha confirmou o pareamento". Digitar o
  // número nunca dá posse.
  const verified = whatsapp.filter((l) => l.verified_at !== null);
  if (verified.length === 0) {
    checks.push(
      fail(
        'whatsapp_line_verified',
        'Nenhuma linha teve a posse provada por pareamento.',
        'Conclua o pareamento (QR ou código de 8 dígitos) da linha declarada.',
      ),
    );
  } else {
    checks.push(
      pass('whatsapp_line_verified', `${verified.length} linha(s) com posse provada.`),
    );
  }

  // A linha que sustenta o laudo é a verificada mais antiga (determinístico);
  // se nenhuma está verificada, avaliamos a política da primeira declarada
  // para que o operador veja os DOIS problemas de uma vez, em vez de descobrir
  // o segundo só depois de resolver o primeiro.
  const subject = verified[0] ?? whatsapp[0]!;
  fingerprintParts.channel_id = subject.channel_id;

  const policy = await deps.withScope(
    { tenant_id: tenantId, agent_id: agentId },
    async () => deps.channelPoliciesRepo.getByChannelId(subject.channel_id),
  );
  if (!policy) {
    checks.push(
      fail(
        'channel_policy_resolved',
        'A linha não tem política de canal.',
        'Configure a política do canal apontando para o papel padrão do agente.',
      ),
    );
  } else if (
    fingerprintParts.default_role_id === null ||
    policy.default_role_id !== fingerprintParts.default_role_id
  ) {
    // O papel nomeado pela política tem de ser um papel ATIVO deste agente. Um
    // `default_role_id` apontando para papel de outro agente (ou desativado) é
    // política que existe e não resolve — o caso sutil que `has_policy` não
    // pega.
    checks.push(
      fail(
        'channel_policy_resolved',
        'A política do canal aponta para um papel que não é o papel padrão ativo deste agente.',
        'Atualize a política para o papel padrão ativo do agente.',
      ),
    );
  } else {
    fingerprintParts.channel_policy_id = policy.id;
    checks.push(pass('channel_policy_resolved', 'Política do canal resolvida para papel ativo.'));
  }

  // Roteamento. NÃO é bloqueante: a #518 revalida periodicamente e ativa o
  // canal sozinho assim que a política fica pronta — travar a ativação do
  // AGENTE nisto criaria um deadlock entre dois gates que esperam um ao outro.
  checks.push(
    subject.active
      ? pass('channel_routing_active', 'Linha roteando.', 'advisory')
      : fail(
          'channel_routing_active',
          'A linha ainda não está roteando.',
          'O backend ativa o roteamento sozinho quando a política fica pronta (revalidação periódica). Nenhuma ação necessária.',
          'advisory',
        ),
  );

  return finalize(tenantId, agentId, checks, evaluated_at, fingerprintParts, schema_fingerprint, []);
}

function finalize(
  tenant_id: string,
  agent_id: string,
  checks: ReadinessCheck[],
  evaluated_at: Date,
  fingerprintParts: Record<string, string | null>,
  schema_fingerprint: string,
  skippedCodes: readonly ReadinessCheckCode[],
): AgentReadiness {
  for (const code of skippedCodes) {
    checks.push(
      skipped(
        code,
        'Não avaliado: um check anterior bloqueou.',
        code === 'channel_routing_active' ? 'advisory' : 'blocking',
      ),
    );
  }
  const ready = checks.every((c) => c.severity !== 'blocking' || c.status === 'pass');
  return {
    tenant_id,
    agent_id,
    ready,
    checks,
    evaluated_at,
    configuration_fingerprint: sha256(
      Object.entries(fingerprintParts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v ?? ''}`)
        .join('|'),
    ),
    schema_fingerprint,
  };
}

/** Códigos bloqueantes que falharam — o que a ativação recusa e a métrica conta. */
export function blockingFailures(readiness: AgentReadiness): ReadinessCheckCode[] {
  return readiness.checks
    .filter((c) => c.severity === 'blocking' && c.status !== 'pass')
    .map((c) => c.code);
}
