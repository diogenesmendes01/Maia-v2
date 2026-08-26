/**
 * Issue #519 §5 — o LOADER dos fatos de readiness. Toda a lógica de decisão
 * vive em `readiness.ts` (pura); aqui só existe I/O.
 *
 * Três escolhas deliberadas:
 *
 * 1. **Escopo EXPLÍCITO, não ALS.** Os repos tenant-scoped leem o par corrente
 *    do AsyncLocalStorage, o que é certo para o turno do agente e errado aqui:
 *    o doctor (#517) e o console avaliam a prontidão de um par ARBITRÁRIO, que
 *    não é o par sob o qual o processo está rodando. Envolver tudo em
 *    `runWithTenantContext` funcionaria, mas esconderia o escopo dentro de um
 *    contexto implícito no exato módulo cuja razão de existir é PROVAR escopo.
 *    Aqui o `(tenant_id, agent_id)` aparece literalmente em cada `WHERE` — em
 *    TODOS eles, inclusive o de `agents` (ver §2 abaixo).
 *
 * 2. **Nenhuma leitura escapa do par.** A leitura de `agents` já foi feita por
 *    `id` apenas, para distinguir "não existe" de "é de outro tenant". Isso
 *    viola a invariante 1 do AGENTS.md e VAZA EXISTÊNCIA entre tenants: quem
 *    conhece (ou adivinha) o id de um agente alheio descobre que ele existe.
 *    O diagnóstico de "pertence a outro tenant" não vale o vazamento e agora
 *    mora numa fronteira SEPARADA, explicitamente autorizada e auditada
 *    (`diagnoseAgentOwnershipGlobally`, restrita ao papel global `founder`).
 *    No caminho normal, tenant errado é INDISTINGUÍVEL de ausência.
 *
 * 3. **O loader não é confiável por construção.** Os fatos carregam o escopo
 *    DONO de cada objeto e o avaliador puro re-verifica. Se um `WHERE` aqui
 *    regredir, o avaliador descarta o objeto de escopo errado em vez de
 *    compor um falso "pronto".
 *
 * E uma quarta, sobre o SCHEMA: a prontidão de migrations NÃO é re-derivada
 * aqui. `src/migrations/` publica o veredito canônico (`getSchemaReadiness`) e
 * o doc daquele módulo é explícito — um consumidor nunca deve reconstruir o
 * estado lendo `schema_migrations` por conta própria. Ler a tabela crua tratava
 * TODA linha do ledger como aplicada, então `dirty`, `failed`, `running`,
 * checksum divergente/desconhecido e arquivo ausente deixavam `schema_ready`
 * VERDE durante uma ativação.
 */
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, pool } from '@/db/client.js';
import {
  admin_audit_log,
  agent_drift_alerts,
  agent_operational_profile_versions,
  agent_tool_grants,
  agents,
  channel_line_state,
  channel_policies,
  channels,
  roles,
  tenants,
} from '@/db/schema.js';
import { getSchemaReadiness } from '@/migrations/readiness.js';
import { BASE_AGENT_PACKS } from '@/tools/base-agent-packs.js';
import { logger } from '@/lib/logger.js';
import { OnboardingError } from './errors.js';
import { assertProvisioningScope } from './scope.js';
import type { ReadinessFacts, SchemaFacts } from './readiness.js';

/**
 * Executor de leitura: o handle global `db` OU o `tx` de um passo da saga.
 *
 * A ativação precisa avaliar o readiness DENTRO da transação que faz as
 * escritas (`wizard.ts`), senão a decisão e o efeito enxergam bancos
 * diferentes. Por isso o loader é parametrizado pelo executor em vez de
 * fechar sobre `db`.
 */
export type ReadinessExecutor = Pick<typeof db, 'select'>;

/** Executor capaz de tomar locks — só o `tx` de um passo, nunca o `db` global. */
export type LockingExecutor = Pick<typeof db, 'execute'>;

/** Diretório de migrations empacotado com este build. */
function migrationsDir(): string {
  return join(process.cwd(), 'migrations');
}

