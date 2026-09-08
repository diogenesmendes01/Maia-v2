/**
 * Issue #536 / PR #737 — a trava alcança a CONFIGURAÇÃO EFETIVA.
 *
 * Decisão do dono (2026-09-07): *"escolha alcançar a configuração efetiva; não
 * reduza a promessa. Use um único avaliador puro no config:preflight e no
 * boot, recebendo a configuração já parseada. Política destrutiva ativa sem
 * homologação deve falhar antes de iniciar workers, sem bypass por
 * MAIA_CONFIG_STRICT_BOOT=false."*
 *
 * Este arquivo testa o AVALIADOR — `evaluatePeriodicPolicyActivation(cfg)` —
 * isolado, com configurações construídas de propósito. Quem prova que ele
 * está LIGADO nos dois lugares certos são `tests/unit/config/preflight.spec.ts`
 * (preflight) e `tests/unit/runtime/homologation-boot-gate.spec.ts` (boot).
 * O guard sobre os DEFAULTS do contrato continua em
 * `retention-homologation-guard.spec.ts`.
 *
 * Anti-vacuidade: os casos que ACEITAM usam a mesma política e a mesma
 * configuração dos casos que REPROVAM, mudando uma coisa por vez — o aceite
 * nunca é uma lista vazia por acaso.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GRANDFATHERED_ACTIVATIONS,
  PERIODIC_POLICIES,
  evaluatePeriodicPolicyActivation,
  formatHomologationBootFailure,
  periodicPolicyDecidingVariables,
  type EffectiveConfigView,
  type PeriodicPolicy,
} from '../../../src/ops/privacy/homologation.js';
import { findSpec } from '../../../src/config/contract.js';

const REPO_ROOT = resolve(__dirname, '../../..');

/** Um valor que NÃO pode aparecer em nenhuma saída: é o canário de vazamento. */
const CANARY = 'CANARIO-dpo-assinou-em-segredo-9f3a';

/** Uma RETENTION_POLICY aprovada, nomeando uma classe purgável. */
function approvedPolicy(classes: Record<string, number>, approvedBy = CANARY): string {
  return JSON.stringify({
    version: 'v1-dpo-2026-07',
    approved_by: approvedBy,
    approved_at: '2026-07-01T00:00:00.000Z',
    classes: Object.fromEntries(
      Object.entries(classes).map(([k, days]) => [k, { retention_days: days }]),
    ),
  });
}

/**
 * A configuração efetiva com os DEFAULTS do contrato — lidos do contrato real,
 * não copiados. É o ponto de partida de todo caso: cada um muda UMA coisa.
 */
function contractDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of periodicPolicyDecidingVariables()) {
    const spec = findSpec(name);
    if (!spec) throw new Error(`variável decisória fora do contrato: ${name}`);
    out[name] = spec.schema.parse(undefined);
  }
  return out;
}

function cfg(overrides: Record<string, unknown> = {}): EffectiveConfigView {
  return { ...contractDefaults(), ...overrides };
}

const BACKUP_SWEEP = PERIODIC_POLICIES.find((p) => p.id === 'backup.artifact.retention_sweep')!;
const CLASS_PURGE = PERIODIC_POLICIES.find((p) => p.id === 'retention.class_purge')!;
const EXPORT_TTL = PERIODIC_POLICIES.find((p) => p.id === 'privacy.export.ttl_sweep')!;

function verdictOf(v: ReturnType<typeof evaluatePeriodicPolicyActivation>, id: string) {
  const hit = v.policies.find((p) => p.id === id);
  if (!hit) throw new Error(`política ausente do veredito: ${id}`);
  return hit;
}

describe('as variáveis que decidem a ativação efetiva', () => {
  it('são exatamente as três de hoje, e todas existem no contrato', () => {
    expect([...periodicPolicyDecidingVariables()]).toEqual([
      'PRIVACY_EXPORT_SWEEP_DRY_RUN',
      'RETENTION_DRY_RUN',
      'RETENTION_POLICY',
    ]);
    for (const name of periodicPolicyDecidingVariables()) {
      expect(findSpec(name), `${name} saiu do contrato`).toBeDefined();
    }
  });

  it('os defaults do contrato, avaliados como configuração EFETIVA, não têm violação', () => {
    // A mesma verdade que o guard de defaults afirma por outro caminho: se
    // isto reprovar, ou um default mudou, ou o avaliador lê algo errado.
    const v = evaluatePeriodicPolicyActivation(cfg());
    expect(v.violations.map((x) => `${x.code}: ${x.message}`)).toEqual([]);
    expect(v.ok).toBe(true);
  });
});

