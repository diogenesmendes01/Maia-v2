import { rulesRepo } from '@/db/repositories.js';

export async function listRulesForType(tipo: string) {
  return rulesRepo.listActive(tipo);
}

export async function recordAcerto(rule_id: string) {
  await rulesRepo.incrementAcerto(rule_id);
  // Promotion check: 4 consecutive acertos OR 10 days since creation
  const r = await rulesRepo.byId(rule_id);
  if (!r) return;
  const ageDays = (Date.now() - new Date(r.created_at).getTime()) / 86_400_000;
  if (r.acertos >= 4 && r.erros === 0 && Number(r.confianca) < 0.8) {
    await rulesRepo.setStatus(rule_id, { confianca: 0.8 });
  } else if (ageDays >= 10 && r.erros === 0 && r.acertos >= 1) {
    await rulesRepo.setStatus(rule_id, { confianca: Math.max(Number(r.confianca), 0.8) });
  }
}

export async function recordErro(rule_id: string) {
  await rulesRepo.incrementErro(rule_id);
  const r = await rulesRepo.byId(rule_id);
  if (!r) return;
  if (r.erros >= 2) {
    await rulesRepo.setStatus(rule_id, { ativa: false });
  }
}

export async function markFirm(rule_id: string) {
  await rulesRepo.setStatus(rule_id, { ativa: true, confianca: 1.0 });
}

export async function banRule(rule_id: string) {
  await rulesRepo.setStatus(rule_id, { ativa: false, confianca: 0.0 });
}
