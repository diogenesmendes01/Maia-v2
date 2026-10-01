/**
 * SC03 — política e readiness por agente, FAIL-CLOSED.
 *
 * O que este arquivo prova, por critério:
 *
 *  - **SC03-AC01** — os seis checks do motor remoto (`engine_binding_valid`,
 *    `engine_bundle_approved`, `engine_data_policy_ready`,
 *    `engine_limits_configured`, `engine_runtime_compatible` e a admissão
 *    `engine_admission_open`) são produzidos a partir dos FATOS do backend, e o
 *    retrato que autorizou a ativação é revalidado sob CAS antes de qualquer
 *    escrita.
 *  - **SC03-AC02** — um agente que NÃO pede o motor remoto não consulta o
 *    atestador de evidência, o kill switch nem o pin do build; um agente que
 *    pede e está incompleto é recusado com RAZÃO FECHADA, e a ativação não roda.
 *  - **SC03-AC03** — retrato stale, bundle/pin/limites/política ausentes e
 *    versão incompatível bloqueiam; uma fixture SINTÉTICA completa fica `ready`
 *    sem configurar produção (a porta default de evidência continua fechada).
 *  - **SC03-AC04** — o kill switch só barra admissão NOVA (o turno já pinado
 *    não troca de motor, e a inferência não é repetida); o checklist do console
 *    mostra indisponibilidade em vez de sumir/inventar `ready`.
 *
 * Tier de doubles, explícito: os fatos do motor são objetos TIPADOS montados
 * aqui (não há Postgres nesta camada) e as PORTAS são funções injetadas. O
 * avaliador (`evaluateReadinessFacts`, `evaluateAgentReadiness`,
 * `revalidateEngineReadiness`) e o seletor são os de PRODUÇÃO — nenhum deles é
 * reimplementado no teste. O único store falso é o de saga em memória, que
 * existe para exercitar o orquestrador real (`executeOnboardingStep`) sem
 * banco; a necessidade dele está explicada no bloco "ativação sob CAS" no fim.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OnboardingRunRow } from '../../src/db/schema.js';
import type {
  CommitStepInput,
  CommitStepOutcome,
  StepApplication,
} from '../../src/db/repositories/onboarding-repos.js';
import { planTransition, type OnboardingState } from '../../src/onboarding/state-machine.js';
import {
  ENGINE_POLICY_ENGINES,
  ENGINE_READINESS_CHECK_CODES,
  ENGINE_REQUIRED_DATA_POLICY_CLASSES,
  ENGINE_UNAVAILABLE_REASONS,
  NO_ENGINE_DEPLOYMENT_EVIDENCE,
  READINESS_CHECK_CODES,
  blockingFailures,
  engineBindingRevision,
  engineRequestedBy,
  evaluateAgentReadiness,
  evaluateReadinessFacts,
  revalidateEngineReadiness,
  type AgentReadiness,
  type EngineDeploymentEvidenceV1,
  type EnginePolicyBindingFactV1,
  type EngineReadinessProjection,
  type EngineReadinessFactsV1,
  type ReadinessFacts,
  type ReadinessCheckCode,
  type SchemaFacts,
} from '../../src/onboarding/readiness.js';
import { READINESS_CHECK_CODE_VALUES } from '../../src/observability/taxonomy.js';
import { resolveEngineForNewTurn, lookupEngineForNewTurn } from '../../src/runtime/engines/selector.js';
import { ENGINE_KINDS } from '../../src/runtime/engines/schemas.js';
import {
  ENGINE_UNAVAILABLE_DETAIL,
  GO_LIVE_ENGINE_LABEL,
  goLiveEngineItem,
} from '../../src/admin-ui/app/agents/[agentId]/_components/go-live-engine-status.js';

const T = 'acme';
const A = 'acme-bot';
const OTHER_T = 'globex';
const OTHER_A = 'acme-vendas';

const CH = '11111111-1111-4111-8111-111111111111';
const CH_SECOND = '44444444-4444-4444-8444-444444444444';
const ROLE = '22222222-2222-4222-8222-222222222222';
const POLICY = '33333333-3333-4333-8333-333333333333';

/** O adaptador/protocolo que o PIN precisa casar. */
const RUNTIME = { adapter_revision: 'adapter-r7', protocol: 'hermes-wire/1' };

// ─── Fatos ───────────────────────────────────────────────────────────────────

/** Fatos de um agente local COMPLETAMENTE pronto (nenhum pedido de motor). */
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
      { id: ROLE, tenant_id: T, agent_id: A, role_key: 'suporte', active: true, is_default: true },
    ],
    channels: [
      {
        id: CH,
        tenant_id: T,
        agent_id: A,
        channel_type: 'whatsapp',
        active: true,
        is_synthetic: false,
        line_state: 'connected',
      },
    ],
    policies: [
      { id: POLICY, tenant_id: T, agent_id: A, channel_id: CH, default_role_id: ROLE },
    ],
    required_packs: ['baseline.core', 'domain.calendar'],
    schema: readySchema(),
    blocking_governance_items: 0,
    ...overrides,
  };
}

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

/** Uma linha de `agent_engine_policies` (145) que PEDE o motor remoto. */
const HERMES_ROW: EnginePolicyBindingFactV1 = {
  tenant_id: T,
  agent_id: A,
  channel_id: CH,
  engine: 'hermes',
  row_version: 3,
};

/**
 * A evidência de implantação COMPLETA. `synthetic` porque é o que ela é: uma
 * fixture de teste. Produção não tem esta porta preenchida (ver SC03-AC03).
 */
