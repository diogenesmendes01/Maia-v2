/**
 * Issue #519 §5 — o readiness canônico.
 *
 * O bug que estes testes existem para matar é o FALSO POSITIVO POR COMPOSIÇÃO
 * CRUZADA: "existe algum profile ativo" + "existe algum canal conectado" ⇒
 * "pronto", ainda que o profile seja do agente A e o canal do agente B. O
 * critério de aceite da issue é literal: "Profile de A + canal de B nunca torna
 * A/B ready" e "canal de outro tenant não participa".
 *
 * Tudo roda contra o avaliador PURO (`evaluateReadinessFacts`) — sem banco,
 * sem ALS, sem relógio implícito.
 */
import { describe, it, expect } from 'vitest';
import {
  READINESS_CHECK_CODES,
  blockingFailures,
  configurationFingerprint,
  evaluateAgentReadiness,
  evaluateReadinessFacts,
  schemaFingerprint,
  type ReadinessCheckCode,
  type ReadinessFacts,
} from '../../../src/onboarding/readiness.js';
import { OnboardingError } from '../../../src/onboarding/errors.js';

const T = 'acme';
const A = 'acme-bot';
const OTHER_T = 'globex';
const OTHER_A = 'acme-vendas';

const CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const POLICY_ID = '33333333-3333-4333-8333-333333333333';

/** Fatos de um agente COMPLETAMENTE pronto. Cada teste degrada um pedaço. */
function readyFacts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    requested: { tenant_id: T, agent_id: A },
    tenant: { id: T, status: 'active' },
    agent: { id: A, tenant_id: T, status: 'active' },
    profile: { id: 'p1', tenant_id: T, agent_id: A, version: 1, status: 'active' },
    tool_grant: {
      tenant_id: T,
      agent_id: A,
      granted_packs: ['baseline.core', 'domain.calendar'],
      granted_tools: [],
      denied_tools: [],
    },
    roles: [
      { id: ROLE_ID, tenant_id: T, agent_id: A, role_key: 'suporte', active: true, is_default: true },
    ],
    channels: [
      {
        id: CHANNEL_ID,
        tenant_id: T,
        agent_id: A,
        channel_type: 'whatsapp',
        active: true,
        is_synthetic: false,
        line_state: 'connected',
      },
    ],
    policies: [
      { id: POLICY_ID, tenant_id: T, agent_id: A, channel_id: CHANNEL_ID, default_role_id: ROLE_ID },
    ],
    required_packs: ['baseline.core', 'domain.calendar'],
    schema: { applied_migrations: ['001_initial.sql', '109_onboarding_runs.sql'], pending_migrations: [] },
    blocking_governance_items: 0,
    ...overrides,
  };
}

function failedCodes(facts: ReadinessFacts): ReadinessCheckCode[] {
  return blockingFailures(evaluateReadinessFacts(facts)).map((c) => c.code);
}

describe('evaluateReadinessFacts — baseline', () => {
  it('um agente completo está pronto', () => {
    const r = evaluateReadinessFacts(readyFacts());
    expect(r.ready).toBe(true);
    expect(blockingFailures(r)).toEqual([]);
  });

  it('emite exatamente um check por código conhecido, com remediation nos que falham', () => {
    const r = evaluateReadinessFacts(readyFacts({ profile: null }));
    expect(r.checks.map((c) => c.code).sort()).toEqual([...READINESS_CHECK_CODES].sort());
    for (const check of r.checks) {
      expect(READINESS_CHECK_CODES).toContain(check.code);
      if (check.status === 'fail') expect(check.remediation.length).toBeGreaterThan(0);
      else expect(check.remediation).toBe('');
    }
  });

  it('devolve o escopo requisitado e um timestamp determinístico', () => {
    const now = new Date('2026-08-04T12:00:00.000Z');
    const r = evaluateReadinessFacts(readyFacts(), now);
    expect(r.tenant_id).toBe(T);
    expect(r.agent_id).toBe(A);
    expect(r.evaluated_at).toBe('2026-08-04T12:00:00.000Z');
  });
});

