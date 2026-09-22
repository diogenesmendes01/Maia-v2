/**
 * P12 (spec §10.1) — a escada de habilitação do canário.
 *
 * A ordem do §10.1 não é uma lista de sugestões: cada degrau pressupõe o
 * anterior, e o texto fecha cada um com uma proibição própria. Estes casos
 * prendem as proibições que mais custam quando furadas.
 */
import { describe, it, expect } from 'vitest';
import {
  CANARY_STAGES,
  canaryAllows,
  canaryStageAllows,
  validateCanaryPolicy,
  type AgentCanaryPolicyV1,
} from '@/runtime/engines/canary-policy.js';

function politica(over: Partial<AgentCanaryPolicyV1> = {}): AgentCanaryPolicyV1 {
  return {
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    stage: 'off',
    cohort_ref: null,
    acceptance_evidence_ref: null,
    ...over,
  };
}

describe('canaryStageAllows — a escada', () => {
  it('em `off`, NADA é permitido', () => {
    for (const cap of [
      'hermes_live_turn',
      'real_personal_data',
      'deliver_to_user',
      'private_recall',
      'write_learning_proposal',
      'publish_shared_learning',
      'business_effect_tool',
    ] as const) {
      expect(canaryStageAllows('off', cap), cap).toBe(false);
    }
  });

  it('`synthetic` NÃO libera dado real — é literalmente "nada de dados reais"', () => {
    expect(canaryStageAllows('synthetic', 'real_personal_data')).toBe(false);
  });

  it('`shadow_offline` NÃO entrega ao usuário — "resultados não enviados"', () => {
    // É o que separa shadow de live. Se este caso cair, shadow virou live.
    expect(canaryStageAllows('shadow_offline', 'deliver_to_user')).toBe(false);
    expect(canaryStageAllows('live_informational', 'deliver_to_user')).toBe(true);
  });

  it('aprendizado NÃO vem junto com o live', () => {
    // Propor aprendizado exige memória privada antes: uma proposta derivada de
    // dado que o sistema ainda não sabe projetar com autorização seria
    // derivada de dado que ninguém conferiu.
    expect(canaryStageAllows('live_informational', 'write_learning_proposal')).toBe(false);
    expect(canaryStageAllows('private_memory', 'write_learning_proposal')).toBe(true);
  });

  it('ferramenta com efeito de negócio é o ÚLTIMO degrau', () => {
    // §10.1: "não entra automaticamente ao terminar a integração do reasoner".
    expect(canaryStageAllows('governed_shared_learning', 'business_effect_tool')).toBe(false);
    expect(canaryStageAllows('business_effect_tools', 'business_effect_tool')).toBe(true);
  });

  it('degrau superior implica tudo que os anteriores permitiam', () => {
    // Uma escada furada — "pode publicar mas não pode entregar" — é estado que
    // a ordem do §10.1 não admite.
    const topo = CANARY_STAGES[CANARY_STAGES.length - 1]!;
    for (const cap of ['hermes_live_turn', 'deliver_to_user', 'private_recall'] as const) {
      expect(canaryStageAllows(topo, cap), cap).toBe(true);
    }
  });
});

describe('validateCanaryPolicy — coerência da configuração', () => {
  it('a partir do live, coorte é obrigatória', () => {
    // §10.1: coorte "listada por IDs autorizados no backend"; "nenhuma chave
    // do usuário WhatsApp habilita Hermes".
    expect(validateCanaryPolicy(politica({ stage: 'live_informational' }))).toContain(
      'missing_cohort',
    );
    expect(
      validateCanaryPolicy(
        politica({
          stage: 'live_informational',
          cohort_ref: 'coorte-1',
          acceptance_evidence_ref: 'aceite-1',
        }),
      ),
    ).toEqual([]);
  });

  it('a partir do shadow, evidência de aceite é obrigatória', () => {
    // Sem ela, subir de degrau é uma edição de configuração indistinguível de
    // um engano.
    expect(validateCanaryPolicy(politica({ stage: 'shadow_offline' }))).toContain(
      'missing_acceptance_evidence',
    );
  });

  it('em `off` e `synthetic` não há o que exigir', () => {
    expect(validateCanaryPolicy(politica({ stage: 'off' }))).toEqual([]);
    expect(validateCanaryPolicy(politica({ stage: 'synthetic' }))).toEqual([]);
  });

  it('degrau desconhecido é problema, não default silencioso', () => {
    const p = politica({ stage: 'turbo' as never });
    expect(validateCanaryPolicy(p)).toEqual(['unknown_stage']);
  });
});

describe('canaryAllows — a decisão de runtime', () => {
  it('política AUSENTE vale `off`', () => {
    // Um agente sem configuração não foi incluído em canário nenhum. Tratar
    // ausência como "o degrau mais alto que o código suporta" ligaria o Hermes
    // para quem nunca foi cadastrado.
    expect(canaryAllows(null, 'hermes_live_turn')).toBe(false);
    expect(canaryAllows(null, 'deliver_to_user')).toBe(false);
  });

  it('política INCOERENTE também vale `off`', () => {
    // Ela já deveria ter sido barrada na validação; chegando aqui, a resposta
    // segura é não agir com base nela.
    const semCoorte = politica({ stage: 'business_effect_tools', acceptance_evidence_ref: 'a' });
    expect(canaryAllows(semCoorte, 'business_effect_tool')).toBe(false);
  });

  it('política coerente libera conforme o degrau', () => {
    const p = politica({
      stage: 'private_memory',
      cohort_ref: 'coorte-1',
      acceptance_evidence_ref: 'aceite-1',
    });
    expect(canaryAllows(p, 'private_recall')).toBe(true);
    expect(canaryAllows(p, 'publish_shared_learning')).toBe(false);
  });
});