function approvedEvidence(
  overrides: Partial<EngineDeploymentEvidenceV1> = {},
): EngineDeploymentEvidenceV1 {
  return {
    evidence_class: 'synthetic',
    revision: 'ev-1',
    bundle: {
      id: 'bundle-9',
      digest: 'd'.repeat(64),
      approved_by: '',
      approved_at: '2026-09-01T00:00:00.000Z',
    },
    runtime_pin: {
      hermes_sha: 'h'.repeat(40),
      adapter_revision: RUNTIME.adapter_revision,
      protocol: RUNTIME.protocol,
    },
    data_policy: {
      policy_id: 'dp-1',
      classes: [...ENGINE_REQUIRED_DATA_POLICY_CLASSES],
      approved: true,
    },
    limits: { max_iterations: 8, max_output_tokens_per_call: 2048, max_inference_calls: 12 },
    ...overrides,
  };
}

function engineFacts(overrides: Partial<EngineReadinessFactsV1> = {}): EngineReadinessFactsV1 {
  return {
    requested: true,
    policies: [HERMES_ROW],
    kill_switch: false,
    runtime: RUNTIME,
    evidence: approvedEvidence(),
    ...overrides,
  };
}

function factsWithEngine(
  engOver: Partial<EngineReadinessFactsV1> = {},
  factsOver: Partial<ReadinessFacts> = {},
): ReadinessFacts {
  return readyFacts({ engine: engineFacts(engOver), ...factsOver });
}

const FIXED_NOW = new Date('2026-09-28T12:00:00.000Z');

function engineCheck(readiness: AgentReadiness, code: string) {
  const found = readiness.checks.filter((c) => c.code === code);
  expect(found).toHaveLength(1);
  return found[0];
}

const SCOPE = { tenant_id: T, agent_id: A };

/** Uma porta que EXPLODE se for chamada — é assim que se prova "não consulta". */
const forbidden = (what: string) =>
  vi.fn(async () => {
    throw new Error(`porta proibida foi consultada: ${what}`);
  });

// ─────────────────────────────────────────────────────────────────────────────

describe('SC03 — vocabulários fechados e espelhos', () => {
  it('emite os seis checks do motor exatamente uma vez, no vocabulário público', () => {
    const r = evaluateReadinessFacts(factsWithEngine(), FIXED_NOW);
    expect(r.checks.map((c) => c.code).sort()).toEqual([...READINESS_CHECK_CODES].sort());
    for (const code of ENGINE_READINESS_CHECK_CODES) {
      expect(READINESS_CHECK_CODES).toContain(code);
      expect(r.checks.filter((c) => c.code === code)).toHaveLength(1);
    }
    expect(r.ready).toBe(true);
    expect(blockingFailures(r)).toEqual([]);
  });

  it('o vetor de motores espelha ENGINE_KINDS (schemas.ts) e as razões são fechadas', () => {
    expect([...ENGINE_POLICY_ENGINES]).toEqual([...ENGINE_KINDS]);
    expect([...ENGINE_UNAVAILABLE_REASONS].length).toBe(8);
    // Nenhuma razão é texto livre: o console renderiza exatamente isto.
    expect(new Set(ENGINE_UNAVAILABLE_REASONS).size).toBe(ENGINE_UNAVAILABLE_REASONS.length);
  });

  it('a taxonomia de métricas espelha os checks de readiness (o emissor não colapsa)', () => {
    for (const code of READINESS_CHECK_CODES) {
      expect(READINESS_CHECK_CODE_VALUES).toContain(code);
    }
  });
});

