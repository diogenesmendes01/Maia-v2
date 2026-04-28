import { factsRepo } from '@/db/repositories.js';
import type { EntityScope } from '@/db/repositories.js';

export async function readFacts(scope: EntityScope, pessoa_id: string) {
  const escopos = ['global', `pessoa:${pessoa_id}`, ...scope.entidades.map((e) => `entidade:${e}`)];
  return factsRepo.listForScopes(escopos);
}

export async function saveFact(input: {
  escopo: string;
  chave: string;
  valor: unknown;
  fonte?: 'configurado' | 'aprendido' | 'inferido';
  confianca?: number;
}) {
  return factsRepo.upsert({
    escopo: input.escopo,
    chave: input.chave,
    valor: input.valor,
    fonte: input.fonte ?? 'aprendido',
    confianca: input.confianca,
  });
}
