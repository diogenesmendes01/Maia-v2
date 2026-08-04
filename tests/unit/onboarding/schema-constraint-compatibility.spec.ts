/**
 * Issue #519 — prova SEM BANCO de que todo literal de enum/status que a saga
 * pode ESCREVER é admitido pelo `CHECK` real da coluna.
 *
 * Motivação, com nome e sobrenome. Dois defeitos da MESMA classe passaram por
 * toda a suíte unitária e só apareceram quando o CI subiu um Postgres:
 *
 *   1. `agents.status = 'provisioning'` contra
 *      `CHECK (status IN ('active','paused','archived'))`
 *      (`migrations/007_p0_tenants_agents.sql:17`) — 23514 no passo
 *      `provision_agent`.
 *   2. `channel_policies.switch_behavior = 'fixed'` (e `'by_command'`) contra
 *      `CHECK (switch_behavior IN ('locked','prefer_handoff','free_with_trigger','by_context'))`
 *      (`migrations/033_p6_channel_policies.sql:10`) — 23514 no passo
 *      `declare_channel`, que os testes de integração nem alcançavam porque a
 *      run já morria antes.
 *
 * Por que nada pegou: os testes unitários usam store falso, e um store falso
 * aceita qualquer string. O CHECK só existe no banco, e o banco só existe na
 * lane com `TEST_DB_URL`.
 *
 * Este teste fecha a lacuna lendo o SCHEMA COMO FONTE: parseia
 * `migrations/*.sql` na ordem de aplicação, reconstrói o CHECK EFETIVO de cada
 * coluna (honrando o padrão `DROP CONSTRAINT` + `ADD CONSTRAINT` que as
 * migrations de alargamento usam) e afirma `literais do código ⊆ CHECK`.
 * Um literal novo que o schema não admita falha aqui, em segundos, sem banco.
 */
import { describe, it, expect } from 'vitest';
import {
  effectiveCheckIn,
  forwardMigrations,
  statements,
} from './_migration-schema.js';

import {
  SAGA_ENUM_WRITES,
  SWITCH_BEHAVIOR_DEFAULT,
} from '../../../src/onboarding/provisioning.js';
import {
  AUDIT_FALLBACK_TENANT,
  ONBOARDING_EVENT_TYPES,
} from '../../../src/db/repositories/onboarding-repos.js';
import { ONBOARDING_STATES } from '../../../src/onboarding/state-machine.js';
import { OWNERSHIP_PROVEN_LINE_STATES } from '../../../src/onboarding/readiness.js';

function expectSubset(
  label: string,
  written: readonly string[],
  admitted: { set: string[]; source: string },
): void {
  const rejected = written.filter((v) => !admitted.set.includes(v));
  expect(
    rejected,
    `${label}: o código escreve ${JSON.stringify(rejected)}, que o CHECK definido em ` +
      `${admitted.source} NÃO admite (admitidos: ${JSON.stringify(admitted.set)}). ` +
      'Isso é um 23514 garantido contra Postgres real — ou o literal está errado, ' +
      'ou falta uma migration alargando o CHECK.',
  ).toEqual([]);
}

describe('onboarding — literais do código vs. CHECK real das migrations', () => {
  it('o parser enxerga o alargamento de agents.status para provisioning', () => {
    // Guarda do próprio parser: se ele parasse de honrar o par DROP/ADD, todos
    // os outros casos passariam por vacuidade contra o CHECK antigo.
    const agents = effectiveCheckIn('agents', 'status');
    expect(agents.source).toBe('110_agents_status_provisioning.sql');
    expect(agents.set.sort()).toEqual(['active', 'archived', 'paused', 'provisioning']);
  });

  it.each(Object.entries(SAGA_ENUM_WRITES))(
    '%s: todo literal escrito pela saga é admitido pelo CHECK',
    (key, written) => {
      const [table, column] = key.split('.') as [string, string];
      expectSubset(key, written, effectiveCheckIn(table, column));
    },
  );

  it('o default de switch_behavior é admitido (é o valor que a UI omite)', () => {
    expectSubset(
      'channel_policies.switch_behavior (default)',
      [SWITCH_BEHAVIOR_DEFAULT],
      effectiveCheckIn('channel_policies', 'switch_behavior'),
    );
  });

  it('todo estado da máquina é admitido por onboarding_runs.state', () => {
    expectSubset(
      'onboarding_runs.state',
      ONBOARDING_STATES,
      effectiveCheckIn('onboarding_runs', 'state'),
    );
  });

  it('todo event_type que o repo escreve é admitido por onboarding_events', () => {
    expectSubset(
      'onboarding_events.event_type',
      Object.values(ONBOARDING_EVENT_TYPES),
      effectiveCheckIn('onboarding_events', 'event_type'),
    );
  });

  it('os dois kinds de run são admitidos por onboarding_runs.kind', () => {
    expectSubset(
      'onboarding_runs.kind',
      ['global_bootstrap', 'tenant_onboarding'],
      effectiveCheckIn('onboarding_runs', 'kind'),
    );
  });

  it('os estados de linha que PROVAM posse existem no vocabulário de #518', () => {
    // Classe irmã: um literal que o código LÊ e o CHECK não admite não estoura
    // 23514 — vira um check de readiness que nunca passa. Silencioso e pior.
    expectSubset(
      'channel_line_state.state (lido por readiness)',
      OWNERSHIP_PROVEN_LINE_STATES,
      effectiveCheckIn('channel_line_state', 'state'),
    );
  });
});

describe('onboarding — alvos de FK que a saga referencia', () => {
  it('o bucket de auditoria é um tenant REALMENTE semeado por uma migration', () => {
    // `admin_audit_log.tenant_id` é FK para `tenants(id)`. O fallback só é
    // válido porque `014_p0_seed_system_tenant.sql` insere a linha; se aquela
    // migration sumisse, TODA run de onboarding voltaria a estourar 23503.
    const seeded = forwardMigrations().some(({ sql }) =>
      statements(sql).some(
        (stmt) =>
          /^INSERT\s+INTO\s+tenants\b/i.test(stmt) &&
          new RegExp(`'${AUDIT_FALLBACK_TENANT}'`).test(stmt),
      ),
    );
    expect(
      seeded,
      `nenhuma migration semeia tenants('${AUDIT_FALLBACK_TENANT}') — ` +
        'o fallback de auditoria da saga violaria a FK admin_audit_log_tenant_id_fkey',
    ).toBe(true);
  });

  it('admin_audit_log.tenant_id é FK (e não apenas NOT NULL)', () => {
    // O comentário original em onboarding-repos.ts dizia "é NOT NULL" e por
    // isso a correção parou em `?? 'system'`. Este teste ancora o fato real:
    // se a FK sumir, o fallback deixa de ser necessário e alguém precisa
    // reavaliar `resolveAuditTenant` conscientemente.
    const hasFk = forwardMigrations().some(({ sql }) =>
      statements(sql).some(
        (stmt) =>
          /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?admin_audit_log\b/i.test(stmt) &&
          /tenant_id\s+TEXT\s+NOT\s+NULL\s+REFERENCES\s+tenants\s*\(\s*id\s*\)/i.test(stmt),
      ),
    );
    expect(hasFk).toBe(true);
  });
});
