/**
 * Issue #720 — sonda de FORMA sobre as duas CLIs de importação.
 *
 * Fica VERMELHA se alguém reintroduzir um `UPDATE ... WHERE id = $1` sem
 * `tenant_id`/`agent_id` em `scripts/import-review.ts`, ou um `INSERT` que não
 * passe por `applyTenantGuard` em qualquer uma das duas.
 *
 * ## Por que esta spec existe SE a prova de comportamento já existe
 *
 * A prova real é `tests/integration/import-cli-tenant-scope-real-db.spec.ts`
 * caso (4): ela planta uma `import_entry` do tenant A apontando para uma
 * `transacao` do tenant B e verifica, contra Postgres, que a linha do B fica
 * INTACTA. Com o código de antes do conserto aquele caso reprova com
 * `expected 'paga' to be 'pendente'` — ou seja, o `WHERE id = $1` de fato
 * sobrescrevia a linha do outro tenant.
 *
 * Esta sonda é o complemento BARATO e SEM BANCO da mesma regra. Ela roda na
 * lane unit (sem `TEST_DB_URL`), onde a spec de integração faz `describe.skip`
 * — e `pulado` NÃO é `passou`. Numa rodada sem Postgres, é ESTA que segura a
 * regra.
 *
 * ## O que ela NÃO cobre, explicitamente
 *
 * É uma leitura de TEXTO, não de semântica: ela prova que os predicados estão
 * escritos, não que a tupla ligada neles é a correta. Um `eq(transacoes.tenant_id,
 * 'literal')` passaria aqui. Quem pega isso é o caso (4) da integração. As duas
 * juntas cobrem forma e comportamento; nenhuma sozinha basta.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RAIZ = resolve(__dirname, '../../..');
const REVIEW = resolve(RAIZ, 'scripts/import-review.ts');
const OFX = resolve(RAIZ, 'scripts/import-ofx.ts');

/**
 * Remove comentários antes de qualquer varredura.
 *
 * Não é preciosismo: os dois arquivos CITAM o código defeituoso nos seus
 * cabeçalhos (`db.insert(import_runs).values({...})`, `WHERE id = $1`) para
 * documentar o que a #720 consertou. Sem esta limpeza a sonda leria a citação
 * como se fosse código e reprovaria eternamente — e a "correção" óbvia seria
 * apagar a documentação, que é o pior resultado possível.
 *
 * Limitação declarada: um `//` dentro de string literal seria tratado como
 * comentário. Nenhum dos dois arquivos tem um; se algum passar a ter, a sonda
 * recorta demais e reprova (falha fechada).
 */
function semComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const fonteReview = semComentarios(readFileSync(REVIEW, 'utf8'));
const fonteOfx = semComentarios(readFileSync(OFX, 'utf8'));

/**
 * Recorta as expressões que começam em `marcador` e terminam no `;` de
 * profundidade zero. Suficiente para este arquivo (nenhum `;` mora dentro de
 * um template literal aqui); se um dia morar, a sonda passa a recortar demais
 * e reprova — falha fechada, que é o lado certo de errar numa sonda.
 */
