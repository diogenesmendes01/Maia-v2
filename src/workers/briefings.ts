import { listOwners } from '@/governance/permissions.js';
import { entidadesRepo, contasRepo, transacoesRepo, pessoasRepo } from '@/db/repositories.js';
import { sendOutboundText } from '@/gateway/baileys.js';
import { fmtBR } from '@/lib/brazilian.js';
import { logger } from '@/lib/logger.js';
import { fmtBRL, sumDecimal } from '@/lib/decimal.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

/**
 * Issue #345 (Phase 4 of #323) — per-tenant fan-out for the 3 briefing workers
 * (`briefing_morning` / `briefing_evening` / `briefing_weekly`).
 *
 * BEFORE: each of `runMorningBriefing` / `runEveningBriefing` /
 * `runWeeklyBriefing` opened a HARDCODED
 * `runWithTenantContext({ tenant_id: 'default', agent_id: 'default' })` and ran
 * its inner (build financial briefing + send to owners) ONCE. Under a
 * multi-tenant deployment only the `default` agent's owners were ever briefed —
 * every real tenant's owner silently got NO morning/evening/weekly briefing.
 *
 * AFTER: each worker is a DISPATCHER. It enumerates — OUTSIDE any tenant context
 * — the DISTINCT (tenant_id, agent_id) tuples that own at least one ACTIVE owner
 * pessoa (`pessoasRepo.listTenantAgentPairsWithActiveOwner`, whose predicate
 * mirrors `listOwners()` exactly), then runs the period's inner ONCE PER tuple
 * inside `runWithTenantContext`. Each inner's financial reads
 * (`entidadesRepo.list`, `contasRepo.byEntity`, `transacoesRepo.byScope`) and its
 * `sendToOwners()` recipient lookup (`listOwners` → `pessoasRepo.list`) are ALL
 * scoped to the ALS (tenant_id, agent_id) of the running tuple, so a briefing
 * built for tuple A reads ONLY tenant A's data and is sent ONLY to tenant A's
 * owners — the inviolable cross-tenant isolation invariant. (A cross-tenant leak
 * here would send one tenant's financial data to another tenant's owner.)
 *
 * Behavior-preserving in single-tenant mode: when the only active owner lives
 * under `('default','default')`, the enumeration yields exactly that one tuple,
 * so each briefing still runs once under default. Fail-isolated per tuple
 * (mirrors conversation-summarizer #350 / pattern-detector #351): a throw under
 * one tuple must not abort the others.
 */

type Pair = { tenant_id: string; agent_id: string };

async function buildOwnerBriefing(): Promise<string> {
  const ents = await entidadesRepo.list();
  const lines: string[] = [];
  for (const e of ents.slice(0, 5)) {
    const contas = await contasRepo.byEntity(e.id);
    // saldo_atual vem como string (numeric pg) — sumDecimal preserva precisão.
    const total = sumDecimal(contas.map((c) => c.saldo_atual));
    lines.push(`• ${e.nome}: ${fmtBRL(total)}`);
  }
  return [
    `Bom dia. Briefing matinal — ${fmtBR(new Date())}`,
    '',
    'Saldos por entidade:',
    ...lines,
  ].join('\n');
}

async function buildEveningBriefing(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const ents = await entidadesRepo.list();
  const lines: string[] = [];
  for (const e of ents.slice(0, 5)) {
    const txns = await transacoesRepo.byScope(
      { pessoa_id: 'system', entidades: [e.id] },
      { date_from: today, date_to: today, limit: 200 },
    );
    const r = sumDecimal(txns.filter((t) => t.natureza === 'receita').map((t) => t.valor));
    const d = sumDecimal(txns.filter((t) => t.natureza === 'despesa').map((t) => t.valor));
    lines.push(`• ${e.nome}: +${fmtBRL(r)} / -${fmtBRL(d)}`);
  }
  return [`Fechamento do dia — ${fmtBR(new Date())}`, '', 'Movimento de hoje:', ...lines].join('\n');
}

