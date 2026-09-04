import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  DATA_CLASSES,
  UNAPPROVED_POLICY,
  parseRetentionPolicy,
  resolveRetention,
  type RetentionPolicy,
} from '../../../src/ops/retention/data-classes.js';
import {
  executePrivacyRequest,
  type PrivacyPorts,
  type PrivacyRequestRecord,
  type PurgeJob,
} from '../../../src/ops/privacy/execution.js';
import { resolveSubjectRef } from '../../../src/ops/privacy/workflow.js';
import { ENV_CONTRACT, findSpec } from '../../../src/config/contract.js';

/**
 * Issue #536 — o guard do desenho RATIFICADO: `privacy.tombstone` é
 * estruturalmente não-purgável, e a ratificação do dono (2026-09-02,
 * reafirmada 2026-09-03) só se sustenta se o repositório INTEIRO se comportar
 * assim — não apenas o metadado que o declara.
 *
 * A crítica do dono que este arquivo responde: um guard que afirma
 * texto/metadado não alcança a configuração efetiva do ambiente. Então este
 * arquivo vai até onde um teste unitário SEM banco alcança honestamente:
 *
 *  1. o CALL SITE real da purga por sujeito (`executePrivacyRequest`) nunca
 *     emite um purge para a classe — não é só o inventário dizendo
 *     `not_purgeable`, é o executor recusando no caminho que executa;
 *  2. `resolveRetention` recusa a classe mesmo que uma política já montada
 *     (contornando o parser) a inclua — o ramo `not_purgeable` vem ANTES de a
 *     política ser consultada;
 *  3. nenhuma política periódica no CÓDIGO/CONFIG do repositório referencia a
 *     classe: nenhum job registrado no registry de workers varre tombstones, e
 *     nenhuma chave do contrato de configuração configura um TTL/sweep de
 *     tombstone;
 *  4. os DEFAULTS do contrato de configuração — a configuração efetiva que o
 *     repositório produz sem intervenção — deixam a purga por prazo inerte
 *     (`RETENTION_DRY_RUN` ⇒ true, `RETENTION_POLICY` ausente ⇒ política
 *     não-aprovada).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LIMITE DECLARADO — o que este guard NÃO alcança, e por quê.
 *
 * Um ambiente IMPLANTADO pode sobrescrever qualquer default do contrato
 * (`RETENTION_DRY_RUN=false`, uma `RETENTION_POLICY` real) e tem um banco cujo
 * conteúdo nenhum teste unitário vê. O CI deste repositório não tem essa
 * infraestrutura, então este arquivo NÃO prova nada sobre o ambiente vivo —
 * ele prova que o repositório não CONTÉM um caminho que purgue tombstones e
 * que a configuração default não o cria. O que alcança o ambiente efetivo é
 * `npm run config:preflight` / `npm run doctor` e a revisão de ambiente, e é
 * deliberado que esta fronteira esteja escrita aqui em vez de fingida.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Anti-vacuidade: todo teste de recusa deste arquivo também afirma que o
 * mecanismo varrido EXISTE (a purga das outras classes aconteceu, o registry
 * tem os jobs conhecidos, o contrato tem as chaves conhecidas) — uma lista
 * vazia não passa como "nada referencia tombstone".
 */

const SECRET = 'k1';
const SCOPE = { tenant_id: 't1', agent_id: 'a1' };

function approvedDeletion(): PrivacyRequestRecord {
  return {
    id: 'req-tomb-1',
    tenant_id: SCOPE.tenant_id,
    agent_id: SCOPE.agent_id,
    type: 'deletion',
    status: 'approved',
    identity_verified_by: 'admin-console',
    approved_by: 'dpo',
  };
}

function ports(purges: PurgeJob[]): PrivacyPorts {
  let seq = 0;
  return {
    listHolds: async () => [],
    purge: async (job) => {
      purges.push(job);
      return 2;
    },
    stageExport: async (job) => ({
      path: '/staging/x',
      rows: Object.fromEntries(job.data_classes.map((c) => [c, 1])),
    }),
    sealExport: async () => ({ locator: 'opaque-1', bytes: 10, key_id: 'k1' }),
    recordTombstone: async () => {},
    updateRequest: async () => {},
    audit: async () => {},
    now: () => new Date('2026-09-03T12:00:00.000Z'),
    newId: () => `ts-${++seq}`,
    tombstoneSecret: () => SECRET,
    exportTtlMs: 86_400_000,
    unsupported: {},
  };
}