function expressoes(src: string, marcador: string): string[] {
  const out: string[] = [];
  let i = 0;
  while ((i = src.indexOf(marcador, i)) !== -1) {
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      else if (c === ';' && depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

/** Argumento do primeiro `.where(` da expressão, com parênteses balanceados. */
function argumentoDoWhere(expr: string): string | null {
  const marca = '.where(';
  const inicio = expr.indexOf(marca);
  if (inicio === -1) return null;
  let depth = 0;
  const abre = inicio + marca.length - 1;
  for (let j = abre; j < expr.length; j++) {
    const c = expr[j];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return expr.slice(abre + 1, j);
    }
  }
  return null;
}

/**
 * Os dois helpers de predicado do `import-review.ts`. Um `.where(runScope(scope))`
 * é escopado ainda que as strings `tenant_id`/`agent_id` não apareçam ali —
 * desde que o helper as carregue, o que é afirmado em caso próprio abaixo.
 */
const HELPERS_DE_ESCOPO = ['runScope(', 'entryScope('];

function ehEscopado(where: string): boolean {
  if (where.includes('tenant_id') && where.includes('agent_id')) return true;
  return HELPERS_DE_ESCOPO.some((h) => where.includes(h));
}

describe('#720 — toda escrita das CLIs de importação é escopada por tenant+agent', () => {
  it('os helpers de predicado carregam tenant_id E agent_id', () => {
    // Sem isto, aceitar `.where(runScope(scope))` como "escopado" seria
    // circular: o caso abaixo confiaria num helper que poderia estar vazio.
    for (const helper of ['function runScope(', 'function entryScope(']) {
      const [corpo] = expressoes(fonteReview, helper);
      expect(corpo, `helper ausente: ${helper}`).toBeDefined();
      expect(corpo).toContain('tenant_id');
      expect(corpo).toContain('agent_id');
    }
  });

  it('todo UPDATE de import-review.ts tem tenant_id E agent_id no WHERE', () => {
    const updates = expressoes(fonteReview, '.update(');
    // Guarda contra a sonda virar vácuo: se um refactor renomear/remover os
    // UPDATEs, zero expressões passariam vacuamente.
    expect(updates.length).toBeGreaterThanOrEqual(3);

    const semEscopo = updates
      .map((u) => ({ u, where: argumentoDoWhere(u) }))
      .filter(({ where }) => where === null || !ehEscopado(where))
      .map(({ u }) => u.split('\n').slice(0, 3).join('\n'));

    expect(semEscopo, `UPDATE sem predicado de escopo:\n${semEscopo.join('\n---\n')}`).toEqual([]);
  });

  it('todo UPDATE de import-review.ts verifica quantas linhas casou (.returning)', () => {
    // O predicado sozinho transforma um write cross-tenant em NO-OP silencioso:
    // a entry seria marcada resolvida com a transação nunca confirmada, e a run
    // fecharia como `aplicado` mentindo. `.returning()` + contagem é o que torna
    // a recusa observável (mesmo raciocínio de `contasRepo.addToBalance`).
    const updates = expressoes(fonteReview, '.update(');
    const semReturning = updates.filter((u) => !u.includes('.returning('));
    expect(semReturning.map((u) => u.split('\n')[0])).toEqual([]);
    expect(fonteReview).toContain('CrossScopeWriteError');
  });

  it('todo INSERT das duas CLIs passa por applyTenantGuard', () => {
    for (const [nome, fonte] of [
      ['import-review.ts', fonteReview],
      ['import-ofx.ts', fonteOfx],
    ] as const) {
      const inserts = expressoes(fonte, '.insert(');
      expect(inserts.length, `${nome}: nenhum INSERT encontrado`).toBeGreaterThanOrEqual(1);
      const semGuarda = inserts
        .filter((i) => !i.includes('applyTenantGuard('))
        .map((i) => i.split('\n')[0]);
      expect(semGuarda, `${nome}: INSERT sem applyTenantGuard`).toEqual([]);
    }
  });

  it('as duas CLIs abrem runWithTenantContext e exigem --tenant/--agent sem default', () => {
    for (const [nome, fonte] of [
      ['import-review.ts', fonteReview],
      ['import-ofx.ts', fonteOfx],
    ] as const) {
      expect(fonte, `${nome}: não entra em contexto de tenant`).toContain(
        'runWithTenantContext(',
      );
      expect(fonte, `${nome}: não falha fechado por argumento ausente`).toContain(
        'RequiredArgsError',
      );
      // Nenhum `?? 'algum-default'` para a tupla: o escopo é declarado ou a CLI para.
      expect(fonte).not.toMatch(/tenant_id\s*=\s*[^;\n]*\?\?\s*['"]/);
      expect(fonte).not.toMatch(/agent_id\s*=\s*[^;\n]*\?\?\s*['"]/);
    }
  });
});