/**
 * Estado do schema, VINDO DA FONTE CANÔNICA (#516).
 *
 * `getSchemaReadiness()` nunca lança e falha FECHADO: banco fora do ar,
 * permissão negada, ledger ausente ⇒ `state: 'unknown'`, `ready: false`. É
 * exatamente o que este check precisa — um erro de leitura não pode virar
 * "schema pronto", que seria a via mais curta para ativar um agente contra um
 * banco desatualizado (ou meio-migrado).
 *
 * O que devolvemos é uma projeção com CÓDIGOS ESTÁVEIS, não o relatório cru:
 * `blockers` carrega `kind` + `id` (nunca SQL, nunca DSN, nunca mensagem de
 * driver), e `verified` carrega o par (estado, checksum) de cada migration —
 * que é o que faz o `schema_fingerprint` distinguir um schema saudável de um
 * sujo. Uma fingerprint sobre ids apenas é IDÊNTICA nos dois casos.
 */
export async function loadSchemaState(): Promise<SchemaFacts> {
  const readiness = await getSchemaReadiness({ pool, migrationsDir: migrationsDir() });
  const status = readiness.status;

  if (!status) {
    logger.warn(
      { state: readiness.state, reason: readiness.reason },
      'onboarding.readiness.schema_state_unknown',
    );
    return {
      ready: false,
      state: readiness.state,
      expected_head: readiness.expected_head,
      applied_head: readiness.applied_head,
      applied_migrations: [],
      pending_migrations: [],
      blockers: readiness.blockers.map((b) => ({ kind: b.kind, id: b.id ?? null })),
      verified: [],
    };
  }

  return {
    ready: readiness.ready,
    state: readiness.state,
    expected_head: readiness.expected_head,
    applied_head: readiness.applied_head,
    applied_migrations: status.entries.filter((e) => e.state === 'applied').map((e) => e.id),
    pending_migrations: [...status.pending],
    blockers: readiness.blockers.map((b) => ({ kind: b.kind, id: b.id ?? null })),
    // O ESTADO VERIFICADO de cada migration, não só o id. É o insumo do
    // `schema_fingerprint`.
    verified: status.entries.map((e) => ({
      id: e.id,
      state: e.state,
      checksum: e.ledger_checksum ?? e.checksum ?? null,
    })),
  };
}

/**
 * Trava, para a duração da transação, TODAS as linhas de que o veredito de
 * readiness depende.
 *
 * Por que `FOR SHARE` e não `FOR UPDATE`: a ativação não muda profile, grant,
 * papel nem política — ela só PRECISA que ninguém os mude entre a decisão e a
 * escrita. `FOR SHARE` permite leituras concorrentes (outra ativação de outro
 * agente, o doctor) e bloqueia `UPDATE`/`DELETE` concorrentes nessas linhas até
 * o commit. As duas linhas que a ativação ESCREVE (`agents`, `channels`) são
 * travadas com `FOR UPDATE`: a mesma transação as promoveria de qualquer forma,
 * e pegar o lock forte já na leitura evita o upgrade tardio (fonte clássica de
 * deadlock).
 *
 * A ordem é FIXA e sempre a mesma — duas ativações concorrentes de agentes
 * diferentes que compartilhem alguma linha adquirem os locks na mesma sequência
 * e não se cruzam.
 *
 * O que isto NÃO promete: `FOR SHARE` não é um predicate lock. Uma linha NOVA
 * inserida concorrentemente (um segundo papel `is_default`) não é travada por
 * nada — por isso `applyActivate` ainda CONFERE o resultado das suas escritas
 * antes de a run ser marcada `active`. Lock + verificação de efeito, não um só.
 */
export async function lockReadinessSnapshot(
  tx: LockingExecutor,
  scope: { tenant_id: string; agent_id: string },
): Promise<void> {
  const { tenant_id, agent_id } = scope;
  await tx.execute(sql`SELECT 1 FROM tenants WHERE id = ${tenant_id} FOR SHARE`);
  await tx.execute(
    sql`SELECT 1 FROM agents WHERE id = ${agent_id} AND tenant_id = ${tenant_id} FOR UPDATE`,
  );
  await tx.execute(
    sql`SELECT 1 FROM agent_operational_profile_versions
         WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} FOR SHARE`,
  );
  await tx.execute(
    sql`SELECT 1 FROM agent_tool_grants
         WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} FOR SHARE`,
  );
  await tx.execute(
    sql`SELECT 1 FROM roles WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} FOR SHARE`,
  );
  await tx.execute(
    sql`SELECT 1 FROM channels WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} FOR UPDATE`,
  );
  await tx.execute(
    sql`SELECT 1 FROM channel_policies
         WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} FOR SHARE`,
  );
  await tx.execute(
    sql`SELECT 1 FROM channel_line_state
         WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} FOR SHARE`,
  );
  await tx.execute(
    sql`SELECT 1 FROM agent_drift_alerts
         WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
           AND severity = 'critical' AND resolved_at IS NULL FOR SHARE`,
  );
}

