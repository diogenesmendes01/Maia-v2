/**
 * A trava que faltava no mapa de tabelas do KSM (`KSM_SOURCE_TABLES`).
 *
 * O mapa é interpolado CRU no SQL da fila (`sql.raw(t.nome)`,
 * `sql.raw(t.descritor)`), e é justamente por isso que ele não tem quem o
 * confira: o compilador vê duas strings. Um nome errado só aparece como
 * `column "x" does not exist` — com a fila inteira de `knowledge_proposal`
 * caindo junto.
 *
 * E não é hipótese. `behavioral_hint` apontou para `content` desde que o mapa
 * nasceu; a coluna dessa tabela sempre se chamou `hint_text`. O erro ficou
 * invisível porque um probe de tabela matava o laço antes da query. No dia em
 * que o laço voltou a rodar, o nome errado deixou de ser inofensivo.
 *
 * Estes casos comparam o mapa com o `schema.ts` — a mesma fonte que a
 * migration escreve —, então drift de coluna quebra aqui, no unit, e não na
 * fila de um tenant.
 */
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { KSM_SOURCE_TABLES } from '@/db/repositories/admin-repos.js';
import { agent_facts, memory_entry, learned_rules, behavioral_hint } from '@/db/schema.js';

const TABELAS = { agent_facts, memory_entry, learned_rules, behavioral_hint } as const;

/** Nomes de coluna REAIS (o nome no banco, não a chave do objeto TS). */
function colunasDe(tabela: (typeof TABELAS)[keyof typeof TABELAS]): string[] {
  return Object.values(getTableColumns(tabela)).map((c) => c.name);
}

describe('KSM_SOURCE_TABLES — o mapa que vai cru para o SQL', () => {
  it('toda tabela do mapa existe no schema', () => {
    for (const { nome } of KSM_SOURCE_TABLES) {
      expect(Object.keys(TABELAS)).toContain(nome);
    }
  });

  it('toda coluna descritora existe NA tabela dela', () => {
    for (const { nome, descritor } of KSM_SOURCE_TABLES) {
      const tabela = TABELAS[nome as keyof typeof TABELAS];
      expect(colunasDe(tabela), `${nome}.${descritor}`).toContain(descritor);
    }
  });

  it('as colunas que o SELECT sempre pede existem nas quatro', () => {
    // `id`, `created_at`, `tenant_id`, `lifecycle_status` e
    // `lifecycle_transitions` entram na query fixa, fora do mapa. Uma delas
    // faltando derruba a fila do mesmo jeito.
    for (const { nome } of KSM_SOURCE_TABLES) {
      const colunas = colunasDe(TABELAS[nome as keyof typeof TABELAS]);
      for (const exigida of [
        'id',
        'created_at',
        'tenant_id',
        'lifecycle_status',
        'lifecycle_transitions',
      ]) {
        expect(colunas, `${nome}.${exigida}`).toContain(exigida);
      }
    }
  });

  it('CONTRA-PROVA: uma coluna inventada REPROVA', () => {
    // Sem este caso, os anteriores passariam com um mapa vazio ou com um
    // `toContain` que nunca é exercitado.
    expect(colunasDe(behavioral_hint)).not.toContain('content');
    expect(colunasDe(behavioral_hint)).toContain('hint_text');
  });
});