describe('política destrutiva ATIVA na configuração efetiva sem homologação ⇒ violação', () => {
  it('RETENTION_DRY_RUN=false liga o passe semanal de artefatos, que não tem autorização', () => {
    const v = evaluatePeriodicPolicyActivation(cfg({ RETENTION_DRY_RUN: false }));
    expect(v.ok).toBe(false);
    const sweep = verdictOf(v, BACKUP_SWEEP.id);
    expect(sweep.active_effective).toBe(true);
    expect(sweep.authorised).toBe(false);
    expect(sweep.violation?.code).toBe('destructive_policy_active_without_homologation');
    expect(sweep.violation?.rule).toBe('homologation/active-without-written-homologation');
    expect([...(sweep.violation?.variables ?? [])]).toEqual(['RETENTION_DRY_RUN']);
    // A mensagem nomeia variável e política — é o que o operador precisa ler.
    expect(sweep.violation?.message).toContain('RETENTION_DRY_RUN');
    expect(sweep.violation?.message).toContain(BACKUP_SWEEP.id);
  });

  it('só o dry-run desligado NÃO ativa a purga por classe — sem RETENTION_POLICY nada resolve purgável', () => {
    const v = evaluatePeriodicPolicyActivation(cfg({ RETENTION_DRY_RUN: false }));
    const purge = verdictOf(v, CLASS_PURGE.id);
    expect(purge.active_effective).toBe(false);
    expect(purge.violation).toBeUndefined();
    // Uma violação só — a do passe de artefatos.
    expect(v.violations.map((x) => x.policy_id)).toEqual([BACKUP_SWEEP.id]);
  });

  it('RETENTION_POLICY real instalada COM dry-run desligado ⇒ a purga por classe é violação', () => {
    const v = evaluatePeriodicPolicyActivation(
      cfg({
        RETENTION_DRY_RUN: false,
        RETENTION_POLICY: approvedPolicy({ 'postgres.traces': 30 }),
      }),
    );
    expect(v.ok).toBe(false);
    const purge = verdictOf(v, CLASS_PURGE.id);
    expect(purge.active_effective).toBe(true);
    expect(purge.violation?.code).toBe('destructive_policy_active_without_homologation');
    expect([...(purge.violation?.variables ?? [])]).toEqual([
      'RETENTION_DRY_RUN',
      'RETENTION_POLICY',
    ]);
    // As DUAS políticas que RETENTION_DRY_RUN=false liga aparecem — o veredito
    // nunca para na primeira.
    expect(v.violations.map((x) => x.policy_id).sort()).toEqual(
      [BACKUP_SWEEP.id, CLASS_PURGE.id].sort(),
    );
  });

  it('uma RETENTION_POLICY que só nomeia classes não-purgáveis não ativa nada', () => {
    // `parseRetentionPolicy` descarta a tombstone; a política aprovada fica
    // sem classe e `resolveRetention` continua recusando tudo.
    const v = evaluatePeriodicPolicyActivation(
      cfg({
        RETENTION_DRY_RUN: false,
        RETENTION_POLICY: approvedPolicy({ 'privacy.tombstone': 1 }),
      }),
    );
    expect(verdictOf(v, CLASS_PURGE.id).active_effective).toBe(false);
  });

  it('uma política NOVA ativa só na ratificação do dono, fora do grandfathering, é violação', () => {
    const nova: PeriodicPolicy = {
      ...BACKUP_SWEEP,
      id: 'postgres.traces.purge_sweep',
      data_class: 'postgres.traces',
      authorisation: {
        kind: 'owner_ratified_pending_homologation',
        ratified_by: 'platform_owner',
        ratified_in: 'uma conversa',
        owed_from: 'legal_dpo',
        what_is_owed: 'tudo',
      },
    };
    const v = evaluatePeriodicPolicyActivation(cfg({ RETENTION_DRY_RUN: false }), {
      policies: [nova],
    });
    expect(v.violations.map((x) => x.code)).toEqual([
      'destructive_policy_active_without_homologation',
    ]);
    expect(v.violations[0]?.message).toContain('GRANDFATHERED_ACTIVATIONS');
  });
});

