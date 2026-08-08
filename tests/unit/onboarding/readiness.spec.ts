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
  type SchemaFacts,
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
    schema: readySchema(),
    blocking_governance_items: 0,
    ...overrides,
  };
}

/**
 * Schema VERIFICADO — a projeção do veredito canônico de `src/migrations/`
 * (`getSchemaReadiness`). Note que `verified` carrega estado + checksum de cada
 * migration: é ele, e não a lista de ids, que alimenta `schemaFingerprint`.
 */
function readySchema(overrides: Partial<SchemaFacts> = {}): SchemaFacts {
  return {
    ready: true,
    state: 'ready',
    expected_head: '109_onboarding_runs.sql',
    applied_head: '109_onboarding_runs.sql',
    applied_migrations: ['001_initial.sql', '109_onboarding_runs.sql'],
    pending_migrations: [],
    blockers: [],
    verified: [
      { id: '001_initial.sql', state: 'applied', checksum: 'a'.repeat(64) },
      { id: '109_onboarding_runs.sql', state: 'applied', checksum: 'b'.repeat(64) },
    ],
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

/**
 * COMPOSIÇÃO INTRA-AGENTE (review adversarial do PR #541, achado 1).
 *
 * Os testes cross-tenant e cross-agent abaixo não cobrem este caso: aqui TUDO
 * é do mesmo (tenant, agente) e mesmo assim o veredito era um falso positivo,
 * porque `channel_policy_role_active` e `channel_ownership_proven` eram dois
 * `.some()` INDEPENDENTES sobre o conjunto de canais governados.
 *
 * O cenário mínimo que reproduz: dois canais do mesmo agente DIVIDINDO entre si
 * o papel válido e a posse provada. Nenhum dos dois é operável; juntos eles
 * pintavam os dois checks de verde, e a ativação (que selecionava canais só
 * pela existência de política) ligava OS DOIS.
 */
describe('composição INTRA-agente — dois canais dividindo papel válido e posse', () => {
  const CHANNEL_B = '44444444-4444-4444-8444-444444444444';
  const POLICY_B = '55555555-5555-4555-8555-555555555555';
  const INACTIVE_ROLE = '66666666-6666-4666-8666-666666666666';

  /**
   * Canal A: política aponta para papel ATIVO, mas a linha NUNCA provou posse.
   * Canal B: linha `connected` (posse provada), mas a política aponta para um
   *          papel INATIVO.
   */
  function splitFacts(): ReadinessFacts {
    return readyFacts({
      roles: [
        { id: ROLE_ID, tenant_id: T, agent_id: A, role_key: 'suporte', active: true, is_default: true },
        {
          id: INACTIVE_ROLE,
          tenant_id: T,
          agent_id: A,
          role_key: 'vendas',
          active: false,
          is_default: false,
        },
      ],
      channels: [
        {
          id: CHANNEL_ID,
          tenant_id: T,
          agent_id: A,
          channel_type: 'whatsapp',
          active: false,
          is_synthetic: false,
          line_state: 'declared', // posse NÃO provada
        },
        {
          id: CHANNEL_B,
          tenant_id: T,
          agent_id: A,
          channel_type: 'whatsapp',
          active: false,
          is_synthetic: false,
          line_state: 'connected', // posse provada
        },
      ],
      policies: [
        { id: POLICY_ID, tenant_id: T, agent_id: A, channel_id: CHANNEL_ID, default_role_id: ROLE_ID },
        {
          id: POLICY_B,
          tenant_id: T,
          agent_id: A,
          channel_id: CHANNEL_B,
          default_role_id: INACTIVE_ROLE, // papel INATIVO
        },
      ],
    });
  }

  it('NÃO fica pronto: nenhum canal satisfaz política + papel ativo + posse ao mesmo tempo', () => {
    const r = evaluateReadinessFacts(splitFacts());
    expect(r.ready).toBe(false);
    expect(blockingFailures(r).map((c) => c.code)).toContain('channel_ownership_proven');
  });

  it('e nenhum dos dois canais é ativável — a lista que a ativação usa fica VAZIA', () => {
    const r = evaluateReadinessFacts(splitFacts());
    expect(r.activatable_channel_ids).toEqual([]);
    // A exclusão é EXPLÍCITA, por canal e com o código do que reprovou.
    expect(r.channels.find((c) => c.channel_id === CHANNEL_ID)).toMatchObject({
      policy_governed: true,
      policy_role_active: true,
      ownership_proven: false,
      activatable: false,
      failed_checks: ['channel_ownership_proven'],
    });
    expect(r.channels.find((c) => c.channel_id === CHANNEL_B)).toMatchObject({
      policy_governed: true,
      policy_role_active: false,
      ownership_proven: true,
      activatable: false,
      failed_checks: ['channel_policy_role_active'],
    });
  });

  it('a mensagem do veredito NOMEIA os canais governados excluídos', () => {
    const r = evaluateReadinessFacts(splitFacts());
    const check = r.checks.find((c) => c.code === 'channel_ownership_proven')!;
    expect(check.status).toBe('fail');
    expect(check.message).toContain(CHANNEL_ID);
    expect(check.message).toContain(CHANNEL_B);
    expect(check.message).toContain('EXCLUÍDO');
  });

  it('um ÚNICO canal com os três predicados torna pronto — e só ele é ativável', () => {
    // Canal B ganha uma política válida; canal A continua sem posse provada.
    const facts = splitFacts();
    facts.policies = facts.policies.map((p) =>
      p.channel_id === CHANNEL_B ? { ...p, default_role_id: ROLE_ID } : p,
    );
    const r = evaluateReadinessFacts(facts);
    expect(r.ready).toBe(true);
    // FAIL-CLOSED: o canal governado inválido NÃO entra na ativação.
    expect(r.activatable_channel_ids).toEqual([CHANNEL_B]);
    expect(r.checks.find((c) => c.code === 'channel_ownership_proven')!.message).toContain(
      'EXCLUÍDO',
    );
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

  it('agente de OUTRO tenant é INDISTINGUÍVEL de ausência (contrato novo, review do PR #541)', () => {
    // CONTRATO ALTERADO DE PROPÓSITO. Este teste afirmava o oposto: que
    // `agent_exists` PASSAVA para o agente de outro tenant, e só
    // `agent_belongs_to_tenant` reprovava. Aquele "diagnóstico melhor" só era
    // possível porque o loader lia `agents` por `id` SEM o tenant — uma leitura
    // cross-tenant que viola a invariante 1 do AGENTS.md e VAZA EXISTÊNCIA:
    // quem chutasse o id de um agente alheio recebia a confirmação de que ele
    // existe. O teste estava pinando o defeito.
    //
    // Agora os dois checks reprovam JUNTOS e com a MESMA mensagem, e não há
    // resposta do readiness que distinga "não existe" de "é de outro tenant".
    // O diagnóstico global continua disponível, mas numa fronteira separada,
    // autorizada (`founder`) e auditada — `diagnoseAgentOwnershipGlobally`.
    const r = evaluateReadinessFacts(
      readyFacts({ agent: { id: A, tenant_id: OTHER_T, status: 'active' } }),
    );
    const codes = blockingFailures(r).map((c) => c.code);
    expect(codes).toContain('agent_exists');
    expect(codes).toContain('agent_belongs_to_tenant');

    // Indistinguibilidade PROVADA: os checks do agente ausente e do agente
    // alheio são idênticos, código a código, status a status, mensagem a
    // mensagem. Sem esta asserção, uma mensagem diferente reintroduziria o
    // vazamento sem quebrar nada.
    const absent = evaluateReadinessFacts(readyFacts({ agent: null }));
    const project = (x: typeof r) =>
      x.checks
        .filter((c) => c.code === 'agent_exists' || c.code === 'agent_belongs_to_tenant')
        .map((c) => ({ code: c.code, status: c.status, message: c.message }));
    expect(project(r)).toEqual(project(absent));
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
          schema: readySchema({
            ready: false,
            state: 'blocked',
            applied_migrations: ['001_initial.sql'],
            pending_migrations: ['109_onboarding_runs.sql'],
            blockers: [{ kind: 'schema_below_minimum', id: null }],
          }),
        }),
      ),
    ).toContain('schema_ready');
  });

  /**
   * O DEFEITO que a review descreve: o loader lia `schema_migrations` cru e
   * tratava TODA linha do ledger como aplicada. Uma migration `dirty`,
   * `failed`, `running`, com checksum divergente/desconhecido ou com arquivo
   * ausente tem ZERO pendentes — logo `pending_migrations.length === 0` deixava
   * `schema_ready` VERDE no exato momento de uma ativação.
   *
   * Cada caso abaixo tem `pending_migrations: []` de propósito: é o veredito
   * canônico (`ready`), e só ele, que reprova.
   */
  it.each([
    ['dirty_migration', 'dirty'],
    ['migration_failed', 'failed'],
    ['running_migration', 'running'],
    ['checksum_mismatch', 'checksum_mismatch'],
    ['checksum_unknown', 'checksum_unknown'],
    ['missing_file', 'missing_file'],
  ])(
    'schema com ZERO pendentes mas %s reprova — o veredito canônico, não a contagem',
    (kind, entryState) => {
      const facts = readyFacts({
        schema: readySchema({
          ready: false,
          state: 'blocked',
          pending_migrations: [],
          blockers: [{ kind, id: '109_onboarding_runs.sql' }],
          verified: [
            { id: '001_initial.sql', state: 'applied', checksum: 'a'.repeat(64) },
            { id: '109_onboarding_runs.sql', state: entryState, checksum: 'b'.repeat(64) },
          ],
        }),
      });
      const r = evaluateReadinessFacts(facts);
      expect(r.ready).toBe(false);
      const check = r.checks.find((c) => c.code === 'schema_ready')!;
      expect(check.status).toBe('fail');
      expect(check.message).toContain(kind);
      // A mensagem carrega CÓDIGO + id de migration, jamais SQL/DSN/driver.
      expect(check.message).not.toMatch(/postgres:\/\/|SELECT |password/i);
    },
  );

  it('estado do schema NÃO apurado (`unknown`) reprova — fail-closed', () => {
    const r = evaluateReadinessFacts(
      readyFacts({
        schema: readySchema({
          ready: false,
          state: 'unknown',
          applied_migrations: [],
          pending_migrations: [],
          verified: [],
          blockers: [{ kind: 'ledger_unavailable', id: null }],
        }),
      }),
    );
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.code === 'schema_ready')!.message).toContain('não pôde ser apurado');
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

  it('schemaFingerprint é estável sob reordenação e sensível ao conjunto de migrations', () => {
    const a = { id: 'a.sql', state: 'applied', checksum: 'a'.repeat(64) };
    const b = { id: 'b.sql', state: 'applied', checksum: 'b'.repeat(64) };
    const fp = (verified: typeof a[]) =>
      schemaFingerprint(readySchema({ verified, expected_head: null, applied_head: null }));
    expect(fp([b, a])).toBe(fp([a, b]));
    expect(fp([a])).not.toBe(fp([a, b]));
  });

  /**
   * CONTRATO NOVO (review do PR #541). A fingerprint anterior era o SHA-256 da
   * lista ordenada de ids aplicados — idêntica para um schema íntegro e para um
   * schema `dirty` / com checksum divergente, que é exatamente o par que ela
   * existe para distinguir na auditoria de uma ativação.
   */
  it('schemaFingerprint DISTINGUE schema saudável de schema sujo com os mesmos ids', () => {
    const healthy = readySchema();
    const dirty = readySchema({
      ready: false,
      state: 'blocked',
      verified: [
        { id: '001_initial.sql', state: 'applied', checksum: 'a'.repeat(64) },
        // MESMO id, mesmo checksum — só o estado verificado mudou.
        { id: '109_onboarding_runs.sql', state: 'dirty', checksum: 'b'.repeat(64) },
      ],
    });
    expect(healthy.applied_migrations).toEqual(dirty.applied_migrations);
    expect(schemaFingerprint(dirty)).not.toBe(schemaFingerprint(healthy));
  });

  it('schemaFingerprint muda quando o CHECKSUM de uma migration aplicada muda', () => {
    const before = readySchema();
    const edited = readySchema({
      verified: [
        { id: '001_initial.sql', state: 'applied', checksum: 'a'.repeat(64) },
        { id: '109_onboarding_runs.sql', state: 'applied', checksum: 'c'.repeat(64) },
      ],
    });
    expect(schemaFingerprint(edited)).not.toBe(schemaFingerprint(before));
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