describe('o call site real: a execução de privacidade nunca purga o ledger', () => {
  it('uma exclusão aprovada purga outras classes e NUNCA emite purge para privacy.tombstone', async () => {
    const purges: PurgeJob[] = [];
    const subject = {
      subject_ref: resolveSubjectRef(SCOPE, { kind: 'phone_e164' as const, value: '+5511999990000' }, SECRET)
        .subject_ref,
      identifier: { kind: 'phone_e164' as const, value: '+5511999990000' },
    };
    const out = await executePrivacyRequest(approvedDeletion(), subject, ports(purges));

    // Anti-vacuidade: a purga ACONTECEU — o teste não está passando porque
    // nada foi purgado.
    expect(out.status).toBe('completed');
    expect(purges.length).toBeGreaterThan(0);
    expect(purges.map((p) => p.data_class)).toContain('postgres.messages');

    // A recusa, no caminho que executa: nenhum purge para o ledger, e a
    // ausência é EXCEÇÃO registrada no pedido, não omissão.
    expect(purges.map((p) => p.data_class)).not.toContain('privacy.tombstone');
    const exception = out.exceptions.find((e) => e.data_class === 'privacy.tombstone');
    expect(exception?.reason).toContain('class_not_purgeable');
  });
});

describe('resolveRetention recusa antes de consultar a política', () => {
  it('recusa a classe mesmo numa política já montada que a inclui (contornando o parser)', () => {
    // `parseRetentionPolicy` derruba a entrada (coberto em
    // retention-data-classes.spec.ts). Aqui o ataque é mais fundo: uma
    // RetentionPolicy construída à mão, como se o parser tivesse deixado
    // passar. O ramo `not_purgeable` vem primeiro, então nem essa política
    // alcança a aritmética de prazo.
    const smuggled: RetentionPolicy = {
      version: 'v1-smuggled',
      approved: true,
      approved_by: 'dpo@example',
      classes: { 'privacy.tombstone': { retention_days: 1 } },
    };
    const verdict = resolveRetention('privacy.tombstone', smuggled);
    expect(verdict.purgeable).toBe(false);
    expect(verdict.reason).toBe('class_not_purgeable');

    // Anti-vacuidade: a MESMA política montada à mão torna uma classe purgável
    // purgável — a recusa acima é da classe, não de a política ser ignorada.
    const control = resolveRetention('postgres.traces', {
      ...smuggled,
      classes: { 'postgres.traces': { retention_days: 1 } },
    });
    expect(control.purgeable).toBe(true);
  });

  it('o inventário continua declarando a classe not_purgeable', () => {
    const klass = DATA_CLASSES.find((c) => c.id === 'privacy.tombstone');
    expect(klass?.purge_mechanism).toBe('not_purgeable');
  });
});

describe('nenhuma política periódica no código/config do repositório referencia a classe', () => {
  const registrySource = readFileSync(
    fileURLToPath(new URL('../../../src/workers/index.ts', import.meta.url)),
    'utf8',
  );
  const jobNames = [...registrySource.matchAll(/name:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]!);

  it('o registry de workers não tem job de varredura/purga de tombstone', () => {
    // Anti-vacuidade: o registry foi lido de verdade e contém os varredores
    // periódicos conhecidos — se o arquivo mudar de lugar ou de forma, este
    // teste fica vermelho em vez de passar varrendo o vazio.
    expect(jobNames.length).toBeGreaterThanOrEqual(30);
    expect(jobNames).toContain('privacy_export_sweep');
    expect(jobNames).toContain('backup_retention');

    expect(jobNames.filter((n) => n.includes('tombstone'))).toEqual([]);
    // Nem por id de classe: o registry inteiro não menciona o ledger.
    expect(registrySource).not.toContain('privacy.tombstone');
  });

  it('o contrato de configuração não tem chave que configure TTL/sweep de tombstone', () => {
    const keys = Object.keys(ENV_CONTRACT);
    // Anti-vacuidade: as chaves que GOVERNAM purga periódica existem e são
    // estas — a ausência de uma chave de tombstone não é um contrato vazio.
    expect(keys).toContain('RETENTION_DRY_RUN');
    expect(keys).toContain('RETENTION_POLICY');
    expect(keys).toContain('PRIVACY_EXPORT_TTL_DAYS');
    expect(keys).toContain('PRIVACY_EXPORT_SWEEP_DRY_RUN');

    expect(keys.filter((k) => k.includes('TOMBSTONE'))).toEqual([]);
  });
});

describe('os defaults do contrato deixam a purga por prazo inerte', () => {
  it('RETENTION_DRY_RUN default é dry-run LIGADO — lido do contrato real, não de uma cópia', () => {
    const spec = findSpec('RETENTION_DRY_RUN');
    expect(spec, 'RETENTION_DRY_RUN sumiu do contrato').toBeDefined();
    expect(spec!.schema.parse(undefined)).toBe(true);
  });

  it('RETENTION_POLICY ausente por default ⇒ a política em vigor é a NÃO-aprovada', () => {
    const spec = findSpec('RETENTION_POLICY');
    expect(spec, 'RETENTION_POLICY sumiu do contrato').toBeDefined();
    const defaultValue = spec!.schema.parse(undefined) as string | undefined;
    expect(defaultValue).toBeUndefined();
    expect(parseRetentionPolicy(defaultValue).approved).toBe(false);
    // E sob essa política nada resolve purgável — tombstone incluída.
    for (const c of DATA_CLASSES) {
      expect(resolveRetention(c.id, UNAPPROVED_POLICY).purgeable).toBe(false);
    }
  });
});
