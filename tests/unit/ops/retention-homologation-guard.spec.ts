import { describe, it, expect } from 'vitest';
import {
  PERIODIC_POLICIES,
  GRANDFATHERED_ACTIVATIONS,
  RATIFIED_NON_PURGEABLE,
  auditPeriodicPolicies,
  type PeriodicPolicy,
} from '../../../src/ops/privacy/homologation.js';
import {
  DATA_CLASSES,
  UNAPPROVED_POLICY,
  parseRetentionPolicy,
  type DataClass,
} from '../../../src/ops/retention/data-classes.js';
import { findSpec } from '../../../src/config/contract.js';

/**
 * Issue #536 — A TRAVA, executável.
 *
 * A direção do dono: *"nenhuma política periódica nova deve ser ativada sem
 * homologação escrita"*. Este arquivo é essa frase com dentes. Ele reprova
 * quando:
 *
 *   - uma classe de retenção passa a ser purgável sem uma política homologada;
 *   - uma classe estruturalmente não-purgável (tombstone, financeiro, sessão)
 *     é promovida a purgável;
 *   - uma política periódica passa a estar ATIVA sem homologação escrita;
 *   - a declaração de ativação deixa de bater com o default do contrato — que
 *     é como uma política ligaria sem ninguém perceber.
 *
 * O primeiro `it` é o guard sobre o estado REAL do repositório; os demais
 * provam que ele morde, construindo cada violação de propósito. Um guard que
 * só é verde nunca provou que sabe ficar vermelho.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LIMITE DECLARADO — o que este guard NÃO alcança, e por quê.
 *
 * O guard alcança o estado DECLARADO no código e os DEFAULTS do contrato de
 * configuração (`ENV_CONTRACT`, lido de verdade via `findSpec`, nunca uma
 * cópia à mão). Ele NÃO alcança a configuração efetiva de um ambiente
 * implantado: um operador que exporte `RETENTION_DRY_RUN=false` ou instale
 * uma `RETENTION_POLICY` real ativa uma política sem que nenhum teste
 * unitário veja — o CI deste repositório não tem banco nem o ambiente vivo.
 * O que alcança o ambiente efetivo é `npm run config:preflight` /
 * `npm run doctor` e a revisão de ambiente. Esta fronteira fica escrita aqui
 * (e na matriz) em vez de fingida: um guard que afirmasse cobrir o ambiente
 * estaria mentindo sobre o próprio alcance.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Lê o DEFAULT do contrato de configuração — o de verdade, não uma cópia.
 * Convenção do repo: dry-run LIGADO ⇒ política INATIVA. Se alguém inverter o
 * default de `RETENTION_DRY_RUN`, isto muda de valor e o guard fica vermelho
 * sem que ninguém precise lembrar de atualizar um teste.
 */
function contractDryRunDefault(name: string): boolean | undefined {
  const spec = findSpec(name);
  if (!spec) return undefined;
  const parsed = spec.schema.safeParse(undefined);
  if (!parsed.success) return undefined;
  return parsed.data === true;
}

function approvedPolicy(classes: Record<string, number>): string {
  return JSON.stringify({
    version: 'v1-dpo-2026-07',
    approved_by: 'dpo@example',
    approved_at: '2026-07-01T00:00:00.000Z',
    classes: Object.fromEntries(
      Object.entries(classes).map(([k, days]) => [k, { retention_days: days }]),
    ),
  });
}

const NEW_ACTIVE_POLICY: PeriodicPolicy = {
  id: 'postgres.traces.purge_sweep',
  data_class: 'postgres.traces',
  cadence: '0 3 * * *',
  destroys: 'corpos de trace com prompts e respostas cruas',
  active_by_default: true,
  dry_run_var: null,
  authorisation: { kind: 'none', why: 'ninguém homologou nada — é o ponto do teste' },
};

describe('a trava: nenhuma política periódica ativa sem homologação escrita', () => {
  it('o estado do repositório hoje não tem nenhuma violação', () => {
    const violations = auditPeriodicPolicies({ dryRunDefault: contractDryRunDefault });
    // A mensagem inteira entra na saída: quem quebrar isto lê o que fazer sem
    // abrir o arquivo.
    expect(violations.map((v) => `${v.code}: ${v.detail}`)).toEqual([]);
  });

  it('cada política periódica declara uma autorização — o campo não é opcional', () => {
    expect(PERIODIC_POLICIES.length).toBeGreaterThan(0);
    for (const p of PERIODIC_POLICIES) {
      expect(p.authorisation.kind).toMatch(
        /^(written_homologation|owner_ratified_pending_homologation|none)$/,
      );
    }
  });

  it('reprova uma política NOVA que entra ativa sem autorização nenhuma', () => {
    const violations = auditPeriodicPolicies({
      policies: [NEW_ACTIVE_POLICY],
      dryRunDefault: contractDryRunDefault,
    });
    expect(violations.map((v) => v.code)).toContain('active_without_authorisation');
  });

  it('a mesma política INATIVA não é violação — a trava é sobre ativar', () => {
    const violations = auditPeriodicPolicies({
      policies: [{ ...NEW_ACTIVE_POLICY, active_by_default: false }],
      dryRunDefault: contractDryRunDefault,
    });
    expect(violations.filter((v) => v.policy_id === NEW_ACTIVE_POLICY.id)).toEqual([]);
  });

  it('reprova uma política NOVA ativada só na ratificação do dono (a ratificação não é homologação)', () => {
    const violations = auditPeriodicPolicies({
      policies: [
        {
          ...NEW_ACTIVE_POLICY,
          authorisation: {
            kind: 'owner_ratified_pending_homologation',
            ratified_by: 'platform_owner',
            ratified_in: 'uma conversa',
            owed_from: 'legal_dpo',
            what_is_owed: 'tudo',
          },
        },
      ],
      dryRunDefault: contractDryRunDefault,
    });
    expect(violations.map((v) => v.code)).toContain(
      'new_activation_without_written_homologation',
    );
  });

  it('aceita uma política ativa COM homologação escrita — a trava não é um bloqueio permanente', () => {
    const violations = auditPeriodicPolicies({
      policies: [
        {
          ...NEW_ACTIVE_POLICY,
          authorisation: {
            kind: 'written_homologation',
            homologation: {
              authority: 'legal_dpo',
              approved_by: 'DPO',
              approved_at: '2026-09-01T00:00:00.000Z',
              recorded_in: 'ata assinada',
            },
          },
        },
      ],
      dryRunDefault: contractDryRunDefault,
    });
    expect(violations.filter((v) => v.policy_id === NEW_ACTIVE_POLICY.id)).toEqual([]);
  });

  it('o grandfathering é uma lista fechada, e o TTL do export é o único item', () => {
    expect([...GRANDFATHERED_ACTIVATIONS]).toEqual(['privacy.export.ttl_sweep']);
  });
});

