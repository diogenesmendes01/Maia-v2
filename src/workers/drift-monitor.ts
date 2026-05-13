/**
 * P4 Task 10 — `drift-monitor` worker (weekly).
 *
 * Roda 1x/semana (cron `0 3 * * 0` — domingo 03:00 BRT). Para cada tenant,
 * abre tenant context, busca o perfil operacional ativo, monta o input do
 * orchestrator (`runAllDriftDetectors` — Task 8), executa todos os 7
 * detectores e aplica decisões via `decideAndApply` (Task 9).
 *
 * Fluxo por tenant:
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
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/client.js';
import {
  mensagens,
  procedure_definitions,
  procedure_metrics,
  type AgentOperationalProfileVersion,
} from '@/db/schema.js';
import { runWithTenantContext, getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import {
  tenantsRepo,
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

export async function runDriftMonitor(): Promise<void> {
  const tenants = await tenantsRepo.list();
  let total_alerts = 0;
  const by_severity: SeverityBreakdown = { baixo: 0, medio: 0, alto: 0, critico: 0 };

  for (const t of tenants) {
    await runWithTenantContext({ tenant_id: t.id, agent_id: 'default' }, async () => {
      const active = await operationalProfileVersionsRepo.getActive();
      if (!active) {
        logger.info({ tenant_id: t.id }, 'drift_monitor.no_active_profile_skip');
        return;
      }

      const input = await assembleDriftInput(active);
      const evidences = await runAllDriftDetectors(input);

      if (evidences.length === 0) {
        logger.info({ tenant_id: t.id }, 'drift_monitor.no_drift');
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
          tenant_id: t.id,
          alerts: results.length,
          by_severity_local: results.map((r) => r.severity),
        },
        'drift_monitor.tenant_done',
      );
    });
  }

  logger.info({ total_alerts, by_severity }, 'drift_monitor.done');
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

  // recent_procedures — SELECT direto últimos 30d, LEFT JOIN com
  // procedure_metrics (materialized view P3c) para obter o evidence_count
  // REAL via `total_executions`. Sem join, todo procedure recente vinha com
  // `evidence_count: 0`, o que (segundo o threshold do detector) marca como
  // "low evidence" e — se algum estava active — disparava ALTO + freeze do
  // perfil. Issue P86-C2 ("evidence_count=0 sentinel freezes profiles").
  //
  // Correção: quando não há row em procedure_metrics (procedure nunca
  // executou) usamos Number.POSITIVE_INFINITY → procedure não conta como
  // baixa evidência ("ainda não temos evidência para julgar"). Quando há
  // metrics, usamos `total_executions` como contagem real.
  //
  // Isso preserva o invariante "agente gera evidência, não muda quem é":
  // sem evidência REAL coletada, o detector não classifica o procedure
  // como drift e o decision engine não freeza o perfil.
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
        total_executions: procedure_metrics.total_executions,
      })
      .from(procedure_definitions)
      .leftJoin(
        procedure_metrics,
        sql`${procedure_metrics.definition_id} = ${procedure_definitions.id}`,
      )
      .where(
        sql`${procedure_definitions.tenant_id} = ${tenant_id}
            AND ${procedure_definitions.agent_id} = ${agent_id}
            AND ${procedure_definitions.created_at} >= ${cutoff.toISOString()}`,
      )
      .orderBy(sql`${procedure_definitions.created_at} DESC`);
    recent_procedures = rows.map((r) => ({
      id: String(r.id),
      created_at: r.created_at instanceof Date ? r.created_at : new Date(r.created_at ?? Date.now()),
      // Real evidence count via procedure_metrics; no metrics row =>
      // POSITIVE_INFINITY (detector treats missing data as "not yet
      // judged" and does NOT classify as low evidence). Prevents
      // synthetic-zero freezes (P86-C2).
      evidence_count:
        typeof r.total_executions === 'number'
          ? r.total_executions
          : Number.POSITIVE_INFINITY,
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
