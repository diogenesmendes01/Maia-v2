/**
 * Issue #519 — prova SEM BANCO de que `provision_agent` cria um agente
 * INOPERÁVEL.
 *
 * Este é o contrato central da saga: o agente nasce inerte e só a ativação
 * explícita, com readiness reavaliado sob a trava da run, o coloca em serviço.
 * Um caminho que o deixe operável antes disso não é um bug de onboarding — é
 * um agente sem profile ativo, sem papel padrão e sem política de canal
 * atendendo em produção.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 *   Até aqui, toda asserção sobre `agents.status = 'provisioning'` vivia em
 *   suíte de INTEGRAÇÃO (`tests/integration/onboarding-saga.spec.ts:169`,
 *   `onboarding-review-541.spec.ts:695`, `-round2.spec.ts:390`,
 *   `-round3-provisioning.spec.ts:173`). Todas exigem Postgres. E
 *   `tests/unit/onboarding/wizard.spec.ts` mocka `applyProvisionAgent`
 *   inteiro — a orquestração é o que ele testa, não a escrita.
 *
 *   Consequência: num ambiente sem banco — CI degradado, laptop de quem só
 *   roda `npm test`, container de agente — trocar `AGENT_STATUS_PROVISIONING`
 *   por `AGENT_STATUS_ACTIVE` na linha 362 de `provisioning.ts` passava por
 *   TODA a suíte unitária em verde. O literal `'active'` é membro legítimo do
 *   `CHECK` de `agents.status` (migration 110), então nem
 *   `schema-constraint-compatibility.spec.ts` reclamava: ele prova que o
 *   literal é ACEITÁVEL pelo schema, não que é o CERTO para este passo.
 *
 *   A regressão de segurança mais grave do módulo era, portanto, a única sem
 *   rede unitária.
 *
 * COMO
 *   `tx` falso que só sabe o que este passo usa: `insert(...).values(...)`,
 *   `.onConflictDoNothing()` e `.returning()`. As tabelas são identificadas
 *   por REFERÊNCIA ao schema real (não por string), então renomear uma tabela
 *   quebra o teste em vez de fazê-lo passar por engano. O `RETURNING` do
 *   `agents` devolve a própria linha inserida, que é o que o Postgres faz.
 */
import { describe, it, expect } from 'vitest';
import {
  agents,
  agent_operational_profile_versions,
  agent_tool_grants,
  type OnboardingRunRow,
} from '../../../src/db/schema.js';
import {
  AGENT_STATUS_ACTIVE,
  AGENT_STATUS_PROVISIONING,
  PROFILE_STATUS_SEED,
  applyProvisionAgent,
} from '../../../src/onboarding/provisioning.js';

type Row = Record<string, unknown>;

/** O que o `tx` falso capturou, por tabela. */
type Captured = { agents: Row[]; profiles: Row[]; grants: Row[] };

function makeTx(captured: Captured) {
  const tableOf = (t: object): keyof Captured => {
    if (t === agents) return 'agents';
    if (t === agent_operational_profile_versions) return 'profiles';
    if (t === agent_tool_grants) return 'grants';
    throw new Error('tabela inesperada no tx falso — o passo mudou de forma');
  };

  return {
    insert: (t: object) => ({
      values: (v: Row) => {
        const bucket = tableOf(t);
        captured[bucket].push(v);
        // O `RETURNING` do Postgres devolve a linha REALMENTE inserida.
        const rows: Row[] = [v];
        const chain: Record<string, unknown> = {
          onConflictDoNothing: () => chain,
          returning: () => Promise.resolve(rows),
          then: (resolve: (value: unknown) => unknown) => resolve(rows),
        };
        return chain;
      },
    }),
  };
}

function makeRun(): OnboardingRunRow {
  const now = new Date();
  return {
    id: 'run-uuid-inoperavel',
    kind: 'tenant_onboarding',
    tenant_id: 'acme',
    agent_id: null,
    state: 'admin_ready',
    current_step: null,
    version: 3,
    created_by: 'u1',
    actor_role: 'owner',
    correlation_id: 'corr-1',
    last_error_code: null,
    failed_step: null,
    resume_state: null,
    metadata: {},
    configuration_contract_version: '1',
    schema_version: 'sch',
    creation_idempotency_key_hash: null,
    creation_payload_hash: null,
    created_at: now,
    updated_at: now,
    expires_at: new Date(now.getTime() + 60_000),
    completed_at: null,
    cancelled_at: null,
  } as unknown as OnboardingRunRow;
}

async function provision(): Promise<{ captured: Captured; result: Record<string, unknown> }> {
  const captured: Captured = { agents: [], profiles: [], grants: [] };
  const out = await applyProvisionAgent(
    makeTx(captured) as never,
    makeRun(),
    { agent_id: 'acme-bot', nome: 'Bot da Acme' } as never,
  );
  return { captured, result: out.result as Record<string, unknown> };
}

describe('provision_agent — o agente NASCE inoperável', () => {
  it('a linha de `agents` é inserida com `status = provisioning`', async () => {
    const { captured } = await provision();
    expect(captured.agents).toHaveLength(1);
    expect(captured.agents[0]!.status).toBe(AGENT_STATUS_PROVISIONING);
  });

  /**
   * A asserção NEGATIVA é a que importa, e ela é mais forte do que a positiva:
   * a positiva morre se o vocabulário mudar de nome; esta morre se o agente
   * ficar OPERÁVEL, seja qual for o literal escolhido para isso.
   */
  it('nenhuma escrita deste passo deixa o agente `active`', async () => {
    const { captured, result } = await provision();
    expect(captured.agents[0]!.status).not.toBe(AGENT_STATUS_ACTIVE);
    expect(result.status).not.toBe(AGENT_STATUS_ACTIVE);
    // O resultado que o ledger de idempotência guarda — e que um replay
    // devolve ao console — também precisa dizer a verdade sobre o estado.
    expect(result.status).toBe(AGENT_STATUS_PROVISIONING);
  });

  /**
   * "Inoperável" não é só o status: o agente sai deste passo sem NENHUMA
   * versão de profile ativa. É a segunda metade da mesma promessa — o
   * `configure_profile` é que aprova, e o readiness barra quem não tem.
   */
  it('a versão semente do profile nasce `proposed`, nunca ativa', async () => {
    const { captured } = await provision();
    expect(captured.profiles).toHaveLength(1);
    expect(captured.profiles[0]!.status).toBe(PROFILE_STATUS_SEED);
    expect(captured.profiles[0]!.version).toBe(1);
    expect(captured.profiles[0]!.activated_at ?? null).toBeNull();
  });

  it('o piso de capacidades é escopado pelo par da run', async () => {
    const { captured } = await provision();
    expect(captured.grants).toHaveLength(1);
    expect(captured.grants[0]).toMatchObject({ tenant_id: 'acme', agent_id: 'acme-bot' });
    expect(captured.grants[0]!.denied_tools).toEqual([]);
  });

  it('as três escritas são todas do par `(tenant, agente)` da run', async () => {
    const { captured } = await provision();
    for (const row of [...captured.agents, ...captured.profiles, ...captured.grants]) {
      expect(row.tenant_id).toBe('acme');
    }
  });
});
