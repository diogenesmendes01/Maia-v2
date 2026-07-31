/**
 * Issue #519 §5 — readiness CANÔNICO por (tenant, agente).
 *
 * O que estes testes travam (critérios de aceite literais da issue):
 *   - "Profile de A + canal de B nunca torna A/B ready";
 *   - "Canal de outro tenant não participa";
 *   - "Cada check possui código estável e remediation";
 *   - "Agente só ativa com todos os checks bloqueantes verdes";
 *   - "Mudança de configuração invalida/recalcula fingerprint".
 *
 * As dependências são injetadas — a avaliação inteira roda sem Postgres, que é
 * o ponto de o módulo aceitar `ReadinessDeps`.
 */
import { describe, it, expect } from 'vitest';
import {
  blockingFailures,
  evaluateAgentReadiness,
  READINESS_CHECK_CODES,
  type ReadinessDeps,
} from '@/onboarding/readiness.js';

const TENANT = 'acme';
const AGENT = 'atendimento';

function line(over: Record<string, unknown> = {}) {
  return {
    channel_id: '11111111-1111-4111-8111-111111111111',
    tenant_id: TENANT,
    agent_id: AGENT,
    external_id: '+5511900001111',
    channel_type: 'whatsapp',
    display_name: 'Linha comercial',
    active: true,
    is_synthetic: false,
    state: 'connected',
    pairing_method: null,
    pairing_started_at: null,
    pairing_expires_at: null,
    pairing_attempts: 1,
    reason_code: null,
    verified_at: new Date('2026-07-01T10:00:00Z'),
    connected_at: new Date('2026-07-01T10:00:05Z'),
    disconnected_at: null,
    last_transition_at: null,
    command: null,
    ...over,
  };
}

interface Overrides {
  tenant?: Record<string, unknown> | null;
  agent?: Record<string, unknown> | null;
  profile?: Record<string, unknown> | null;
  grant?: Record<string, unknown> | null;
  role?: Record<string, unknown> | null;
  policy?: Record<string, unknown> | null;
  lines?: Array<Record<string, unknown>>;
  migrations?: string[];
}

function deps(over: Overrides = {}): ReadinessDeps {
  const role =
    over.role === undefined ? { id: 'role-1', role_key: 'atendente', active: true } : over.role;
  return {
    tenantsRepo: {
      findById: async () =>
        (over.tenant === undefined
          ? { id: TENANT, nome: 'Acme', status: 'active' }
          : over.tenant) as never,
    },
    agentsRepo: {
      findById: async () =>
        (over.agent === undefined
          ? { id: AGENT, tenant_id: TENANT, nome: 'Atendimento', status: 'paused' }
          : over.agent) as never,
    },
    operationalProfileVersionsRepo: {
      getActive: async () =>
        (over.profile === undefined
          ? { id: 'profile-1', version: 3, status: 'active' }
          : over.profile) as never,
    },
    rolesRepo: { getDefault: async () => role as never },
    channelPoliciesRepo: {
      getByChannelId: async () =>
        (over.policy === undefined
          ? { id: 'policy-1', default_role_id: 'role-1' }
          : over.policy) as never,
    },
    agentToolGrantsRepo: {
      findForCurrentAgent: async () =>
        (over.grant === undefined
          ? { id: 'grant-1', granted_packs: ['baseline.core', 'domain.calendar'] }
          : over.grant) as never,
    },
    channelLineStateRepo: {
      listLinesForScope: async () => (over.lines ?? [line()]) as never,
    },
    appliedMigrations: async () => over.migrations ?? ['001_initial.sql', '113_onboarding_runs.sql'],
    // Passthrough: não há ALS num teste unitário.
    withScope: (_scope, fn) => fn(),
  };
}

