/**
 * P4 Task 10 — `drift-monitor` worker (weekly).
 *
 * Roda 1x/semana (cron `0 3 * * 0` — domingo 03:00 BRT). Para cada par
 * (tenant_id, agent_id) que TEM um perfil operacional ativo, abre tenant
 * context, busca esse perfil, monta o input do orchestrator
 * (`runAllDriftDetectors` — Task 8), executa todos os 7 detectores e aplica
 * decisões via `decideAndApply` (Task 9).
 *
 * Issue #323 (Phase 3) — per-agent fan-out, NÃO mais `agent_id:'default'`.
 *
 * BEFORE: o worker iterava `tenantsRepo.list()` e abria
 * `runWithTenantContext({ tenant_id, agent_id:'default' })` fixo. Dois
 * problemas: (1) no flip de `MAIA_REJECT_DEFAULT_LITERAL` o
 * `getCurrentAgent()`/`assertNotDefaultLiteral` lançaria em todo tenant; e
 * (2) só o agent 'default' de cada tenant era analisado — os OUTROS agents do
 * tenant nunca passavam por detecção de drift (bug latente de cobertura
 * per-agent). `tenantsRepo.list()` ainda incluía `system`+`default`, que sob o
 * flip também lançariam.
 *
 * AFTER: enumera tuplas (tenant_id, agent_id) DISTINCT que têm um perfil
 * ATIVO em `agent_operational_profile_versions` (work-table fan-out — mesmo
 * padrão de `reflection-batch`/`outbound-messages-sweeper`, #240/#251/#292).
 * Cada agent real com baseline ganha seu próprio pass; agents sem perfil ativo
 * naturalmente não aparecem (o worker já os pulava). `system`/`default` não
 * têm perfil ativo seeded, então caem fora da enumeração sem caso especial.
 * Fail-isolated por tupla: erro em um (tenant, agent) não derruba os demais.
 *
 * Fluxo por (tenant, agent):
 *   1. `operationalProfileVersionsRepo.getActive()` — se null, skip (sem
 *      baseline para comparar).
 *   2. Monta `DriftDetectionInput` com best-effort fetch:
 *        - profile_active: do passo 1
 *        - recent_messages: últimos 7d, até 200 msgs (SELECT direto com
 *          filtro de tenant/agent — `mensagensRepo` não expõe um método
 *          "recente por agent" então caímos no `db.execute` controlado).
 *        - capabilities: `capabilitiesSkillRepo.listAll()` mapeado para
 *          `{ name, status }` (compatibilidade com escopo detector).
 *        - self_model_skills: mesmo repo, mapeado para
 *          `{ skill_name, confidence, evidence_count }` (compatibilidade
 *          com confianca detector).
 *        - recent_procedures: SELECT direto últimos 30d (sem repo method).
 *   3. `runAllDriftDetectors(input)` → lista de evidências.
 *   4. Se houver evidências → `decideAndApply({ evidences, active_profile_id })`.
 *   5. Log breakdown por severidade.
 *
 * Todos os fetches são try/catch'ados — em falha, fallback para array vazio
 * (os detectores tratam input vazio defensivamente devolvendo null).
 */
