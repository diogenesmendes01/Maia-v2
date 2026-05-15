import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { pessoas } from '../../db/schema.js';

export interface InterlocutorItem {
  pessoa_id: string;
  nome: string;
  apelido: string | null;
  tipo: string;
  status: 'ativa' | 'pausada' | 'arquivada';
  preferencias: Record<string, unknown> | null;
  modelo_mental: Record<string, unknown> | null;
}

export const interlocutorResolver = {
  async get(input: {
    tenant_id: string;
    pessoa_id: string;
  }): Promise<InterlocutorItem> {
    const row = await db
      .select()
      .from(pessoas)
      .where(
        and(
          eq(pessoas.tenant_id, input.tenant_id),
          eq(pessoas.id, input.pessoa_id),
        ),
      )
      .limit(1);

    if (!row || row.length === 0) {
      throw new Error(`Interlocutor not found: ${input.pessoa_id} in tenant ${input.tenant_id}`);
    }

    const p = row[0];
    return {
      pessoa_id: p.id,
      nome: p.nome,
      apelido: p.apelido ?? null,
      tipo: p.tipo,
      status: p.status as InterlocutorItem['status'],
      preferencias: p.preferencias as Record<string, unknown> | null,
      modelo_mental: p.modelo_mental as Record<string, unknown> | null,
    };
  },
};
