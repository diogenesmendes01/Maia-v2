import { pessoasRepo } from '@/db/repositories.js';
import type { Pessoa } from '@/db/schema.js';
import { config } from '@/config/env.js';
import { audit } from './audit.js';

export function isAuditModeActive(pessoa: Pessoa): boolean {
  const prefs = (pessoa.preferencias ?? {}) as Record<string, unknown>;
  const ate = prefs['modo_auditoria_ate'];
  if (typeof ate !== 'string') return false;
  const dt = new Date(ate);
  if (Number.isNaN(dt.getTime())) return false;
  return dt > new Date();
}

export async function activateAuditMode(target: Pessoa, hours = config.AUDIT_MODE_TTL_HOURS): Promise<void> {
  const prefs = { ...(target.preferencias as Record<string, unknown>) };
  prefs.modo_auditoria_ate = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  await pessoasRepo.updatePreferencias(target.id, prefs);
  await audit({
    acao: 'audit_mode_activated',
    pessoa_id: target.id,
    metadata: { hours },
  });
}

export async function deactivateAuditMode(target: Pessoa): Promise<void> {
  const prefs = { ...(target.preferencias as Record<string, unknown>) };
  delete prefs.modo_auditoria_ate;
  await pessoasRepo.updatePreferencias(target.id, prefs);
  await audit({ acao: 'audit_mode_deactivated', pessoa_id: target.id });
}

export async function expireAuditModes(): Promise<number> {
  const all = await pessoasRepo.list();
  let count = 0;
  for (const p of all) {
    const prefs = (p.preferencias ?? {}) as Record<string, unknown>;
    const ate = prefs['modo_auditoria_ate'];
    if (typeof ate === 'string' && new Date(ate) <= new Date()) {
      const next = { ...prefs };
      delete next.modo_auditoria_ate;
      await pessoasRepo.updatePreferencias(p.id, next);
      await audit({ acao: 'audit_mode_deactivated_auto', pessoa_id: p.id });
      count++;
    }
  }
  return count;
}
