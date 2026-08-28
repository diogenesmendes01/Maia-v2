import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ADMIN_ROLES } from '@/onboarding/provisioning.js';
import { AUDIT_ACTIONS } from '@/governance/audit-actions.js';

/**
 * #519 — as duas garantias que faltavam quando o bootstrap foi fiado, e que
 * eu tinha DOCUMENTADO sem ligar:
 *
 *   1. o marcador de conclusão (`bootstrap_completions`) precisa ser gravado,
 *      na MESMA transação que cria o founder;
 *   2. o primeiro administrador precisa ser `founder`, e o papel é decidido
 *      pelo BACKEND — não proposto pelo chamador.
 *
 * Sem (1), `isBootstrapCompleted()` responde `false` para sempre e uma segunda
 * credencial pode ser emitida depois de um bootstrap bem-sucedido: o "bloqueio
 * definitivo" descrito na migration 136 simplesmente não engata.
 *
 * Sem (2), o bootstrap produz um `owner` escopado ao tenant, o sistema fica
 * sem identidade administrativa GLOBAL, e a pré-condição do próprio bootstrap
 * continua verdadeira — permitindo repetir o processo indefinidamente.
 */

const PROVISIONING = join(process.cwd(), 'src/onboarding/provisioning.ts');
const fonte = (): string => readFileSync(PROVISIONING, 'utf8');

describe('#519 — founder e marcador de conclusão do bootstrap', () => {
  it('`ADMIN_ROLES` NÃO admite `founder` (é o que impede tenant comum de cunhar identidade global)', () => {
    // Esta exclusão é a defesa. Se `founder` entrar no vocabulário do payload,
    // qualquer onboarding de tenant passa a poder criar uma identidade
    // administrativa GLOBAL — que a issue proíbe explicitamente ("não cria
    // novo founder global" para tenants seguintes).
    expect(
      (ADMIN_ROLES as readonly string[]).includes('founder'),
      'founder entrou em ADMIN_ROLES. Isso permite que o onboarding de um ' +
        'tenant qualquer crie identidade administrativa GLOBAL. O bootstrap ' +
        'não precisa disso: ele FORÇA o papel no backend.',
    ).toBe(false);
  });

  it('o papel do bootstrap é FORÇADO pelo backend, não lido do payload', () => {
    const s = fonte();
    expect(s).toMatch(/const papel = ehBootstrap \? 'founder' : payload\.role;/);
    // E o INSERT tem de usar a variável forçada, não o payload cru — trocar de
    // volta faria o bootstrap gravar `owner` sem nenhum teste de comportamento
    // reclamar, porque o INSERT continua funcionando.
    const bloco = s.slice(s.indexOf('export async function applyProvisionAdmin'));
    const insert = bloco.slice(0, bloco.indexOf('.onConflictDoNothing()'));
    expect(
      /role: payload\.role,/.test(insert),
      'o INSERT voltou a usar `payload.role`. No bootstrap isso grava `owner` ' +
        'e o sistema fica sem founder global.',
    ).toBe(false);
    expect(insert).toMatch(/role: papel,/);
  });

  it('o marcador é gravado na MESMA transação (recebe `tx`, não abre a sua)', () => {
    const s = fonte();
    expect(s).toMatch(/markBootstrapCompletedTx\(tx, \{/);
    // A variante que abre transação própria (`markBootstrapCompleted`, sem Tx)
    // NÃO pode ser usada aqui: duas transações separadas deixam founder sem
    // marcador, ou marcador sem founder, se houver crash entre elas.
    expect(
      /\bmarkBootstrapCompleted\(/.test(s),
      'applyProvisionAdmin usa a variante SEM transação. Um crash entre as ' +
        'duas transações deixa o sistema incoerente: founder sem marcador (o ' +
        'bloqueio nunca engata) ou marcador sem founder (bootstrap travado).',
    ).toBe(false);
  });

  it('a auditoria do bootstrap é `bootstrap_initial_admin_created`, e ela está declarada', () => {
    expect(fonte()).toMatch(/ehBootstrap \? 'bootstrap_initial_admin_created'/);
    // Declarada E emitida — o par que a #535 registra como dívida quando só
    // metade existe.
    expect((AUDIT_ACTIONS as readonly string[])).toContain('bootstrap_initial_admin_created');
  });

  it('run de bootstrap sem credencial rastreável falha fechado', () => {
    // `created_by` de uma run de bootstrap é `bootstrap:<credential_id>`,
    // montado por `startGlobalBootstrapRun` DEPOIS do resgate. Uma run sem
    // esse prefixo não deveria existir; gravar o marcador assim mesmo
    // registraria uma conclusão sem procedência.
    expect(fonte()).toMatch(/bootstrap_not_allowed/);
    expect(fonte()).toMatch(/run de bootstrap sem credencial de origem rastreável/);
  });
});