describe('o TTL do export: ativo hoje, homologação ainda devida', () => {
  const ttl = PERIODIC_POLICIES.find((p) => p.id === 'privacy.export.ttl_sweep');

  it('está declarado como ATIVO com os defaults do contrato', () => {
    expect(ttl?.active_by_default).toBe(true);
    expect(contractDryRunDefault('PRIVACY_EXPORT_SWEEP_DRY_RUN')).toBe(false);
  });

  it('registra que a confirmação do DPO continua devida — os dois fatos juntos', () => {
    expect(ttl?.authorisation.kind).toBe('owner_ratified_pending_homologation');
    if (ttl?.authorisation.kind !== 'owner_ratified_pending_homologation') throw new Error('shape');
    expect(ttl.authorisation.owed_from).toBe('legal_dpo');
    expect(ttl.authorisation.what_is_owed.length).toBeGreaterThan(10);
  });

  it('o prazo de sete dias vive na configuração, não numa constante', () => {
    const spec = findSpec('PRIVACY_EXPORT_TTL_DAYS');
    expect(spec?.schema.parse(undefined)).toBe(7);
  });
});

describe('promover uma classe a purgável sem homologação é reprovado', () => {
  it('reprova quando uma classe resolve purgável e nenhuma política homologada a cobre', () => {
    const violations = auditPeriodicPolicies({
      retentionPolicy: parseRetentionPolicy(approvedPolicy({ 'postgres.traces': 30 })),
      dryRunDefault: contractDryRunDefault,
    });
    const hit = violations.find((v) => v.data_class === 'postgres.traces');
    expect(hit?.code).toBe('purgeable_class_without_homologated_policy');
  });

  it('nada é purgável sob a política em vigor hoje, então nada dispara essa violação', () => {
    const violations = auditPeriodicPolicies({
      retentionPolicy: UNAPPROVED_POLICY,
      dryRunDefault: contractDryRunDefault,
    });
    expect(
      violations.filter((v) => v.code === 'purgeable_class_without_homologated_policy'),
    ).toEqual([]);
  });

  it('reprova quando uma classe estruturalmente não-purgável é promovida', () => {
    const tampered: DataClass[] = DATA_CLASSES.map((c) =>
      c.id === 'privacy.tombstone' ? { ...c, purge_mechanism: 'delete' as const } : c,
    );
    const violations = auditPeriodicPolicies({
      classes: tampered,
      dryRunDefault: contractDryRunDefault,
    });
    const hit = violations.find((v) => v.data_class === 'privacy.tombstone');
    expect(hit?.code).toBe('ratified_non_purgeable_class_became_purgeable');
    expect(hit?.detail).toContain('mudança de DESENHO');
  });

  it('as três classes congeladas continuam not_purgeable no inventário', () => {
    for (const id of Object.keys(RATIFIED_NON_PURGEABLE)) {
      const klass = DATA_CLASSES.find((c) => c.id === id);
      expect(klass, `classe congelada ausente do inventário: ${id}`).toBeDefined();
      expect(klass?.purge_mechanism).toBe('not_purgeable');
    }
  });
});

describe('a declaração de ativação não pode envelhecer em silêncio', () => {
  it('reprova quando o default do contrato ativa uma política declarada inativa', () => {
    const violations = auditPeriodicPolicies({
      policies: PERIODIC_POLICIES.filter((p) => p.id === 'backup.artifact.retention_sweep'),
      // Simula alguém invertendo o default de RETENTION_DRY_RUN para `false`.
      dryRunDefault: () => false,
    });
    expect(violations.map((v) => v.code)).toContain('activation_declaration_mismatch');
  });

  it('reprova quando a variável de dry-run declarada não existe mais no contrato', () => {
    const violations = auditPeriodicPolicies({
      policies: [{ ...NEW_ACTIVE_POLICY, dry_run_var: 'MAIA_NAO_EXISTE' }],
      dryRunDefault: contractDryRunDefault,
    });
    expect(violations.map((v) => v.code)).toContain('activation_declaration_mismatch');
  });

  it('confere o default real de RETENTION_DRY_RUN: a retenção por prazo não apaga hoje', () => {
    expect(contractDryRunDefault('RETENTION_DRY_RUN')).toBe(true);
  });
});