describe('issue #519 — evaluateAgentReadiness', () => {
  it('aprova a configuração completa e coerente', async () => {
    const r = await evaluateAgentReadiness(TENANT, AGENT, deps());
    expect(blockingFailures(r)).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it('cobre TODOS os códigos de check declarados — nenhum fica órfão', async () => {
    const r = await evaluateAgentReadiness(TENANT, AGENT, deps());
    const emitted = new Set(r.checks.map((c) => c.code));
    for (const code of READINESS_CHECK_CODES) {
      expect(emitted.has(code), `check ausente: ${code}`).toBe(true);
    }
  });

  it('todo check que falha traz uma remediação acionável', async () => {
    const r = await evaluateAgentReadiness(TENANT, AGENT, deps({ profile: null, policy: null }));
    const failures = r.checks.filter((c) => c.status !== 'pass');
    expect(failures.length).toBeGreaterThan(0);
    for (const c of failures) {
      expect(c.remediation, c.code).toBeTruthy();
      expect(c.message, c.code).toBeTruthy();
    }
  });

  it('agente de OUTRO tenant nunca torna o par pronto', async () => {
    const r = await evaluateAgentReadiness(
      TENANT,
      AGENT,
      deps({ agent: { id: AGENT, tenant_id: 'outro-tenant', nome: 'X', status: 'active' } }),
    );
    expect(r.ready).toBe(false);
    expect(blockingFailures(r)).toContain('agent_in_tenant');
    // E os checks seguintes são marcados como não avaliados, não como
    // aprovados — não existe "meio pronto".
    const profileCheck = r.checks.find((c) => c.code === 'agent_profile_active');
    expect(profileCheck?.status).toBe('skipped');
  });

  it('linha de outro tenant/agente na listagem é falha de integridade, não evidência', async () => {
    // Cobre "Profile de A + canal de B nunca torna A/B ready": mesmo que a
    // consulta devolvesse uma linha alheia (bug de repo), o laudo recusa.
    const r = await evaluateAgentReadiness(
      TENANT,
      AGENT,
      deps({ lines: [line({ agent_id: 'outro-agente' })] }),
    );
    expect(r.ready).toBe(false);
    expect(blockingFailures(r)).toContain('whatsapp_line_scope');
  });

  it('linha sem posse provada bloqueia — declarar o número não basta', async () => {
    const r = await evaluateAgentReadiness(
      TENANT,
      AGENT,
      deps({ lines: [line({ verified_at: null, active: false, state: 'declared' })] }),
    );
    expect(r.ready).toBe(false);
    expect(blockingFailures(r)).toContain('whatsapp_line_verified');
  });

  it('sonda sintética não conta como linha de produção', async () => {
    const r = await evaluateAgentReadiness(
      TENANT,
      AGENT,
      deps({ lines: [line({ is_synthetic: true })] }),
    );
    expect(blockingFailures(r)).toContain('whatsapp_line_declared');
  });

  it('política apontando para papel que não é o padrão ativo bloqueia', async () => {
    // O caso sutil: a política EXISTE (`has_policy` seria verdadeiro), mas
    // nomeia um papel que não é o padrão ativo deste agente.
    const r = await evaluateAgentReadiness(
      TENANT,
      AGENT,
      deps({ policy: { id: 'policy-1', default_role_id: 'role-de-outro-agente' } }),
    );
    expect(r.ready).toBe(false);
    expect(blockingFailures(r)).toContain('channel_policy_resolved');
  });

  it('papel padrão DESATIVADO bloqueia mesmo com política presente', async () => {
    const r = await evaluateAgentReadiness(
      TENANT,
      AGENT,
      deps({ role: { id: 'role-1', role_key: 'atendente', active: false } }),
    );
    expect(r.ready).toBe(false);
    expect(blockingFailures(r)).toContain('default_role_active');
  });

  it('tenant suspenso bloqueia', async () => {
    const r = await evaluateAgentReadiness(
      TENANT,
      AGENT,
      deps({ tenant: { id: TENANT, nome: 'Acme', status: 'suspended' } }),
    );
    expect(r.ready).toBe(false);
    expect(blockingFailures(r)).toContain('tenant_active');
  });

  it('banco sem controle de schema bloqueia (fail-closed)', async () => {
    const r = await evaluateAgentReadiness(TENANT, AGENT, deps({ migrations: [] }));
    expect(r.ready).toBe(false);
    expect(blockingFailures(r)).toContain('schema_applied');
  });

  it('roteamento inativo é INFORMATIVO — não trava a ativação do agente', async () => {
    // Se fosse bloqueante, os dois gates esperariam um pelo outro: a #518 só
    // ativa o roteamento quando a política fica pronta, e a política fica
    // pronta aqui.
    const r = await evaluateAgentReadiness(TENANT, AGENT, deps({ lines: [line({ active: false })] }));
    expect(r.ready).toBe(true);
    const check = r.checks.find((c) => c.code === 'channel_routing_active');
    expect(check?.severity).toBe('advisory');
    expect(check?.status).toBe('fail');
  });

  it('o fingerprint de configuração muda quando a configuração muda', async () => {
    const a = await evaluateAgentReadiness(TENANT, AGENT, deps());
    const b = await evaluateAgentReadiness(TENANT, AGENT, deps());
    expect(a.configuration_fingerprint).toBe(b.configuration_fingerprint);

    const c = await evaluateAgentReadiness(
      TENANT,
      AGENT,
      deps({ profile: { id: 'profile-2', version: 4, status: 'active' } }),
    );
    expect(c.configuration_fingerprint).not.toBe(a.configuration_fingerprint);

    const d = await evaluateAgentReadiness(
      TENANT,
      AGENT,
      deps({ grant: { id: 'grant-1', granted_packs: ['baseline.core', 'domain.sales'] } }),
    );
    expect(d.configuration_fingerprint).not.toBe(a.configuration_fingerprint);
  });

  it('o fingerprint de schema muda quando o conjunto de migrations muda', async () => {
    const a = await evaluateAgentReadiness(TENANT, AGENT, deps());
    const b = await evaluateAgentReadiness(
      TENANT,
      AGENT,
      deps({ migrations: ['001_initial.sql'] }),
    );
    expect(a.schema_fingerprint).not.toBe(b.schema_fingerprint);
  });

  it('não vaza dado pessoal nas mensagens do laudo', async () => {
    // O número da linha é dado pessoal; ele aparece na tela de canais, mas o
    // laudo é copiado para auditoria e para o evento — e o que entra lá não
    // sai.
    const r = await evaluateAgentReadiness(TENANT, AGENT, deps());
    for (const c of r.checks) {
      expect(c.message).not.toContain('+5511900001111');
      expect(c.remediation ?? '').not.toContain('+5511900001111');
    }
  });
});
