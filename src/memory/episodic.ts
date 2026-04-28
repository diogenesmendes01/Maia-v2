import { mensagensRepo, transacoesRepo, auditRepo } from '@/db/repositories.js';
import type { EntityScope } from '@/db/repositories.js';

export async function recentMessages(conversa_id: string, n = 10) {
  return mensagensRepo.recentInConversation(conversa_id, n);
}

export async function recentTransactions(scope: EntityScope, n = 20) {
  return transacoesRepo.byScope(scope, { limit: n });
}

export async function auditTrailFor(pessoa_id: string, n = 100) {
  return auditRepo.listByPessoa(pessoa_id, n);
}
