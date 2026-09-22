/**
 * P12 (spec §10.1) — `canaryCapabilityAllowed`: a pergunta de runtime.
 *
 * O módulo puro (`canary-policy.ts`) já é coberto por
 * `tests/unit/canary-policy.spec.ts`. O que ESTE arquivo prende é a fronteira
 * que o puro não pode prender: o que acontece quando a leitura do degrau
 * falha, quando não há linha, e quando a linha existe mas não tem lastro.
 *
 * Os três casos convergem para a mesma resposta — `false` —, e a convergência
 * é o ponto. Um canário que se habilita sozinho quando o Postgres oscila é
 * pior do que um canário que não existe: ele parece governado.
 *
 * Só a camada de execução do SQL é falsa; `canaryPolicyRepo.find`,
 * `validateCanaryPolicy` e `canaryAllows` são os de produção.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectMock = vi.fn();

vi.mock('@/db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
  withTx: vi.fn(),
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

/** `db.select(...).from(...).where(...)` → o que `resposta` mandar. */
function comLinhas(rows: unknown[]): void {
  selectMock.mockReturnValue({
    from: () => ({ where: async () => rows }),
  });
}

function comFalha(err: Error): void {
  selectMock.mockReturnValue({
    from: () => ({
      where: async () => {
        throw err;
      },
    }),
  });
}

async function permitido(capability: string): Promise<boolean> {
  const { canaryCapabilityAllowed } = await import('@/db/repositories/canary-policy-repos.js');
  const { runWithTenantContext } = await import('@/db/tenant-context.js');
  return runWithTenantContext({ tenant_id: 'tenant-A', agent_id: 'agent-A' }, () =>
    canaryCapabilityAllowed(capability as never),
  );
}

beforeEach(() => {
  selectMock.mockReset();
});

describe('canaryCapabilityAllowed — falha de leitura NEGA, nunca concede', () => {
  it('lookup que explode devolve false, não propaga e não conclui nada', async () => {
    // O chamador é um gate de capacidade. Deixar a exceção subir transformaria
    // "não consegui ler o degrau" em falha de turno; devolver `true` ligaria o
    // canário justamente quando o banco está pior.
    comFalha(new Error('connection terminated'));
    expect(await permitido('deliver_to_user')).toBe(false);
  });

  it('sem linha vale `off` — agente que ninguém cadastrou não está em canário', async () => {
    comLinhas([]);
    expect(await permitido('hermes_live_turn')).toBe(false);
    expect(await permitido('private_recall')).toBe(false);
    expect(await permitido('business_effect_tool')).toBe(false);
  });

  it('degrau fora da escada vale `off`, e não o degrau mais próximo', async () => {
    // Um valor que o CHECK da 147 não deveria admitir. Se chegou, banco e
    // código discordam — e o lado em que se erra é o de negar.
    comLinhas([{ stage: 'quase_live', cohort_ref: 'c1', acceptance_evidence_ref: 'a1' }]);
    expect(await permitido('deliver_to_user')).toBe(false);
  });

  it('degrau SEM lastro vale `off`, mesmo sendo um degrau válido', async () => {
    // `live_informational` sem coorte é exatamente o que o §10.1 proíbe: gente
    // de verdade sem cadastro de coorte. A linha existe, o degrau existe, e
    // ainda assim não autoriza nada.
    comLinhas([{ stage: 'live_informational', cohort_ref: null, acceptance_evidence_ref: 'a1' }]);
    expect(await permitido('deliver_to_user')).toBe(false);
    expect(await permitido('real_personal_data')).toBe(false);
  });
});

describe('canaryCapabilityAllowed — degrau com lastro autoriza o que a escada diz', () => {
  it('`live_informational` completo libera turno, dado real e entrega', async () => {
    comLinhas([
      { stage: 'live_informational', cohort_ref: 'coorte-1', acceptance_evidence_ref: 'aceite-1' },
    ]);
    expect(await permitido('hermes_live_turn')).toBe(true);
    expect(await permitido('real_personal_data')).toBe(true);
    expect(await permitido('deliver_to_user')).toBe(true);
  });

  it('e NÃO libera os degraus acima — a escada é ordem, não conjunto', async () => {
    comLinhas([
      { stage: 'live_informational', cohort_ref: 'coorte-1', acceptance_evidence_ref: 'aceite-1' },
    ]);
    expect(await permitido('private_recall')).toBe(false);
    expect(await permitido('write_learning_proposal')).toBe(false);
    expect(await permitido('publish_shared_learning')).toBe(false);
    expect(await permitido('business_effect_tool')).toBe(false);
  });

  it('o último degrau libera tudo que os anteriores liberavam', async () => {
    comLinhas([
      {
        stage: 'business_effect_tools',
        cohort_ref: 'coorte-1',
        acceptance_evidence_ref: 'aceite-1',
      },
    ]);
    for (const cap of [
      'hermes_live_turn',
      'real_personal_data',
      'deliver_to_user',
      'private_recall',
      'write_learning_proposal',
      'publish_shared_learning',
      'business_effect_tool',
    ]) {
      expect(await permitido(cap), cap).toBe(true);
    }
  });
});