describe('SC03-AC01 — checks do backend, revalidados na ativação sob CAS', () => {
  it('fixture sintética completa: os seis checks passam e a projeção traz as revisões', () => {
    const facts = factsWithEngine();
    const r = evaluateReadinessFacts(facts, FIXED_NOW);

    expect(r.ready).toBe(true);
    for (const code of ENGINE_READINESS_CHECK_CODES) {
      expect(engineCheck(r, code).status).toBe('pass');
    }
    expect(r.engine).toEqual({
      requested: true,
      kill_switch: false,
      evidence_class: 'synthetic',
      binding_revision: engineBindingRevision([HERMES_ROW], SCOPE),
      evidence_revision: 'ev-1',
      available: true,
      unavailable_reason: null,
    });
    // A revisão do binding NÃO é o id da linha: é o digest da projeção de CAS.
    expect(r.engine.binding_revision).not.toBe(HERMES_ROW.channel_id);
    expect(r.engine.binding_revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a revisão do binding acompanha a versão da linha e é nula sem linha do escopo', () => {
    const base = engineBindingRevision([HERMES_ROW], SCOPE);
    const bump = engineBindingRevision([{ ...HERMES_ROW, row_version: 4 }], SCOPE);
    const otherChannel = engineBindingRevision([{ ...HERMES_ROW, channel_id: CH_SECOND }], SCOPE);
    expect(bump).not.toBe(base);
    expect(otherChannel).not.toBe(base);
    expect(
      engineBindingRevision([{ ...HERMES_ROW, tenant_id: OTHER_T, agent_id: OTHER_A }], SCOPE),
    ).toBeNull();
    // Ordem de leitura não muda o digest: duas linhas, mesmas linhas.
    const two = [HERMES_ROW, { ...HERMES_ROW, channel_id: CH_SECOND, row_version: 1 }];
    expect(engineBindingRevision(two, SCOPE)).toBe(engineBindingRevision([...two].reverse(), SCOPE));
  });

  it('revalidação: retrato igual ⇒ ok, com cada porta consultada uma vez no escopo exato', async () => {
    const report = evaluateReadinessFacts(factsWithEngine(), FIXED_NOW);
    const loadEnginePolicies = vi.fn(async () => [HERMES_ROW]);
    const loadEngineEvidence = vi.fn(async () => approvedEvidence());

    const out = await revalidateEngineReadiness({
      expected: report.engine,
      scope: SCOPE,
      loadEnginePolicies,
      loadEngineEvidence,
    });

    expect(out).toEqual({ ok: true });
    expect(loadEnginePolicies).toHaveBeenCalledTimes(1);
    expect(loadEnginePolicies).toHaveBeenCalledWith(SCOPE);
    expect(loadEngineEvidence).toHaveBeenCalledTimes(1);
    expect(loadEngineEvidence).toHaveBeenCalledWith(SCOPE);
  });

  it('revalidação: linha de política ALTERADA entre o check e a ativação ⇒ recusa tipada', async () => {
    const report = evaluateReadinessFacts(factsWithEngine(), FIXED_NOW);
    const out = await revalidateEngineReadiness({
      expected: report.engine,
      scope: SCOPE,
      loadEnginePolicies: async () => [{ ...HERMES_ROW, row_version: 4 }],
      loadEngineEvidence: forbidden('evidence') as never,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('inalcançável');
    expect(out.code).toBe('engine_readiness_stale');
    expect(out.message).toContain('política de motor');
  });

  it('revalidação: linha de política REMOVIDA ⇒ recusa tipada (não vira "sem pedido")', async () => {
    const report = evaluateReadinessFacts(factsWithEngine(), FIXED_NOW);
    const out = await revalidateEngineReadiness({
      expected: report.engine,
      scope: SCOPE,
      loadEnginePolicies: async () => [],
      loadEngineEvidence: forbidden('evidence') as never,
    });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.code).toBe('engine_readiness_stale');
  });

  it('revalidação: evidência REPUBLICADA (revision nova) ⇒ recusa tipada', async () => {
    const report = evaluateReadinessFacts(factsWithEngine(), FIXED_NOW);
    const out = await revalidateEngineReadiness({
      expected: report.engine,
      scope: SCOPE,
      loadEnginePolicies: async () => [HERMES_ROW],
      loadEngineEvidence: async () => approvedEvidence({ revision: 'ev-2' }),
    });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.code).toBe('engine_readiness_stale');
  });

  it('revalidação: agente sem pedido (ou relatório sem projeção) não consulta NENHUMA porta', async () => {
    const local = evaluateReadinessFacts(readyFacts(), FIXED_NOW);
    expect(local.engine.requested).toBe(false);

    const bombPolicies = forbidden('policy') as never;
    const bombEvidence = forbidden('evidence') as never;

    const semPedido = await revalidateEngineReadiness({
      expected: local.engine,
      scope: SCOPE,
      loadEnginePolicies: bombPolicies,
      loadEngineEvidence: bombEvidence,
    });
    expect(semPedido).toEqual({ ok: true });

    // Relatório injetado/antigo, sem a projeção: mesmo desfecho, mesmas portas
    // intocadas.
    const semProjecao = await revalidateEngineReadiness({
      expected: null,
      scope: SCOPE,
      loadEnginePolicies: bombPolicies,
      loadEngineEvidence: bombEvidence,
    });
    expect(semProjecao).toEqual({ ok: true });
  });
});

describe('SC03-AC02 — disabled não consulta; enabled incompleto rejeita com razão fechada', () => {
  it('sem pedido, evidência/kill switch/pin não são lidos e o relatório segue pronto', async () => {
    const loadFacts = vi.fn(async () => readyFacts());
    const bombEvidence = forbidden('evidence') as never;
    const bombKillSwitch = forbidden('kill_switch') as never;

    const r = await evaluateAgentReadiness(SCOPE, {
      loadFacts,
      loadEnginePolicies: async () => [],
      loadEngineEvidence: bombEvidence,
      killSwitch: bombKillSwitch,
      now: FIXED_NOW,
    });

    expect(r.ready).toBe(true);
    expect(r.engine).toEqual({
      requested: false,
      kill_switch: false,
      evidence_class: null,
      binding_revision: null,
      evidence_revision: null,
      available: true,
      unavailable_reason: null,
    });
    for (const code of ENGINE_READINESS_CHECK_CODES) {
      expect(engineCheck(r, code).status).toBe('pass');
    }
    expect(bombEvidence).not.toHaveBeenCalled();
    expect(bombKillSwitch).not.toHaveBeenCalled();
  });

  it('falha de leitura das linhas de política SOBE — nunca vira "sem pedido"', async () => {
    // O modo de falha que o portão existe para impedir: um banco fora no ar
    // fazendo um agente que PEDE o motor remoto parecer um agente sem pedido
    // (e portanto "pronto"). A porta devolve erro; o avaliador propaga.
    await expect(
      evaluateAgentReadiness(SCOPE, {
        loadFacts: async () => readyFacts(),
        loadEnginePolicies: async () => {
          throw new Error('banco fora');
        },
        loadEngineEvidence: forbidden('evidence') as never,
        now: FIXED_NOW,
      }),
    ).rejects.toThrow('banco fora');
  });

  it('uma linha do escopo que NÃO pede Hermes também não consulta as portas', async () => {
    const row: EnginePolicyBindingFactV1 = { ...HERMES_ROW, engine: 'maia_react' };
    expect(engineRequestedBy([row], SCOPE)).toBe(false);
    const bombEvidence = forbidden('evidence') as never;
    const r = await evaluateAgentReadiness(SCOPE, {
      loadFacts: async () => readyFacts(),
      loadEnginePolicies: async () => [row],
      loadEngineEvidence: bombEvidence,
      killSwitch: forbidden('kill_switch') as never,
      now: FIXED_NOW,
    });
    expect(r.ready).toBe(true);
    expect(r.engine.requested).toBe(false);
    expect(bombEvidence).not.toHaveBeenCalled();
  });

  const matriz: Array<{
    caso: string;
    eng: Partial<EngineReadinessFactsV1>;
    code: ReadinessCheckCode;
    reason: (typeof ENGINE_UNAVAILABLE_REASONS)[number];
  }> = [
    {
      caso: 'evidência ausente',
      eng: { evidence: null },
      code: 'engine_bundle_approved',
      reason: 'evidence_absent',
    },
    {
      caso: 'bundle ausente',
      eng: { evidence: approvedEvidence({ bundle: null }) },
      code: 'engine_bundle_approved',
      reason: 'bundle_unapproved',
    },
    {
      caso: 'bundle sem ator de aprovação humana',
      eng: { evidence: approvedEvidence({ evidence_class: 'approved', bundle: { id: 'b', digest: 'c'.repeat(64), approved_by: '', approved_at: '2026-09-01T00:00:00.000Z' } }) },
      code: 'engine_bundle_approved',
      reason: 'bundle_unapproved',
    },
    {
      caso: 'política de dados ausente',
      eng: { evidence: approvedEvidence({ data_policy: null }) },
      code: 'engine_data_policy_ready',
      reason: 'data_policy_not_ready',
    },
    {
      caso: 'política de dados não aprovada',
      eng: {
        evidence: approvedEvidence({
          data_policy: { policy_id: 'dp', classes: ['texto_extraido_aprovado'], approved: false },
        }),
      },
      code: 'engine_data_policy_ready',
      reason: 'data_policy_not_ready',
    },
    {
      caso: 'política de dados sem a classe exigida do piloto',
      eng: { evidence: approvedEvidence({ data_policy: { policy_id: 'dp', classes: [], approved: true } }) },
      code: 'engine_data_policy_ready',
      reason: 'data_policy_not_ready',
    },
    {
      caso: 'limites ausentes',
      eng: { evidence: approvedEvidence({ limits: null }) },
      code: 'engine_limits_configured',
      reason: 'limits_missing',
    },
    {
      caso: 'limites não finitos',
      eng: {
        evidence: approvedEvidence({
          limits: { max_iterations: 0, max_output_tokens_per_call: 1, max_inference_calls: 1 },
        }),
      },
      code: 'engine_limits_configured',
      reason: 'limits_missing',
    },
    {
      caso: 'pin de runtime ausente',
      eng: { evidence: approvedEvidence({ runtime_pin: null }) },
      code: 'engine_runtime_compatible',
      reason: 'runtime_incompatible',
    },
    {
      caso: 'revisão do adaptador divergente',
      eng: {
        evidence: approvedEvidence({
          runtime_pin: { hermes_sha: 'h'.repeat(40), adapter_revision: 'outro', protocol: RUNTIME.protocol },
        }),
      },
      code: 'engine_runtime_compatible',
      reason: 'runtime_incompatible',
    },
    {
      caso: 'protocolo divergente',
      eng: {
        evidence: approvedEvidence({
          runtime_pin: { hermes_sha: 'h'.repeat(40), adapter_revision: RUNTIME.adapter_revision, protocol: 'outro' },
        }),
      },
      code: 'engine_runtime_compatible',
      reason: 'runtime_incompatible',
    },
    {
      caso: 'nenhuma linha de política ligando o agente',
      eng: { policies: [] },
      code: 'engine_binding_valid',
      reason: 'binding_missing',
    },
    {
      caso: 'linha de política de OUTRO escopo',
      eng: { policies: [{ ...HERMES_ROW, tenant_id: OTHER_T, agent_id: OTHER_A }] },
      code: 'engine_binding_valid',
      reason: 'binding_missing',
    },
    {
      caso: 'linha com motor fora do vocabulário',
      eng: { policies: [{ ...HERMES_ROW, engine: 'gpt' }] },
      code: 'engine_binding_valid',
      reason: 'binding_invalid',
    },
    {
      caso: 'linha com versão de CAS inválida',
      eng: { policies: [{ ...HERMES_ROW, row_version: 0 }] },
      code: 'engine_binding_valid',
      reason: 'binding_invalid',
    },
    {
      caso: 'linha apontando canal que não é deste escopo',
      eng: { policies: [{ ...HERMES_ROW, channel_id: CH_SECOND }] },
      code: 'engine_binding_valid',
      reason: 'binding_invalid',
    },
    {
      caso: 'fato inconsistente: pedido sem linha hermes',
      eng: { requested: true, policies: [{ ...HERMES_ROW, engine: 'maia_react' }] },
      code: 'engine_binding_valid',
      reason: 'binding_invalid',
    },
    {
      caso: 'fato inconsistente: linha hermes sem pedido',
      eng: { requested: false, policies: [HERMES_ROW] },
      code: 'engine_binding_valid',
      reason: 'binding_invalid',
    },
    {
      caso: 'kill switch ativo',
      eng: { kill_switch: true },
      code: 'engine_admission_open',
      reason: 'kill_switch',
    },
  ];

  it.each(matriz)('$caso ⇒ $code FAIL com razão $reason', ({ eng, code, reason }) => {
    const r = evaluateReadinessFacts(factsWithEngine(eng), FIXED_NOW);
    expect(r.ready).toBe(false);
    const failing = engineCheck(r, code);
    expect(failing.status).toBe('fail');
    expect(failing.severity).toBe('blocking');
    expect(failing.remediation.length).toBeGreaterThan(0);
    expect(r.engine.available).toBe(false);
    expect(r.engine.unavailable_reason).toBe(reason);
    expect(ENGINE_UNAVAILABLE_REASONS).toContain(r.engine.unavailable_reason);
    expect(blockingFailures(r).map((c) => c.code)).toContain(code);
  });

  it('a razão reportada é determinística quando vários fatos faltam', () => {
    const r = evaluateReadinessFacts(
      factsWithEngine({
        policies: [],
        evidence: null,
        kill_switch: true,
      }),
      FIXED_NOW,
    );
    // Precedência FECHADA: com o kill switch ligado é ele o motivo reportado —
    // é o fato mais global e o de remediação mais direta —, mesmo havendo falha
    // de binding e evidência ausente ao mesmo tempo.
    expect(r.engine.unavailable_reason).toBe('kill_switch');
    expect(blockingFailures(r).length).toBeGreaterThanOrEqual(3);
  });

  it('sem kill switch, o binding ausente vence a evidência ausente na razão reportada', () => {
    const r = evaluateReadinessFacts(factsWithEngine({ policies: [], evidence: null }), FIXED_NOW);
    // Duas portas fechadas ao mesmo tempo; a razão é a do fato mais a montante
    // (não existe linha de política ⇒ não há nem o que aprovar), e os DOIS
    // checks ficam vermelhos — a razão explica, não esconde.
    expect(r.engine.unavailable_reason).toBe('binding_missing');
    const failed = blockingFailures(r).map((c) => c.code);
    expect(failed).toContain('engine_binding_valid');
    expect(failed).toContain('engine_bundle_approved');
  });
});

describe('SC03-AC03 — fixture sintética ready sem produção; defaults fechados', () => {
  it('a porta default de evidência é o PORTÃO FECHADO: pedido sem atestação não fica ready', async () => {
    expect(await NO_ENGINE_DEPLOYMENT_EVIDENCE(SCOPE)).toBeNull();

    const r = await evaluateAgentReadiness(SCOPE, {
      loadFacts: async () => readyFacts(),
      loadEnginePolicies: async () => [HERMES_ROW],
      killSwitch: () => false,
      engineRuntime: RUNTIME,
      now: FIXED_NOW,
    });

    expect(r.ready).toBe(false);
    expect(r.engine.available).toBe(false);
    expect(r.engine.unavailable_reason).toBe('evidence_absent');
    expect(engineCheck(r, 'engine_bundle_approved').status).toBe('fail');
  });

  it('com a evidência SINTÉTICA injetada, o mesmo agente fica ready sem tocar produção', async () => {
    const r = await evaluateAgentReadiness(SCOPE, {
      loadFacts: async () => readyFacts(),
      loadEnginePolicies: async () => [HERMES_ROW],
      loadEngineEvidence: async () => approvedEvidence(),
      killSwitch: () => false,
      engineRuntime: RUNTIME,
      now: FIXED_NOW,
    });
    expect(r.ready).toBe(true);
    expect(r.engine.available).toBe(true);
    expect(r.engine.evidence_class).toBe('synthetic');
    expect(blockingFailures(r)).toEqual([]);
  });

  it('o pin default é o adaptador/protocolo DESTE build, não um literal do readiness', async () => {
    const engine = await import('../../src/runtime/engines/hermes-engine.js');
    const protocol = await import('../../src/integrations/hermes/protocol.js');
    const build = {
      adapter_revision: engine.HERMES_ENGINE_ADAPTER_REVISION,
      protocol: protocol.HERMES_WORKER_PROTOCOL_VERSION,
    };

    const facts = factsWithEngine({
      runtime: build,
      evidence: approvedEvidence({
        runtime_pin: { hermes_sha: 'h'.repeat(40), ...build },
      }),
    });
    expect(engineCheck(evaluateReadinessFacts(facts, FIXED_NOW), 'engine_runtime_compatible').status).toBe(
      'pass',
    );

    // E o mesmo pin contra um adaptador que não é o do build REPROVA.
    const stale = factsWithEngine({ runtime: build, evidence: approvedEvidence() });
    expect(engineCheck(evaluateReadinessFacts(stale, FIXED_NOW), 'engine_runtime_compatible').status).toBe(
      'fail',
    );
  });
});

describe('SC03-AC04 — kill switch barra só admissão nova; turno pinado não troca', () => {
  it('kill switch vence a linha e nem lê a política', async () => {
    const readPolicy = forbidden('policy') as never;
    const out = await lookupEngineForNewTurn({
      scope: { tenant_id: T, agent_id: A, channel_id: CH },
      kill_switch: true,
      readPolicy,
      canaryAllowsHermes: async () => true,
    });
    expect(out).toEqual({ kind: 'ok', engine: 'maia_react', source: 'kill_switch' });
    expect(readPolicy).not.toHaveBeenCalled();
    expect(
      resolveEngineForNewTurn({ policy: { engine: 'hermes' }, kill_switch: true, canary_allows_hermes: true }),
    ).toBe('maia_react');
  });

  it('sem kill switch: linha hermes + degrau da escada ⇒ hermes; degrau abaixo ⇒ canary_hold', async () => {
    const base = { scope: { tenant_id: T, agent_id: A, channel_id: CH }, kill_switch: false };
    const comDegrau = await lookupEngineForNewTurn({
      ...base,
      readPolicy: async () => ({ engine: 'hermes' }),
      canaryAllowsHermes: async () => true,
    });
    expect(comDegrau).toEqual({ kind: 'ok', engine: 'hermes', source: 'policy' });

    const semDegrau = await lookupEngineForNewTurn({
      ...base,
      readPolicy: async () => ({ engine: 'hermes' }),
      canaryAllowsHermes: async () => false,
    });
    expect(semDegrau).toEqual({ kind: 'ok', engine: 'maia_react', source: 'canary_hold' });
  });

  it('falha de leitura da linha RECUSA: nunca amplia para o motor remoto', async () => {
    const out = await lookupEngineForNewTurn({
      scope: { tenant_id: T, agent_id: A, channel_id: CH },
      kill_switch: false,
      readPolicy: async () => {
        throw new Error('banco fora');
      },
      canaryAllowsHermes: async () => true,
    });
    expect(out).toEqual({ kind: 'refused', reason: 'policy_lookup_failed' });
  });

  it('o kill switch NÃO é parâmetro do turno pinado: um turno em hermes continua em hermes', async () => {
    // A ausência do parâmetro é a prova estrutural: `selectEngine` não tem como
    // consultar o kill switch, e por isso não troca um turno já pinado.
    const r = resolveEngineForNewTurn({
      policy: { engine: 'hermes' },
      kill_switch: false,
      canary_allows_hermes: true,
    });
    expect(r).toBe('hermes');
    const selectorSource = readFileSync(new URL('../../src/runtime/engines/selector.ts', import.meta.url), 'utf8');
    const pinadoSign = selectorSource.slice(
      selectorSource.indexOf('export function selectEngine'),
      selectorSource.indexOf('/** O que importa da linha'),
    );
    expect(pinadoSign).not.toContain('kill_switch');
  });

  it('o checklist de go-live NÃO cai em silêncio quando o backend falha', () => {
    // Sem renderer de React no tier de teste raiz (o admin-ui tem deps
    // próprias), a asserção é ESTRUTURAL sobre o componente: o estado de erro
    // tem de permanecer visível. É inspeção de código, não execução de render —
    // e é declarada como tal no handoff.
    const src = readFileSync(
      new URL('../../src/admin-ui/app/agents/[agentId]/_components/go-live-checklist.tsx', import.meta.url),
      'utf8',
    );
    expect(src).not.toContain('overviewQuery.isLoading || overviewQuery.error) return null');
    expect(src).toContain('Status indisponível');
    expect(src).toContain('Tentar de novo');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SC03-AC04 (correção pós-QA239/240) — o checklist consome a projeção do
// MOTOR REMOTO do BACKEND (`AgentReadiness.engine`), e não declara pronto a
// partir de booleanos locais.
//
// O achado do QA: o card continuava sumindo com base só em perfil/canal/
// política, mesmo com o agente PEDINDO Hermes e o motor indisponível. A
// decisão é pura (`go-live-engine-status.ts`) e é executada aqui; o RENDER é
// provado no e2e do console (`tests/admin-ui/e2e/go-live-engine-readiness.spec.ts`),
// porque o tier raiz não tem React nem jsdom.
// ─────────────────────────────────────────────────────────────────────────────
describe('SC03-AC04 — o item do motor remoto vem da projeção do backend', () => {
  const projection = (
    over: Partial<EngineReadinessProjection> = {},
  ): EngineReadinessProjection => ({
    requested: true,
    kill_switch: false,
    evidence_class: 'synthetic',
    binding_revision: 'b-1',
    evidence_revision: 'ev-1',
    available: true,
    unavailable_reason: null,
    ...over,
  });

  it('sem pedido: item NÃO APLICÁVEL — nenhum "pronto" inventado e nada bloqueado', () => {
    const item = goLiveEngineItem(
      projection({ requested: false, available: true, unavailable_reason: null }),
    );
    expect(item.state).toBe('not_applicable');
    expect(item.blocks_ready).toBe(false);
    expect(item.label).toBe(GO_LIVE_ENGINE_LABEL);
  });

  it('pedido e conferido pelo backend: item satisfeito, sem bloquear o checklist', () => {
    const item = goLiveEngineItem(projection());
    expect(item.state).toBe('available');
    expect(item.blocks_ready).toBe(false);
  });

  it.each([...ENGINE_UNAVAILABLE_REASONS])(
    'pedido + indisponível (%s) ⇒ BLOQUEIA o "tudo pronto" com o motivo em português',
    (reason) => {
      const item = goLiveEngineItem(
        projection({ available: false, unavailable_reason: reason }),
      );
      expect(item.state).toBe('unavailable');
      expect(item.blocks_ready).toBe(true);
      expect(item.detail).toBe(ENGINE_UNAVAILABLE_DETAIL[reason]);
      expect(item.detail.length).toBeGreaterThan(20);
    },
  );

  it('o vocabulário do console é EXATAMENTE o do readiness — sem lista paralela', () => {
    expect(Object.keys(ENGINE_UNAVAILABLE_DETAIL).sort()).toEqual(
      [...ENGINE_UNAVAILABLE_REASONS].sort(),
    );
  });

  it('motivo ausente ou fora do vocabulário NÃO vira "sem problema": continua bloqueando', () => {
    const semMotivo = goLiveEngineItem(projection({ available: false, unavailable_reason: null }));
    expect(semMotivo.state).toBe('unavailable');
    expect(semMotivo.blocks_ready).toBe(true);

    const motivoDesconhecido = goLiveEngineItem(
      projection({
        available: false,
        unavailable_reason: 'motivo_novo_do_backend' as never,
      }),
    );
    expect(motivoDesconhecido.state).toBe('unavailable');
    expect(motivoDesconhecido.blocks_ready).toBe(true);
    expect(motivoDesconhecido.detail).toContain('motivo_novo_do_backend');
  });

  it('projeção ausente (backend antigo, ou avaliação que não respondeu) ⇒ desCONHECIDO bloqueante', () => {
    for (const missing of [null, undefined]) {
      const item = goLiveEngineItem(missing);
      expect(item.state).toBe('unknown');
      expect(item.blocks_ready).toBe(true);
      expect(item.detail).toContain('possível verificar');
    }
  });

  it('o checklist CONSUME a projeção e usa o veto do motor na regra de "tudo pronto"', () => {
    // Asserção ESTRUTURAL (o render é o e2e): o que ela fixa é que a decisão
    // deixou de ser "booleanos locais" e passou a depender do veredito do
    // backend — inclusive na hora de o card sumir.
    const src = readFileSync(
      new URL(
        '../../src/admin-ui/app/agents/[agentId]/_components/go-live-checklist.tsx',
        import.meta.url,
      ),
      'utf8',
    );
    expect(src).toContain('includeEngine: true');
    expect(src).toContain('goLiveEngineItem(overview?.engine)');
    expect(src).toContain('hasActiveProfile && hasChannel && policyDone && !engineItem.blocks_ready');
    expect(src).toContain("key: 'engine'");
    // A projeção NÃO é reimplementada aqui: o componente não lê
    // `unavailable_reason` nem conta checks por conta própria.
    expect(src).not.toContain('unavailable_reason');
    expect(src).not.toContain('engine_runtime_compatible');
  });

  it('o backend do console projeta o motor pelo avaliador canônico, atrás da flag', () => {
    const src = readFileSync(
      new URL('../../src/admin-ui/trpc/routers/channelPolicies.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain('evaluateAgentReadiness');
    expect(src).toContain('readiness.engine');
    expect(src).toContain('includeEngine');
    // Fail-closed: avaliação que não responde devolve `null`, nunca um prontuário.
    expect(src).toContain('engineProjectionOrNull');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ativação sob CAS — o orquestrador REAL contra um store de saga em memória.
//
// O store falso existe só para a durabilidade (transação + FOR UPDATE), que é
// a parte coberta pela suíte de integração. O que se prova aqui é a ORDEM da
// decisão no passo `activate`: travar → reavaliar → REVALIDAR o retrato do
// motor sob CAS → e só então escrever. As escritas de provisionamento estão
// mockadas (elas exigem Postgres), e `applyActivate` é um espião: é ele que
// diz se a ativação chegou a rodar.
// ─────────────────────────────────────────────────────────────────────────────

const runs = new Map<string, OnboardingRunRow>();
const ledger = new Map<string, { payload_hash: string; result: Record<string, unknown> }>();
const applyCalls: string[] = [];
const activateSpy = vi.fn(async () => ({
  result: { activated: true },
  completes: true,
  audit: { action: 'onboarding_agent_activated', resource_type: 'agent', resource_id: A },
}));

/** As linhas de política que o `tx` da ativação enxerga AGORA. */
let txPolicyRows: readonly EnginePolicyBindingFactV1[] = [];

/**
 * Rastro ORDENADO do que a transação do passo fez: cada `execute` (as travas)
 * e a releitura das linhas de política. É com ele que o caso da correção
 * pós-QA239/240 prova que a trava acontece ANTES da releitura do CAS — a
 * asserção não é "existe um lock", é "a ordem é trav→reler→decidir".
 */
const txTrace: string[] = [];
const POLICY_READ = 'read:agent_engine_policies';

/** O texto de um `sql` do drizzle, sem depender de detalhe interno do driver. */
function sqlTextOf(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      if (Array.isArray(value)) return value.join('');
      if (typeof value === 'string') return value;
      return '?';
    })
    .join(' ')
    .replace(/\s+/g, ' ');
}

function fakeTx() {
  return {
    execute: async (query: unknown) => {
      txTrace.push(sqlTextOf(query));
      return { rows: [] };
    },
    // O loader de política lê pelo MESMO tx da escrita: a cadeia drizzle é
    // reproduzida no mínimo necessário para que a leitura aconteça DE FATO.
    select: () => ({
      from: () => ({
        where: async () => {
          txTrace.push(POLICY_READ);
          return txPolicyRows;
        },
      }),
    }),
  };
}

function makeRun(over: Partial<OnboardingRunRow> = {}): OnboardingRunRow {
  const now = new Date('2026-09-28T12:00:00.000Z');
  return {
    id: 'run-sc03',
    kind: 'tenant_onboarding',
    tenant_id: T,
    agent_id: A,
    state: 'ready_for_activation',
    current_step: 'evaluate_readiness',
    version: 1,
    created_by: 'u1',
    created_at: now,
    updated_at: now,
    completed_at: null,
    cancelled_at: null,
    expires_at: new Date('2026-09-28T18:00:00.000Z'),
    last_error_code: null,
    metadata: {},
    configuration_contract_version: '1',
    schema_version: 'sf',
    ...over,
  } as OnboardingRunRow;
}

const fakeRepo = {
  async getForScope(input: { run_id: string; tenant_id: string | null }) {
    const run = runs.get(input.run_id);
    if (!run) return null;
    if (input.tenant_id !== null && run.tenant_id !== input.tenant_id) return null;
    return run;
  },
  async commitStep(input: CommitStepInput): Promise<CommitStepOutcome> {
    const run = runs.get(input.run_id);
    if (!run) return { outcome: 'not_found' };
    const key = `${run.id}:${input.step}:${input.idempotency_key_hash}`;
    const previous = ledger.get(key);
    if (previous) {
      return previous.payload_hash === input.payload_hash
        ? { outcome: 'replayed', run, result: previous.result }
        : { outcome: 'payload_conflict', run };
    }
    if (run.version !== input.expected_version) return { outcome: 'version_conflict', run };

    let plan: { to: OnboardingState; onDeny?: OnboardingState };
    try {
      plan = planTransition({
        step: input.step,
        from: run.state as OnboardingState,
        retry_point: {},
      }) as { to: OnboardingState; onDeny?: OnboardingState };
    } catch (err) {
      return {
        outcome: 'invalid_transition',
        run,
        code: (err as { code?: string }).code ?? 'invalid_transition',
        message: (err as Error).message,
      };
    }

    applyCalls.push(input.step);
    const applied: StepApplication = await input.apply(fakeTx() as never, run);

    if (applied.deny) {
      const denied = {
        ...run,
        state: plan.onDeny ?? run.state,
        version: run.version + 1,
        current_step: input.step,
        last_error_code: applied.deny.code,
      } as OnboardingRunRow;
      runs.set(run.id, denied);
      return {
        outcome: 'denied',
        run: denied,
        code: applied.deny.code,
        message: applied.deny.message,
        result: applied.result,
      };
    }

    ledger.set(key, { payload_hash: input.payload_hash, result: applied.result });
    const updated = {
      ...run,
      state: plan.to,
      version: run.version + 1,
      current_step: input.step,
      last_error_code: null,
      ...(applied.completes ? { completed_at: new Date() } : {}),
    } as OnboardingRunRow;
    runs.set(run.id, updated);
    return { outcome: 'committed', run: updated, result: applied.result };
  },
};

vi.mock('@/db/repositories/onboarding-repos.js', () => ({ onboardingRunsRepo: fakeRepo }));
vi.mock('@/onboarding/provisioning.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/onboarding/provisioning.js')>();
  return { ...original, applyActivate: activateSpy };
});
vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined), auditTx: vi.fn() }));

const ACTOR = { actor_id: 'u1', actor_role: 'owner' as const, tenant_id: T };
const ACTIVATE_PAYLOAD = { confirm_tenant_id: T, confirm_agent_id: A };

async function runActivate(deps: Record<string, unknown>) {
  const { executeOnboardingStep } = await import('../../src/onboarding/wizard.js');
  return executeOnboardingStep({
    run_id: 'run-sc03',
    step: 'activate',
    payload: ACTIVATE_PAYLOAD,
    idempotency_key: 'k-sc03-ativacao',
    expected_version: 1,
    actor: ACTOR,
    deps: deps as never,
  });
}

describe('SC03 — a ativação revalida o retrato do motor sob CAS', () => {
  beforeEach(() => {
    runs.clear();
    ledger.clear();
    applyCalls.length = 0;
    activateSpy.mockClear();
    runs.set('run-sc03', makeRun());
    txPolicyRows = [HERMES_ROW];
    txTrace.length = 0;
  });

  it('retrato igual ⇒ a ativação roda e o readback carrega o veredito do motor', async () => {
    const report = evaluateReadinessFacts(factsWithEngine(), FIXED_NOW);
    const out = await runActivate({
      evaluateReadiness: async () => report,
      loadEngineEvidence: async () => approvedEvidence(),
    });

    expect(out.status).toBe('completed');
    expect(applyCalls).toContain('activate');
    expect(activateSpy).toHaveBeenCalledTimes(1);
    if (out.status !== 'completed') throw new Error('inalcançável');
    expect(out.readiness?.engine.available).toBe(true);
    expect(out.readiness?.engine.binding_revision).toBe(report.engine.binding_revision);
    expect(out.readiness?.engine).toEqual(report.engine);
    // O `result` do passo `activate` é o payload da ativação (canais ligados),
    // não o relatório; o veredito do motor chega ao operador pelo READBACK
    // (`readiness`), que é o mesmo objeto que o console lê.
    expect(out.result.activated).toBe(true);
    expect(runs.get('run-sc03')?.state).toBe('active');
  });

  it('política alterada entre o check e a ativação ⇒ DENY tipado e NENHUMA escrita', async () => {
    const report = evaluateReadinessFacts(factsWithEngine(), FIXED_NOW);
    txPolicyRows = [{ ...HERMES_ROW, row_version: 4 }];

    const out = await runActivate({
      evaluateReadiness: async () => report,
      loadEngineEvidence: async () => approvedEvidence(),
    });

    expect(out.status).toBe('denied');
    expect(out.status === 'denied' && out.code).toBe('engine_readiness_stale');
    expect(activateSpy).not.toHaveBeenCalled();
    expect(runs.get('run-sc03')?.state).toBe('readiness_failed');
    expect(runs.get('run-sc03')?.state).not.toBe('active');
  });

  it('evidência republicada entre o check e a ativação ⇒ DENY tipado e NENHUMA escrita', async () => {
    const report = evaluateReadinessFacts(factsWithEngine(), FIXED_NOW);
    const out = await runActivate({
      evaluateReadiness: async () => report,
      loadEngineEvidence: async () => approvedEvidence({ revision: 'ev-2' }),
    });

    expect(out.status).toBe('denied');
    expect(out.status === 'denied' && out.code).toBe('engine_readiness_stale');
    expect(activateSpy).not.toHaveBeenCalled();
    expect(runs.get('run-sc03')?.state).toBe('readiness_failed');
  });

  it('agente local (sem pedido) ativa sem consultar o atestador', async () => {
    const report = evaluateReadinessFacts(readyFacts(), FIXED_NOW);
    txPolicyRows = [];
    const bombEvidence = forbidden('evidence') as never;

    const out = await runActivate({
      evaluateReadiness: async () => report,
      loadEngineEvidence: bombEvidence,
    });

    expect(out.status).toBe('completed');
    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(bombEvidence).not.toHaveBeenCalled();
    expect(runs.get('run-sc03')?.state).toBe('active');
  });

  it('correção pós-QA239/240 — a política é TRAVADA antes de ser relida para o CAS', async () => {
    // O achado do QA: a releitura CAS acontecia sem lock nas linhas de
    // `agent_engine_policies`, e um UPDATE concorrente entrava entre a
    // releitura e o commit. A correção tem de estar na ORDEM da transação, não
    // só na existência do lock — este caso mede a ordem.
    const report = evaluateReadinessFacts(factsWithEngine(), FIXED_NOW);
    const out = await runActivate({
      evaluateReadiness: async () => report,
      loadEngineEvidence: async () => approvedEvidence(),
    });
    expect(out.status).toBe('completed');

    const lockIdx = txTrace.findIndex(
      (e) => e.includes('agent_engine_policies') && e.includes('FOR SHARE'),
    );
    const readIdx = txTrace.indexOf(POLICY_READ);
    const channelsIdx = txTrace.findIndex(
      (e) => e.includes('FROM channels') && e.includes('FOR UPDATE'),
    );

    expect(lockIdx, `trava ausente no rastro: ${JSON.stringify(txTrace)}`).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeGreaterThanOrEqual(0);
    // A ordem FIXA: canal travado (retrato) → política travada → política relida.
    expect(channelsIdx).toBeGreaterThanOrEqual(0);
    expect(channelsIdx).toBeLessThan(lockIdx);
    expect(lockIdx).toBeLessThan(readIdx);
  });
});