import { sql, eq } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/client.js';
import {
  mensagens,
  procedure_definitions,
  agent_operational_profile_versions,
  type AgentOperationalProfileVersion,
} from '@/db/schema.js';
import { runWithTenantContext, getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import {
  operationalProfileVersionsRepo,
  capabilitiesSkillRepo,
} from '@/db/repositories.js';
import {
  runAllDriftDetectors,
  type DriftDetectionInput,
  type DriftRecentMessage,
} from '@/cognition/drift/index.js';
import { decideAndApply } from '@/cognition/drift/decision-engine.js';

const RECENT_DAYS = 7;
const RECENT_MSG_LIMIT = 200;
const RECENT_PROCEDURES_DAYS = 30;

type SeverityBreakdown = { baixo: number; medio: number; alto: number; critico: number };
type TenantAgentRow = { tenant_id: string; agent_id: string };

/**
 * Issue #323 (Phase 3) — enumera tuplas (tenant_id, agent_id) DISTINCT que
 * têm um perfil operacional ATIVO. Roda OUTSIDE de qualquer tenant context —
 * é o dispatcher que decide em quais escopos rodar a detecção de drift.
 *
 * Work-table fan-out (mesmo padrão de reflection-batch #240/#251 e
 * outbound-messages-sweeper #292): só tenants/agents com baseline ativo
 * aparecem — exatamente os que o worker processaria (os demais já eram
 * pulados via `no_active_profile_skip`). `system`/`default` não têm perfil
 * ativo seeded, então não entram no loop sem caso especial.
 *
 * Espelha o idioma `selectDistinct` já usado por
 * `cognitiveCandidatesRepo.listPendingTenantPairsForType` (P83-C2): query
 * builder type-safe, sem RLS implícito — a iteração é parte do contrato do
 * worker, que abre `runWithTenantContext` por tupla.
 */
async function listAgentsWithActiveProfile(): Promise<TenantAgentRow[]> {
  return db
    .selectDistinct({
      tenant_id: agent_operational_profile_versions.tenant_id,
      agent_id: agent_operational_profile_versions.agent_id,
    })
    .from(agent_operational_profile_versions)
    .where(eq(agent_operational_profile_versions.status, 'active'));
}

export async function runDriftMonitor(): Promise<void> {
  const tuples = await listAgentsWithActiveProfile();
  let total_alerts = 0;
  let agents_processed = 0;
  let agents_failed = 0;
  const by_severity: SeverityBreakdown = { baixo: 0, medio: 0, alto: 0, critico: 0 };

  if (tuples.length === 0) {
    logger.info({ total_alerts: 0, by_severity }, 'drift_monitor.done');
    return;
  }

  for (const { tenant_id, agent_id } of tuples) {
    try {
      await runWithTenantContext({ tenant_id, agent_id }, async () => {
        // Defense-in-depth: even though the dispatcher only enumerated agents
        // WITH an active profile, getActive() re-reads scoped to this exact
        // (tenant, agent) via ALS — a concurrent rollback between enumeration
        // and this read yields null and we skip cleanly.
        const active = await operationalProfileVersionsRepo.getActive();
        if (!active) {
          logger.info({ tenant_id, agent_id }, 'drift_monitor.no_active_profile_skip');
          return;
        }

        const input = await assembleDriftInput(active);
        const evidences = await runAllDriftDetectors(input);

        if (evidences.length === 0) {
          logger.info({ tenant_id, agent_id }, 'drift_monitor.no_drift');
          return;
        }

        const results = await decideAndApply({ evidences, active_profile_id: active.id });
        total_alerts += results.length;
        for (const r of results) {
          const sev = r.severity as keyof SeverityBreakdown;
          if (sev in by_severity) by_severity[sev]++;
        }

        logger.info(
          {
            tenant_id,
            agent_id,
            alerts: results.length,
            by_severity_local: results.map((r) => r.severity),
          },
          'drift_monitor.tenant_done',
        );
      });
      agents_processed++;
    } catch (err) {
      // Fail-isolated por (tenant, agent): erro de um agent não interrompe o
      // loop — mirrors reflection-batch (#251) / outbound-messages-sweeper
      // (#292). Telemetria distingue via agents_failed/agents_processed.
      agents_failed++;
      logger.warn(
        {
          tenant_id,
          agent_id,
          err: (err as Error).message,
          stack: (err as Error).stack,
        },
        'drift_monitor.agent_failed',
      );
    }
  }

  logger.info(
    { tuples: tuples.length, agents_processed, agents_failed, total_alerts, by_severity },
    'drift_monitor.done',
  );
}

async function assembleDriftInput(
  active: AgentOperationalProfileVersion,
): Promise<DriftDetectionInput> {
  // recent_messages — sem método dedicado em mensagensRepo; SELECT direto
  // dentro do tenant context (filtra por tenant_id/agent_id). Best-effort.
  let recent_messages: DriftRecentMessage[] = [];
  try {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const cutoff = new Date(Date.now() - RECENT_DAYS * 86_400_000);
    const rows = await db
      .select({
        id: mensagens.id,
        direcao: mensagens.direcao,
        conteudo: mensagens.conteudo,
        created_at: mensagens.created_at,
      })
      .from(mensagens)
      .where(
        sql`tenant_id = ${tenant_id}
            AND agent_id = ${agent_id}
            AND created_at >= ${cutoff.toISOString()}`,
      )
      .orderBy(sql`created_at DESC`)
      .limit(RECENT_MSG_LIMIT);
    recent_messages = rows.map((r) => ({
      id: String(r.id),
      from: r.direcao === 'out' ? ('agent' as const) : ('user' as const),
      text: r.conteudo ?? '',
      created_at: r.created_at instanceof Date ? r.created_at : new Date(r.created_at ?? Date.now()),
    }));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'drift_monitor.recent_messages_failed');
  }

  // capabilities — `capabilitiesSkillRepo.listAll()` retorna AgentCapabilitySkill[];
  // o detector ESCOPO espera `{ name, status }`. Derivamos status='active' quando
  // evidence_count > 0 (skill foi usada de fato) — caso contrário 'inactive'.
  let capabilities: Array<{ name: string; status: string }> = [];
  try {
    const skills = await capabilitiesSkillRepo.listAll();
    capabilities = skills.map((s) => ({
      name: s.skill_name,
      status: (s.evidence_count ?? 0) > 0 ? 'active' : 'inactive',
    }));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'drift_monitor.capabilities_failed');
  }

  // self_model_skills — mesmo repo, formato `{ skill_name, confidence, evidence_count }`
  // (confidence vem como string numeric do drizzle — convertemos para number).
  let self_model_skills: Array<{ skill_name: string; confidence: number; evidence_count: number }> =
    [];
  try {
    const skills = await capabilitiesSkillRepo.listAll();
    self_model_skills = skills.map((s) => ({
      skill_name: s.skill_name,
      confidence: typeof s.confidence === 'string' ? Number(s.confidence) : Number(s.confidence ?? 0),
      evidence_count: s.evidence_count ?? 0,
    }));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'drift_monitor.self_model_failed');
  }

  // recent_procedures — sem método dedicado em procedureDefinitionsRepo; SELECT
  // direto últimos 30d. O detector procedimento espera `{ id, created_at,
  // evidence_count, status }`. procedure_definitions não tem `evidence_count`
  // próprio — usamos um proxy via número de tests passing/exec count NÃO está
  // exposto aqui. Para esse worker, deixamos `evidence_count` como 0 (gatilha
  // detector por design — procedure novo sem evidência é justamente o alvo)
  // ou usamos um sentinel `Infinity` para suprimir até existir tracking real.
  // Conservador: 0 (deixa o detector decidir com base no threshold dele).
  let recent_procedures: Array<{
    id: string;
    created_at: Date;
    evidence_count: number;
    status: string;
  }> = [];
  try {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const cutoff = new Date(Date.now() - RECENT_PROCEDURES_DAYS * 86_400_000);
    const rows = await db
      .select({
        id: procedure_definitions.id,
        status: procedure_definitions.status,
        created_at: procedure_definitions.created_at,
      })
      .from(procedure_definitions)
      .where(
        sql`tenant_id = ${tenant_id}
            AND agent_id = ${agent_id}
            AND created_at >= ${cutoff.toISOString()}`,
      )
      .orderBy(sql`created_at DESC`);
    recent_procedures = rows.map((r) => ({
      id: String(r.id),
      created_at: r.created_at instanceof Date ? r.created_at : new Date(r.created_at ?? Date.now()),
      // procedure_definitions ainda não rastreia evidence_count direto — 0
      // mantém o detector conservador (gatilha quando o agente cria muitos
      // procedures sem evidência consolidada). Quando o tracking existir,
      // basta join contra procedure_metrics aqui.
      evidence_count: 0,
      status: r.status,
    }));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'drift_monitor.recent_procedures_failed');
  }

  return {
    profile_active: active,
    recent_messages,
    capabilities,
    self_model_skills,
    recent_procedures,
  };
}