/**
 * Carrega os fatos por um executor arbitrário — `db` no caminho de leitura,
 * o `tx` do passo no caminho de ativação.
 */
export async function loadReadinessFactsWith(
  executor: ReadinessExecutor,
  scope: { tenant_id: string; agent_id: string },
): Promise<ReadinessFacts> {
  const { tenant_id, agent_id } = scope;

  const [tenantRows, agentRows, profileRows, grantRows, roleRows, channelRows, policyRows, driftRows, schema] =
    await Promise.all([
      executor.select().from(tenants).where(eq(tenants.id, tenant_id)).limit(1),
      // O par COMPLETO entra no WHERE (invariante 1 do AGENTS.md). Um agente de
      // outro tenant não é "encontrado com dono errado": ele simplesmente NÃO
      // EXISTE para esta consulta — indistinguível de ausência, que é a única
      // resposta que não vaza existência entre tenants. O diagnóstico global
      // vive em `diagnoseAgentOwnershipGlobally`, autorizado e auditado.
      executor
        .select()
        .from(agents)
        .where(and(eq(agents.id, agent_id), eq(agents.tenant_id, tenant_id)))
        .limit(1),
      executor
        .select()
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.tenant_id, tenant_id),
            eq(agent_operational_profile_versions.agent_id, agent_id),
            eq(agent_operational_profile_versions.status, 'active'),
          ),
        )
        .limit(1),
      executor
        .select()
        .from(agent_tool_grants)
        .where(
          and(eq(agent_tool_grants.tenant_id, tenant_id), eq(agent_tool_grants.agent_id, agent_id)),
        )
        .limit(1),
      executor
        .select()
        .from(roles)
        .where(and(eq(roles.tenant_id, tenant_id), eq(roles.agent_id, agent_id))),
      executor
        .select({
          id: channels.id,
          tenant_id: channels.tenant_id,
          agent_id: channels.agent_id,
          channel_type: channels.channel_type,
          active: channels.active,
          is_synthetic: channels.is_synthetic,
          line_state: channel_line_state.state,
        })
        .from(channels)
        // O par (tenant, agente) entra no ON, não só no WHERE. `channel_id` é
        // PK de `channel_line_state`, então hoje o join já é 1:1 e não poderia
        // cruzar escopo; mas `channel_line_state` REPLICA (tenant_id, agent_id)
        // sem FK composta (`migrations/103_channel_line_state.sql:28`), e uma
        // linha replicada divergente é precisamente o que o avaliador puro
        // trata como fato de outro dono. Casar o escopo no ON faz a divergência
        // virar `line_state = NULL` (posse NÃO provada, fail-closed) em vez de
        // um estado herdado de outro escopo. Invariante 1 do AGENTS.md.
        .leftJoin(
          channel_line_state,
          and(
            eq(channel_line_state.channel_id, channels.id),
            eq(channel_line_state.tenant_id, tenant_id),
            eq(channel_line_state.agent_id, agent_id),
          ),
        )
        .where(and(eq(channels.tenant_id, tenant_id), eq(channels.agent_id, agent_id))),
      executor
        .select()
        .from(channel_policies)
        .where(
          and(
            eq(channel_policies.tenant_id, tenant_id),
            eq(channel_policies.agent_id, agent_id),
          ),
        ),
      // Pendência de governança bloqueante = alerta de drift CRÍTICO ainda não
      // resolvido para este (tenant, agente).
      executor
        .select({ id: agent_drift_alerts.id })
        .from(agent_drift_alerts)
        .where(
          and(
            eq(agent_drift_alerts.tenant_id, tenant_id),
            eq(agent_drift_alerts.agent_id, agent_id),
            eq(agent_drift_alerts.severity, 'critical'),
            isNull(agent_drift_alerts.resolved_at),
          ),
        ),
      loadSchemaState(),
    ]);

  const tenant = tenantRows[0];
  const agent = agentRows[0];
  const profile = profileRows[0];
  const grant = grantRows[0];

  return {
    requested: { tenant_id, agent_id },
    tenant: tenant ? { id: tenant.id, status: tenant.status } : null,
    agent: agent ? { id: agent.id, tenant_id: agent.tenant_id, status: agent.status } : null,
    profile: profile
      ? {
          id: profile.id,
          tenant_id: profile.tenant_id,
          agent_id: profile.agent_id,
          version: profile.version,
          status: profile.status,
        }
      : null,
    tool_grant: grant
      ? {
          tenant_id: grant.tenant_id,
          agent_id: grant.agent_id,
          granted_packs: grant.granted_packs,
          granted_tools: grant.granted_tools,
          denied_tools: grant.denied_tools,
        }
      : null,
    roles: roleRows.map((r) => ({
      id: r.id,
      tenant_id: r.tenant_id,
      agent_id: r.agent_id,
      role_key: r.role_key,
      active: r.active,
      is_default: r.is_default,
    })),
    channels: channelRows.map((c) => ({
      id: c.id,
      tenant_id: c.tenant_id,
      agent_id: c.agent_id,
      channel_type: c.channel_type,
      active: c.active,
      is_synthetic: c.is_synthetic,
      line_state: c.line_state ?? null,
    })),
    policies: policyRows.map((p) => ({
      id: p.id,
      tenant_id: p.tenant_id,
      agent_id: p.agent_id,
      channel_id: p.channel_id,
      default_role_id: p.default_role_id,
    })),
    required_packs: [...BASE_AGENT_PACKS],
    schema,
    blocking_governance_items: driftRows.length,
  };
}

