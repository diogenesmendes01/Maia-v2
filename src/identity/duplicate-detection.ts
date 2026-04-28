import { pessoasRepo } from '@/db/repositories.js';
import type { Pessoa } from '@/db/schema.js';
import { normalizePhoneBR } from '@/lib/brazilian.js';

export type PhoneValidation =
  | { kind: 'ok'; canonical: string }
  | { kind: 'invalid_format' }
  | { kind: 'belongs_to_active_person'; pessoa: Pessoa }
  | { kind: 'belongs_to_revoked_person'; pessoa: Pessoa; revoked_at: Date }
  | { kind: 'is_owner_or_co_owner'; pessoa: Pessoa };

export async function validatePhoneNumber(input: string): Promise<PhoneValidation> {
  const canonical = normalizePhoneBR(input);
  if (!canonical) return { kind: 'invalid_format' };
  const existing = await pessoasRepo.findByPhone(canonical);
  if (!existing) return { kind: 'ok', canonical };
  if (existing.tipo === 'dono' || existing.tipo === 'co_dono') {
    return { kind: 'is_owner_or_co_owner', pessoa: existing };
  }
  if (existing.status === 'ativa' || existing.status === 'quarentena') {
    return { kind: 'belongs_to_active_person', pessoa: existing };
  }
  return {
    kind: 'belongs_to_revoked_person',
    pessoa: existing,
    revoked_at: existing.updated_at,
  };
}