async function buildWeeklyBriefing(): Promise<string> {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86_400_000);
  const ents = await entidadesRepo.list();
  const lines: string[] = [];
  for (const e of ents.slice(0, 5)) {
    const txns = await transacoesRepo.byScope(
      { pessoa_id: 'system', entidades: [e.id] },
      { date_from: from.toISOString().slice(0, 10), date_to: to.toISOString().slice(0, 10), limit: 1000 },
    );
    const r = sumDecimal(txns.filter((t) => t.natureza === 'receita').map((t) => t.valor));
    const d = sumDecimal(txns.filter((t) => t.natureza === 'despesa').map((t) => t.valor));
    // lucro = r - d em Decimal; só formata pra string no output.
    lines.push(`• ${e.nome}: receita ${fmtBRL(r)}, despesa ${fmtBRL(d)}, lucro ${fmtBRL(r.minus(d))}`);
  }
  return [`Resumo semanal — ${fmtBR(new Date())}`, '', 'Últimos 7 dias:', ...lines].join('\n');
}

async function sendToOwners(text: string): Promise<void> {
  // `listOwners()` → `pessoasRepo.list()` is scoped to the CURRENT ALS
  // (tenant_id, agent_id), so under a per-tuple briefing run this resolves ONLY
  // the running tuple's active owners — the briefing can never be addressed to
  // another tenant's owner.
  const owners = await listOwners();
  for (const o of owners) {
    const jid = o.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
    await sendOutboundText(jid, text).catch((err) =>
      logger.warn({ err, pessoa_id: o.id }, 'briefing.send_failed'),
    );
  }
}

/**
 * Shared dispatcher for the 3 periodic briefings. Enumerates the tuples with an
 * active owner OUTSIDE any tenant context, then runs `inner` once per tuple
 * under that tuple's context. `inner` builds the period's briefing (financial
 * reads scoped to ALS) and sends it to that tuple's owners. Fail-isolated per
 * tuple; the `period` label keys the per-period idle/done logs.
 */
async function dispatchBriefing(
  period: 'morning' | 'evening' | 'weekly',
  inner: () => Promise<void>,
): Promise<void> {
  const tuples: Pair[] = await pessoasRepo.listTenantAgentPairsWithActiveOwner();

  if (tuples.length === 0) {
    logger.debug(`briefing.${period}.idle`);
    return;
  }

  let agents_processed = 0;
  let agents_failed = 0;

  for (const { tenant_id, agent_id } of tuples) {
    try {
      await runWithTenantContext({ tenant_id, agent_id }, inner);
      agents_processed++;
    } catch (err) {
      // Fail-isolated per (tenant, agent): a throw under one tuple must not
      // abort the briefing for the others.
      agents_failed++;
      logger.warn(
        {
          tenant_id,
          agent_id,
          err: (err as Error).message,
          stack: (err as Error).stack,
        },
        `briefing.${period}.agent_failed`,
      );
    }
  }

  logger.info(
    { tuples: tuples.length, agents_processed, agents_failed },
    `briefing.${period}.done`,
  );
}

async function runMorningBriefingInner(): Promise<void> {
  const text = await buildOwnerBriefing();
  await sendToOwners(text);
  logger.info('briefing.morning.sent');
}

async function runEveningBriefingInner(): Promise<void> {
  const text = await buildEveningBriefing();
  await sendToOwners(text);
  logger.info('briefing.evening.sent');
}

async function runWeeklyBriefingInner(): Promise<void> {
  const text = await buildWeeklyBriefing();
  await sendToOwners(text);
  logger.info('briefing.weekly.sent');
}

export async function runMorningBriefing(): Promise<void> {
  await dispatchBriefing('morning', runMorningBriefingInner);
}

export async function runEveningBriefing(): Promise<void> {
  await dispatchBriefing('evening', runEveningBriefingInner);
}

export async function runWeeklyBriefing(): Promise<void> {
  await dispatchBriefing('weekly', runWeeklyBriefingInner);
}