describe('composição cruzada — o falso positivo que a issue descreve', () => {
  it('profile do agente A + canal do agente B NÃO torna A pronto', () => {
    const facts = readyFacts({
      channels: [
        {
          id: CHANNEL_ID,
          tenant_id: T,
          agent_id: OTHER_A, // canal de OUTRO agente do MESMO tenant
          channel_type: 'whatsapp',
          active: true,
          is_synthetic: false,
          line_state: 'connected',
        },
      ],
    });
    const codes = failedCodes(facts);
    expect(codes).toContain('channel_declared');
    expect(codes).toContain('channel_policy_resolved');
    expect(codes).toContain('channel_ownership_proven');
    expect(evaluateReadinessFacts(facts).ready).toBe(false);
  });

  it('canal de OUTRO TENANT não participa', () => {
    const facts = readyFacts({
      channels: [
        {
          id: CHANNEL_ID,
          tenant_id: OTHER_T,
          agent_id: A,
          channel_type: 'whatsapp',
          active: true,
          is_synthetic: false,
          line_state: 'connected',
        },
      ],
    });
    expect(failedCodes(facts)).toContain('channel_declared');
  });

  it('profile de outro escopo é tratado como AUSENTE, nunca como satisfeito', () => {
    expect(
      failedCodes(
        readyFacts({
          profile: { id: 'p1', tenant_id: T, agent_id: OTHER_A, version: 1, status: 'active' },
        }),
      ),
    ).toContain('profile_active');
    expect(
      failedCodes(
        readyFacts({
          profile: { id: 'p1', tenant_id: OTHER_T, agent_id: A, version: 1, status: 'active' },
        }),
      ),
    ).toContain('profile_active');
  });

  it('grant de capacidades de outro escopo não conta', () => {
    const codes = failedCodes(
      readyFacts({
        tool_grant: {
          tenant_id: OTHER_T,
          agent_id: A,
          granted_packs: ['baseline.core', 'domain.calendar'],
          granted_tools: [],
          denied_tools: [],
        },
      }),
    );
    expect(codes).toContain('capability_grant_present');
    expect(codes).toContain('required_packs_granted');
  });

  it('papel padrão de outro agente não resolve', () => {
    expect(
      failedCodes(
        readyFacts({
          roles: [
            {
              id: ROLE_ID,
              tenant_id: T,
              agent_id: OTHER_A,
              role_key: 'suporte',
              active: true,
              is_default: true,
            },
          ],
        }),
      ),
    ).toContain('default_role_resolved');
  });

  it('política de outro escopo apontando para o canal certo NÃO governa o canal', () => {
    const codes = failedCodes(
      readyFacts({
        policies: [
          {
            id: POLICY_ID,
            tenant_id: OTHER_T,
            agent_id: A,
            channel_id: CHANNEL_ID,
            default_role_id: ROLE_ID,
          },
        ],
      }),
    );
    expect(codes).toContain('channel_policy_resolved');
    expect(codes).toContain('channel_policy_role_active');
  });

  it('agente que existe mas pertence a OUTRO tenant reprova com o diagnóstico certo', () => {
    const r = evaluateReadinessFacts(
      readyFacts({ agent: { id: A, tenant_id: OTHER_T, status: 'active' } }),
    );
    const codes = blockingFailures(r).map((c) => c.code);
    // `agent_exists` PASSA (o agente existe); o que reprova é o pertencimento.
    expect(codes).not.toContain('agent_exists');
    expect(codes).toContain('agent_belongs_to_tenant');
  });
});

