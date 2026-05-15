import { listOwners } from '@/governance/permissions.js';
import { entidadesRepo, contasRepo, transacoesRepo } from '@/db/repositories.js';
import { sendOutboundText } from '@/gateway/baileys.js';
import { fmtBR } from '@/lib/brazilian.js';
import { logger } from '@/lib/logger.js';
import { fmtBRL, sumDecimal } from '@/lib/decimal.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

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
  const owners = await listOwners();
  for (const o of owners) {
    const jid = o.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
    await sendOutboundText(jid, text).catch((err) =>
      logger.warn({ err, pessoa_id: o.id }, 'briefing.send_failed'),
    );
  }
}

export async function runMorningBriefing(): Promise<void> {
  // P0: single-tenant default. P6 will fan-out per tenant.
  await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
    const text = await buildOwnerBriefing();
    await sendToOwners(text);
    logger.info('briefing.morning.sent');
  });
}

export async function runEveningBriefing(): Promise<void> {
  await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
    const text = await buildEveningBriefing();
    await sendToOwners(text);
    logger.info('briefing.evening.sent');
  });
}

export async function runWeeklyBriefing(): Promise<void> {
  await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
    const text = await buildWeeklyBriefing();
    await sendToOwners(text);
    logger.info('briefing.weekly.sent');
  });
}