describe('o que NÃO é violação — a trava é sobre ativar SEM homologação', () => {
  it('ativa COM homologação escrita ⇒ ok (a mesma política, a mesma configuração)', () => {
    const homologada: PeriodicPolicy = {
      ...BACKUP_SWEEP,
      authorisation: {
        kind: 'written_homologation',
        homologation: {
          authority: 'legal_dpo',
          approved_by: 'DPO',
          approved_at: '2026-09-01T00:00:00.000Z',
          recorded_in: 'ata assinada',
        },
      },
    };
    const v = evaluatePeriodicPolicyActivation(cfg({ RETENTION_DRY_RUN: false }), {
      policies: [homologada],
    });
    const hit = verdictOf(v, BACKUP_SWEEP.id);
    expect(hit.active_effective).toBe(true);
    expect(hit.authorised).toBe(true);
    expect(hit.violation).toBeUndefined();
    expect(v.ok).toBe(true);
  });

  it('ativa e GRANDFATHERED ⇒ ok: o TTL do export está ativo hoje e é o único item da lista', () => {
    expect([...GRANDFATHERED_ACTIVATIONS]).toEqual([EXPORT_TTL.id]);
    const v = evaluatePeriodicPolicyActivation(cfg());
    const ttl = verdictOf(v, EXPORT_TTL.id);
    expect(ttl.active_effective).toBe(true);
    expect(ttl.authorised).toBe(true);
    expect(ttl.violation).toBeUndefined();
  });

  it('o MESMO TTL fora do grandfathering vira violação — a lista é o que o autoriza', () => {
    const v = evaluatePeriodicPolicyActivation(cfg(), { grandfathered: [] });
    expect(verdictOf(v, EXPORT_TTL.id).violation?.code).toBe(
      'destructive_policy_active_without_homologation',
    );
  });

  it('INATIVA (dry-run ligado) ⇒ ok, mesmo com RETENTION_POLICY real instalada', () => {
    const v = evaluatePeriodicPolicyActivation(
      cfg({
        RETENTION_DRY_RUN: true,
        RETENTION_POLICY: approvedPolicy({ 'postgres.traces': 30 }),
      }),
    );
    expect(verdictOf(v, CLASS_PURGE.id).active_effective).toBe(false);
    expect(verdictOf(v, BACKUP_SWEEP.id).active_effective).toBe(false);
    expect(v.ok).toBe(true);
  });

  it('PRIVACY_EXPORT_SWEEP_DRY_RUN=true desliga o TTL — e desligado não precisa de autorização', () => {
    const v = evaluatePeriodicPolicyActivation(cfg({ PRIVACY_EXPORT_SWEEP_DRY_RUN: true }), {
      grandfathered: [],
    });
    expect(verdictOf(v, EXPORT_TTL.id).active_effective).toBe(false);
    expect(v.ok).toBe(true);
  });
});

describe('fail-closed: o que não está provado inativo não passa', () => {
  it('configuração sem valor tipado para a variável decisória ⇒ activation_undeterminable', () => {
    const semDryRun = { ...contractDefaults() };
    delete semDryRun.RETENTION_DRY_RUN;
    const v = evaluatePeriodicPolicyActivation(semDryRun);
    expect(v.ok).toBe(false);
    const codes = v.violations.map((x) => x.code);
    expect(codes).toContain('activation_undeterminable');
    expect(codes).not.toContain('destructive_policy_active_without_homologation');
    for (const x of v.violations) expect([...x.variables]).toContain('RETENTION_DRY_RUN');
  });

  it('uma string onde se espera boolean também é indeterminável — o avaliador não interpreta valor cru', () => {
    // O contrato é quem transforma 'false' em false. Receber a string é sinal
    // de que alguém passou `process.env` cru, e a trava recusa em vez de
    // adivinhar.
    const v = evaluatePeriodicPolicyActivation(cfg({ RETENTION_DRY_RUN: 'true' }));
    expect(v.violations.map((x) => x.code)).toContain('activation_undeterminable');
  });
});

describe('a saída nunca carrega valor — só nome de variável, regra e remediação', () => {
  it('o conteúdo de RETENTION_POLICY não aparece em nenhum campo do veredito nem na mensagem de boot', () => {
    const v = evaluatePeriodicPolicyActivation(
      cfg({
        RETENTION_DRY_RUN: false,
        RETENTION_POLICY: approvedPolicy({ 'postgres.traces': 30 }),
      }),
    );
    expect(v.violations.length).toBeGreaterThan(0);
    const serializado = JSON.stringify(v);
    expect(serializado).not.toContain(CANARY);
    expect(serializado).not.toContain('v1-dpo-2026-07');
    const boot = formatHomologationBootFailure(v.violations);
    expect(boot).toContain('HOMOLOGATION BOOT REFUSED');
    expect(boot).toContain('RETENTION_POLICY');
    expect(boot).toContain(CLASS_PURGE.id);
    expect(boot).not.toContain(CANARY);
    // Nomeia o rollback do contrato como algo que NÃO se aplica aqui.
    expect(boot).toMatch(/NÃO a desliga/);
  });
});

describe('o avaliador é PURO e não conhece o interruptor de rollback do contrato', () => {
  const ORIGINAL = process.env.MAIA_CONFIG_STRICT_BOOT;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MAIA_CONFIG_STRICT_BOOT;
    else process.env.MAIA_CONFIG_STRICT_BOOT = ORIGINAL;
  });

  it('MAIA_CONFIG_STRICT_BOOT=false no ambiente do processo NÃO muda o veredito', () => {
    // A sonda vermelha (b) do brief: um avaliador que respeitasse o bypass
    // devolveria ok=true aqui, e este caso ficaria vermelho.
    process.env.MAIA_CONFIG_STRICT_BOOT = 'false';
    const v = evaluatePeriodicPolicyActivation(cfg({ RETENTION_DRY_RUN: false }));
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.policy_id)).toEqual([BACKUP_SWEEP.id]);
  });

  it('o código do módulo não lê process.env e não menciona o interruptor fora de comentários', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'src/ops/privacy/homologation.ts'), 'utf8');
    const semComentarios = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(semComentarios).not.toMatch(/process\.env/);
    expect(semComentarios).not.toMatch(/STRICT_BOOT/);
    // E não importa configuração nenhuma: recebe-a por parâmetro.
    expect(semComentarios).not.toMatch(/@\/config\//);
  });
});