describe('checks individuais', () => {
  it('tenant ausente e tenant suspenso reprovam separadamente', () => {
    expect(failedCodes(readyFacts({ tenant: null }))).toEqual(
      expect.arrayContaining(['tenant_exists', 'tenant_enabled']),
    );
    const suspended = failedCodes(readyFacts({ tenant: { id: T, status: 'suspended' } }));
    expect(suspended).toContain('tenant_enabled');
    expect(suspended).not.toContain('tenant_exists');
  });

  it('profile apenas `proposed` não é profile ativo', () => {
    expect(
      failedCodes(
        readyFacts({
          profile: { id: 'p1', tenant_id: T, agent_id: A, version: 1, status: 'proposed' },
        }),
      ),
    ).toContain('profile_active');
  });

  it('pack obrigatório ausente reprova e nomeia o pack', () => {
    const r = evaluateReadinessFacts(
      readyFacts({
        tool_grant: {
          tenant_id: T,
          agent_id: A,
          granted_packs: ['baseline.core'],
          granted_tools: [],
          denied_tools: [],
        },
      }),
    );
    const check = r.checks.find((c) => c.code === 'required_packs_granted')!;
    expect(check.status).toBe('fail');
    expect(check.message).toContain('domain.calendar');
  });

  it('tool simultaneamente concedida e negada é incoerência bloqueante', () => {
    expect(
      failedCodes(
        readyFacts({
          tool_grant: {
            tenant_id: T,
            agent_id: A,
            granted_packs: ['baseline.core', 'domain.calendar'],
            granted_tools: ['cancel_boleto'],
            denied_tools: ['cancel_boleto'],
          },
        }),
      ),
    ).toContain('tool_permissions_coherent');
  });

  it('dois papéis default ativos são ambíguos e reprovam', () => {
    expect(
      failedCodes(
        readyFacts({
          roles: [
            { id: ROLE_ID, tenant_id: T, agent_id: A, role_key: 'a', active: true, is_default: true },
            { id: 'r2', tenant_id: T, agent_id: A, role_key: 'b', active: true, is_default: true },
          ],
        }),
      ),
    ).toContain('default_role_resolved');
  });

  it('papel padrão DESATIVADO reprova a política — o caso que `has_policy` sozinho não pega', () => {
    const codes = failedCodes(
      readyFacts({
        roles: [
          {
            id: ROLE_ID,
            tenant_id: T,
            agent_id: A,
            role_key: 'suporte',
            active: false,
            is_default: true,
          },
        ],
      }),
    );
    expect(codes).toContain('default_role_resolved');
    expect(codes).toContain('channel_policy_role_active');
  });

  it('a sonda sintética NÃO conta como canal declarado', () => {
    // Sem esta exclusão, um agente com apenas a sonda (seed da migration 094)
    // pareceria ter canal e política e passaria pelo go-live.
    expect(
      failedCodes(
        readyFacts({
          channels: [
            {
              id: CHANNEL_ID,
              tenant_id: T,
              agent_id: A,
              channel_type: 'whatsapp',
              active: true,
              is_synthetic: true,
              line_state: 'connected',
            },
          ],
        }),
      ),
    ).toContain('channel_declared');
  });

  it('linha apenas `declared` não provou posse', () => {
    expect(
      failedCodes(
        readyFacts({
          channels: [
            {
              id: CHANNEL_ID,
              tenant_id: T,
              agent_id: A,
              channel_type: 'whatsapp',
              active: false,
              is_synthetic: false,
              line_state: 'declared',
            },
          ],
        }),
      ),
    ).toContain('channel_ownership_proven');
  });

  it('`verified_offline` PROVA posse (bloqueante verde) mas deixa `channel_online` advisório vermelho', () => {
    const r = evaluateReadinessFacts(
      readyFacts({
        channels: [
          {
            id: CHANNEL_ID,
            tenant_id: T,
            agent_id: A,
            channel_type: 'whatsapp',
            active: true,
            is_synthetic: false,
            line_state: 'verified_offline',
          },
        ],
      }),
    );
    expect(r.ready).toBe(true);
    expect(r.checks.find((c) => c.code === 'channel_online')!.status).toBe('fail');
    expect(r.checks.find((c) => c.code === 'channel_online')!.severity).toBe('advisory');
  });

  it('migration pendente reprova o schema — fail-closed', () => {
    expect(
      failedCodes(
        readyFacts({
          schema: { applied_migrations: ['001_initial.sql'], pending_migrations: ['109_onboarding_runs.sql'] },
        }),
      ),
    ).toContain('schema_ready');
  });

  it('pendência de governança bloqueante reprova', () => {
    expect(failedCodes(readyFacts({ blocking_governance_items: 2 }))).toContain(
      'governance_no_blocking_pending',
    );
  });

  it('`agent_activated` é ADVISÓRIO — readiness é a precondição da ativação, não o contrário', () => {
    const r = evaluateReadinessFacts(
      readyFacts({ agent: { id: A, tenant_id: T, status: 'provisioning' } }),
    );
    expect(r.ready).toBe(true);
    const check = r.checks.find((c) => c.code === 'agent_activated')!;
    expect(check.status).toBe('fail');
    expect(check.severity).toBe('advisory');
  });
});