/** O loader default: leitura pelo handle global. */
export async function loadReadinessFactsFromDb(scope: {
  tenant_id: string;
  agent_id: string;
}): Promise<ReadinessFacts> {
  return loadReadinessFactsWith(db, scope);
}

// ── Fronteira GLOBAL de diagnóstico ──────────────────────────────────────────

export type AgentOwnershipDiagnosis =
  | { verdict: 'absent' }
  | { verdict: 'owned_by_requested_tenant' }
  | { verdict: 'owned_by_other_tenant'; owner_tenant_id: string };

/**
 * "Esse agente existe em ALGUM tenant?" — a única pergunta que o caminho normal
 * de readiness deixou de responder, agora numa fronteira separada.
 *
 * Ela é global de propósito e por isso é:
 *   - EXPLICITAMENTE AUTORIZADA — só o papel global `founder`. Qualquer outro
 *     papel recebe `forbidden`, mesmo tendo o id em mãos;
 *   - AUDITADA — toda consulta grava `admin_audit_log` com o ator, o alvo e o
 *     veredito. Uma varredura de ids passa a ser visível na trilha;
 *   - MÍNIMA — devolve o tenant dono e nada mais. Não expõe status, nome nem
 *     qualquer configuração do agente alheio.
 *
 * Não é chamada por `evaluateAgentReadiness`. É uma ferramenta de operador, e
 * um caminho de diagnóstico global JAMAIS pode ser o default de um avaliador
 * que roda a cada `maia doctor`.
 */
export async function diagnoseAgentOwnershipGlobally(input: {
  scope: { tenant_id: string; agent_id: string };
  actor: { actor_id: string; actor_role: string };
  reason_code: string;
}): Promise<AgentOwnershipDiagnosis> {
  if (input.actor.actor_role !== 'founder') {
    throw new OnboardingError(
      'forbidden',
      'diagnóstico global de agente é exclusivo do papel `founder`',
    );
  }
  assertProvisioningScope(input.scope);

  const rows = await db
    .select({ tenant_id: agents.tenant_id })
    .from(agents)
    .where(eq(agents.id, input.scope.agent_id))
    .limit(1);

  const owner = rows[0]?.tenant_id ?? null;
  const diagnosis: AgentOwnershipDiagnosis =
    owner === null
      ? { verdict: 'absent' }
      : owner === input.scope.tenant_id
        ? { verdict: 'owned_by_requested_tenant' }
        : { verdict: 'owned_by_other_tenant', owner_tenant_id: owner };

  // A trilha vai para o bucket `system`: a consulta é GLOBAL, não pertence ao
  // tenant consultado (e o tenant consultado pode nem existir — a coluna é FK).
  await db.insert(admin_audit_log).values({
    tenant_id: 'system',
    actor_id: input.actor.actor_id,
    actor_role: input.actor.actor_role,
    action: 'onboarding_agent_ownership_diagnosed',
    resource_type: 'agent',
    resource_id: null,
    change_summary: {
      target_tenant_id: input.scope.tenant_id,
      target_agent_id: input.scope.agent_id,
      verdict: diagnosis.verdict,
      reason_code: input.reason_code.slice(0, 64),
    },
  });

  return diagnosis;
}