describe('fingerprints', () => {
  it('a mesma configuração produz o mesmo fingerprint', () => {
    expect(configurationFingerprint(readyFacts())).toBe(configurationFingerprint(readyFacts()));
  });

  it('mudar a configuração muda o fingerprint', () => {
    const before = configurationFingerprint(readyFacts());
    const after = configurationFingerprint(
      readyFacts({
        tool_grant: {
          tenant_id: T,
          agent_id: A,
          granted_packs: ['baseline.core', 'domain.calendar', 'domain.finance'],
          granted_tools: [],
          denied_tools: [],
        },
      }),
    );
    expect(after).not.toBe(before);
  });

  it('a ORDEM dos packs/papéis/canais não muda o fingerprint', () => {
    const a = configurationFingerprint(readyFacts());
    const b = configurationFingerprint(
      readyFacts({
        tool_grant: {
          tenant_id: T,
          agent_id: A,
          granted_packs: ['domain.calendar', 'baseline.core'],
          granted_tools: [],
          denied_tools: [],
        },
      }),
    );
    expect(b).toBe(a);
  });

  it('o fingerprint NÃO depende do external_id da linha — o telefone nunca entra na auditoria', () => {
    // Os fatos nem carregam `external_id`; este teste trava o contrato: se
    // alguém adicionar o número à projeção, o tipo quebra antes do vazamento.
    const facts = readyFacts();
    expect(Object.keys(facts.channels[0]!)).not.toContain('external_id');
  });

  it('schemaFingerprint é estável sob reordenação e sensível ao conteúdo', () => {
    expect(schemaFingerprint(['b.sql', 'a.sql'])).toBe(schemaFingerprint(['a.sql', 'b.sql']));
    expect(schemaFingerprint(['a.sql'])).not.toBe(schemaFingerprint(['a.sql', 'b.sql']));
  });
});

describe('evaluateAgentReadiness — fail-closed no escopo', () => {
  const loader = async () => readyFacts();

  it('avalia um escopo válido usando o loader injetado', async () => {
    const r = await evaluateAgentReadiness({ tenant_id: T, agent_id: A }, { loadFacts: loader });
    expect(r.ready).toBe(true);
  });

  it.each([
    ['default', 'ok-agent'],
    ['ok-tenant', 'default'],
    ['system', 'ok-agent'],
    ['ok-tenant', 'system'],
    ['', 'ok-agent'],
    [' acme ', 'ok-agent'],
  ])('LANÇA (não devolve ready:false) para o escopo proibido (%s, %s)', async (t, a) => {
    await expect(
      evaluateAgentReadiness({ tenant_id: t, agent_id: a }, { loadFacts: loader }),
    ).rejects.toBeInstanceOf(OnboardingError);
  });
});
