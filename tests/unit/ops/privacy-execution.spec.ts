import { describe, it, expect, beforeEach } from 'vitest';
import {
  executePrivacyRequest,
  type PrivacyPorts,
  type PrivacyRequestRecord,
  type PurgeJob,
  type SubjectBinding,
} from '../../../src/ops/privacy/execution.js';
import {
  assertPrivacyTransition,
  resolveSubjectRef,
  isTerminalPrivacyStatus,
} from '../../../src/ops/privacy/workflow.js';
import { verifyTombstone, type TombstoneRecord } from '../../../src/ops/retention/tombstones.js';
import type { HoldRecord } from '../../../src/ops/retention/legal-hold.js';

/**
 * Issue #536 §2 — o workflow LGPD.
 *
 * As três propriedades que este arquivo defende, em uma linha cada:
 *
 *  - `legal_holds` VENCE apagamento, e vence BLOQUEANDO: o pedido termina
 *    `denied`, nada é apagado, e nenhuma classe é tocada nem parcialmente;
 *  - o tombstone é escrito ANTES da purga, para que um processo que morre no
 *    meio deixe um ledger que exagera (auto-corrigível) e nunca um ledger que
 *    omite (dado apagado que um restore ressuscita sem ninguém impedir);
 *  - evidência é contagem e código; o identificador do titular não atravessa
 *    audit, evidence nem log.
 */

const SECRET = 'k1';
const SCOPE = { tenant_id: 't1', agent_id: 'a1' };

function subject(): SubjectBinding {
  return {
    subject_ref: resolveSubjectRef(SCOPE, { kind: 'phone_e164', value: '+5511999990000' }, SECRET)
      .subject_ref,
    identifier: { kind: 'phone_e164', value: '+5511999990000' },
  };
}

function approvedRequest(over: Partial<PrivacyRequestRecord> = {}): PrivacyRequestRecord {
  return {
    id: 'req-1',
    tenant_id: SCOPE.tenant_id,
    agent_id: SCOPE.agent_id,
    type: 'deletion',
    status: 'approved',
    identity_verified_by: 'admin-console',
    approved_by: 'dpo',
    ...over,
  };
}

interface Recorder {
  ports: PrivacyPorts;
  /** Ordem literal dos efeitos, na sequência em que aconteceram. */
  trail: string[];
  tombstones: TombstoneRecord[];
  purges: PurgeJob[];
  patches: Record<string, unknown>[];
  audits: { action: string; metadata: Record<string, unknown> }[];
}

function recorder(over: Partial<PrivacyPorts> = {}, holds: HoldRecord[] | null = []): Recorder {
  const r: Recorder = {
    trail: [],
    tombstones: [],
    purges: [],
    patches: [],
    audits: [],
    ports: null as unknown as PrivacyPorts,
  };
  let seq = 0;
  r.ports = {
    listHolds: async () => holds,
    purge: async (job) => {
      r.trail.push(`purge:${job.data_class}`);
      r.purges.push(job);
      return 3;
    },
    stageExport: async (job) => {
      r.trail.push('stage');
      return { path: '/staging/x', rows: Object.fromEntries(job.data_classes.map((c) => [c, 1])) };
    },
    sealExport: async () => {
      r.trail.push('seal');
      return { locator: 'opaque-1', bytes: 10, key_id: 'k1' };
    },
    recordTombstone: async (t) => {
      r.trail.push(`tombstone:${t.data_class}`);
      r.tombstones.push(t);
    },
    updateRequest: async (_id, patch) => {
      r.trail.push(`update:${String(patch.status ?? 'field')}`);
      r.patches.push(patch);
    },
    audit: async (action, metadata) => {
      r.audits.push({ action, metadata });
    },
    now: () => new Date('2026-08-24T12:00:00.000Z'),
    newId: () => `ts-${++seq}`,
    tombstoneSecret: () => SECRET,
    exportTtlMs: 86_400_000,
    unsupported: {},
    ...over,
  };
  return r;
}

describe('resolução do sujeito', () => {
  it('pseudonimiza, e o pseudônimo é estável para o mesmo identificador', () => {
    const a = resolveSubjectRef(SCOPE, { kind: 'phone_e164', value: '+5511999990000' }, SECRET);
    const b = resolveSubjectRef(SCOPE, { kind: 'phone_e164', value: ' +5511999990000 ' }, SECRET);
    expect(a.subject_ref).toBe(b.subject_ref);
    expect(a.subject_ref).not.toContain('5511999990000');
  });

  it('o mesmo telefone em outro tenant é OUTRO sujeito', () => {
    const a = resolveSubjectRef(SCOPE, { kind: 'phone_e164', value: '+5511999990000' }, SECRET);
    const b = resolveSubjectRef(
      { tenant_id: 't2', agent_id: 'a1' },
      { kind: 'phone_e164', value: '+5511999990000' },
      SECRET,
    );
    expect(a.subject_ref).not.toBe(b.subject_ref);
  });

  it('recusa um telefone que não está em E.164 em vez de normalizar por conta própria', () => {
    expect(() =>
      resolveSubjectRef(SCOPE, { kind: 'phone_e164', value: '11999990000' }, SECRET),
    ).toThrow(expect.objectContaining({ code: 'privacy_subject_unresolvable' }));
  });

  it('recusa o literal `default`', () => {
    expect(() =>
      resolveSubjectRef(
        { tenant_id: 'default', agent_id: 'a1' },
        { kind: 'phone_e164', value: '+5511999990000' },
        SECRET,
      ),
    ).toThrow(expect.objectContaining({ code: 'privacy_subject_default_literal' }));
  });

  it('recusa derivar sem segredo — um pseudônimo sem chave não protege nada', () => {
    expect(() =>
      resolveSubjectRef(SCOPE, { kind: 'phone_e164', value: '+5511999990000' }, ''),
    ).toThrow(expect.objectContaining({ code: 'privacy_subject_secret_missing' }));
  });
});

describe('máquina de estados', () => {
  it('proíbe o atalho approved → completed', () => {
    expect(() => assertPrivacyTransition('approved', 'completed')).toThrow(
      expect.objectContaining({ code: 'privacy_illegal_transition' }),
    );
  });

  it('permite denied e failed a partir de qualquer estado não terminal', () => {
    for (const from of ['received', 'identity_pending', 'identity_verified', 'approved', 'in_progress'] as const) {
      expect(() => assertPrivacyTransition(from, 'denied')).not.toThrow();
      expect(() => assertPrivacyTransition(from, 'failed')).not.toThrow();
    }
  });

  it('estado terminal não sai mais', () => {
    for (const s of ['completed', 'denied', 'failed'] as const) {
      expect(isTerminalPrivacyStatus(s)).toBe(true);
      expect(() => assertPrivacyTransition(s, 'in_progress')).toThrow();
    }
  });
});

describe('legal hold VENCE apagamento — bloqueando, não adiando', () => {
  const hold: HoldRecord = {
    id: 'h1',
    tenant_id: SCOPE.tenant_id,
    agent_id: SCOPE.agent_id,
    data_class: '*',
    subject_ref: null,
    status: 'active',
    effective_from: new Date('2026-01-01T00:00:00.000Z'),
    effective_until: null,
    reason_code: 'judicial',
  };

  let r: Recorder;
  beforeEach(() => {
    r = recorder({}, [hold]);
  });

  it('nenhuma classe é apagada e nenhum tombstone é escrito', async () => {
    const out = await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    expect(out.status).toBe('denied');
    expect(out.reason_code).toBe('legal_hold');
    expect(r.purges).toEqual([]);
    expect(r.tombstones).toEqual([]);
  });

  it('o pedido fica TERMINAL — não volta a `approved` para tentar depois', async () => {
    const out = await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    expect(isTerminalPrivacyStatus(out.status)).toBe(true);
    const statuses = r.patches.map((p) => p.status).filter(Boolean);
    expect(statuses).toEqual(['in_progress', 'denied']);
  });

  it('a recusa é auditada com os ids do hold e o CÓDIGO do motivo', async () => {
    await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    const blocked = r.audits.find((a) => a.action === 'legal_hold_blocked_purge');
    expect(blocked?.metadata.hold_ids).toEqual(['h1']);
    expect(blocked?.metadata.reason_codes).toEqual(['judicial']);
    expect(r.audits.some((a) => a.action === 'privacy_request_denied')).toBe(true);
  });

  it('o hold também bloqueia o EXPORT, não só a exclusão', async () => {
    const out = await executePrivacyRequest(
      approvedRequest({ type: 'access_export' }),
      subject(),
      r.ports,
    );
    expect(out.status).toBe('denied');
    expect(out.export_issued).toBe(false);
    expect(r.trail).not.toContain('stage');
  });

  it('um hold de OUTRO tenant não bloqueia — e não protege', async () => {
    const foreign = recorder({}, [{ ...hold, tenant_id: 't-outro' }]);
    const out = await executePrivacyRequest(approvedRequest(), subject(), foreign.ports);
    expect(out.status).toBe('completed');
  });

  it('holds ilegíveis falham FECHADO: nada apagado, nada negado por engano', async () => {
    const unreadable = recorder({}, null);
    const out = await executePrivacyRequest(approvedRequest(), subject(), unreadable.ports);
    expect(out.status).toBe('failed');
    expect(out.reason_code).toBe('hold_unreadable');
    expect(unreadable.purges).toEqual([]);
    expect(unreadable.tombstones).toEqual([]);
  });
});

describe('anti-ressurreição: o tombstone precede a purga', () => {
  it('para CADA classe, o tombstone é escrito antes da exclusão', async () => {
    const r = recorder();
    await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    const effects = r.trail.filter((e) => e.startsWith('tombstone:') || e.startsWith('purge:'));
    expect(effects.length).toBeGreaterThan(0);
    for (let i = 0; i < effects.length; i += 2) {
      const [tomb, purge] = [effects[i], effects[i + 1]];
      expect(tomb.startsWith('tombstone:')).toBe(true);
      expect(purge).toBe(`purge:${tomb.slice('tombstone:'.length)}`);
    }
  });

  it('a purga que falha NÃO retira o tombstone já gravado', async () => {
    const r = recorder({
      purge: async () => {
        throw Object.assign(new Error('x'), { code: 'purge_failed' });
      },
    });
    const out = await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    expect(out.status).toBe('failed');
    expect(out.reason_code).toBe('purge_failed');
    expect(out.tombstone_ids).toHaveLength(1);
    expect(r.tombstones).toHaveLength(1);
  });

  it('a falha ao GRAVAR o tombstone impede a purga daquela classe', async () => {
    const r = recorder({
      recordTombstone: async () => {
        throw Object.assign(new Error('x'), { code: 'tombstone_write_failed' });
      },
    });
    const out = await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    expect(out.status).toBe('failed');
    expect(out.reason_code).toBe('tombstone_write_failed');
    expect(r.purges).toEqual([]);
  });

  it('todo tombstone sai ASSINADO e verificável com o mesmo segredo', async () => {
    const r = recorder();
    await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    expect(r.tombstones.length).toBeGreaterThan(0);
    for (const t of r.tombstones) {
      expect(verifyTombstone(t, SECRET)).toBe(true);
      expect(verifyTombstone(t, 'outro-segredo')).toBe(false);
      expect(t.origin).toBe('privacy_request');
      expect(t.subject_ref).toBe(subject().subject_ref);
    }
  });
});

describe('cobertura e exceções', () => {
  it('classes não purgáveis viram EXCEÇÃO registrada, não omissão', async () => {
    const r = recorder();
    const out = await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    expect(out.status).toBe('completed');
    expect(out.exceptions.map((e) => e.data_class)).toContain('postgres.financial');
    expect(out.exceptions.map((e) => e.data_class)).toContain('privacy.tombstone');
    expect(out.systems_covered).not.toContain('postgres.financial');
  });

  it('a anonimização usa o mecanismo declarado pela classe, não `delete` para tudo', async () => {
    const r = recorder();
    await executePrivacyRequest(approvedRequest({ type: 'anonymization' }), subject(), r.ports);
    const people = r.purges.find((p) => p.data_class === 'postgres.people');
    expect(people?.mechanism).toBe('anonymize');
    const audit = r.purges.find((p) => p.data_class === 'postgres.audit');
    expect(audit?.mechanism).toBe('redact');
    const messages = r.purges.find((p) => p.data_class === 'postgres.messages');
    expect(messages?.mechanism).toBe('delete');
  });

  it('classe sem mecanismo implementado vira EXCEÇÃO registrada, nunca uma purga de zero linhas', async () => {
    // A diferença entre as duas é jurídica, não técnica: um `purge` que
    // devolvesse 0 faria o pedido se declarar cumprido sem ter apagado nada.
    const r = recorder({ unsupported: { 'media.blobs': 'mechanism_not_implemented' } });
    const out = await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    expect(out.status).toBe('completed');
    expect(out.exceptions).toContainEqual({
      data_class: 'media.blobs',
      reason: 'mechanism_not_implemented',
    });
    expect(r.purges.map((p) => p.data_class)).not.toContain('media.blobs');
    expect(r.tombstones.map((t) => t.data_class)).not.toContain('media.blobs');
    expect(out.systems_covered).not.toContain('media.blobs');
  });

  it('quando as DUAS razões valem, as duas são registradas', async () => {
    // `postgres.financial` é não-purgável por retenção contábil E não tem
    // ligação de titular utilizável para o export. São perguntas diferentes —
    // "por que nada foi apagado" e "por que nada foi exportado" — e registrar
    // só uma deixaria a outra sem resposta no relatório do pedido.
    const r = recorder({ unsupported: { 'postgres.financial': 'no_subject_linkage' } });
    const out = await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    expect(out.exceptions).toContainEqual({
      data_class: 'postgres.financial',
      reason: 'class_not_purgeable,no_subject_linkage',
    });
  });

  it('classe sem mecanismo também não entra no export — e a exceção é reportada', async () => {
    const r = recorder({ unsupported: { 'media.blobs': 'mechanism_not_implemented' } });
    const out = await executePrivacyRequest(
      approvedRequest({ type: 'access_export' }),
      subject(),
      r.ports,
    );
    expect(out.systems_covered).not.toContain('media.blobs');
    expect(out.exceptions.map((e) => e.data_class)).toContain('media.blobs');
  });

  it('mensagens são purgadas ANTES das conversas — o cascade mentiria na contagem', async () => {
    // `mensagens.conversa_id` é `REFERENCES conversas(id) ON DELETE CASCADE`
    // (migration 001). Em ordem alfabética `postgres.conversations` viria
    // primeiro, o DELETE das conversas levaria as mensagens junto, e a purga
    // de mensagens contaria ZERO — dado apagado, evidência dizendo que não.
    const r = recorder();
    await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    const order = r.purges.map((p) => p.data_class);
    expect(order.indexOf('postgres.messages')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('postgres.messages')).toBeLessThan(
      order.indexOf('postgres.conversations'),
    );
  });

  it('pessoas é a ÚLTIMA — anonimizar antes cegaria a resolução do sujeito', async () => {
    // O adapter acha o titular derivando o `subject_ref` de cada linha de
    // `pessoas`. Anonimizar primeiro apagaria o telefone de que essa derivação
    // depende, e as classes seguintes não achariam mais ninguém.
    const r = recorder();
    await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    const order = r.purges.map((p) => p.data_class);
    expect(order.at(-1)).toBe('postgres.people');
  });

  it('nenhuma classe de escopo de SISTEMA entra num pedido de titular', async () => {
    const r = recorder();
    await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    const touched = r.purges.map((p) => p.data_class);
    expect(touched).not.toContain('backup.artifact');
    expect(touched).not.toContain('queue.redis');
    expect(touched).not.toContain('gateway.baileys_session');
  });
});

describe('export cifrado', () => {
  it('cifra, devolve locator OPACO e carimba expiração', async () => {
    const r = recorder();
    const out = await executePrivacyRequest(
      approvedRequest({ type: 'access_export' }),
      subject(),
      r.ports,
    );
    expect(out.status).toBe('completed');
    expect(out.export_issued).toBe(true);
    expect(r.trail).toEqual(expect.arrayContaining(['stage', 'seal']));
    const patch = r.patches.find((p) => 'export_locator' in p);
    expect(patch?.export_locator).toBe('opaque-1');
    expect(patch?.export_expires_at).toBeInstanceOf(Date);
  });

  it('um export que não pôde ser cifrado NÃO vira pedido concluído', async () => {
    const r = recorder({
      sealExport: async () => {
        throw Object.assign(new Error('x'), { code: 'backup_key_unavailable' });
      },
    });
    const out = await executePrivacyRequest(
      approvedRequest({ type: 'access_export' }),
      subject(),
      r.ports,
    );
    expect(out.status).toBe('failed');
    expect(out.reason_code).toBe('backup_key_unavailable');
    expect(r.patches.some((p) => 'export_locator' in p)).toBe(false);
  });

  it('nenhuma classe é apagada por um pedido de acesso', async () => {
    const r = recorder();
    await executePrivacyRequest(approvedRequest({ type: 'access_export' }), subject(), r.ports);
    expect(r.purges).toEqual([]);
    expect(r.tombstones).toEqual([]);
  });
});

describe('portões de execução', () => {
  it('recusa executar um pedido que não está `approved`', async () => {
    const r = recorder();
    await expect(
      executePrivacyRequest(approvedRequest({ status: 'identity_verified' }), subject(), r.ports),
    ).rejects.toThrow(expect.objectContaining({ code: 'privacy_request_not_approved' }));
    expect(r.purges).toEqual([]);
  });

  it('recusa executar sem identidade verificada', async () => {
    const r = recorder();
    await expect(
      executePrivacyRequest(approvedRequest({ identity_verified_by: null }), subject(), r.ports),
    ).rejects.toThrow(expect.objectContaining({ code: 'privacy_request_identity_unverified' }));
    expect(r.purges).toEqual([]);
  });

  it('recusa executar sem aprovador registrado', async () => {
    const r = recorder();
    await expect(
      executePrivacyRequest(approvedRequest({ approved_by: '  ' }), subject(), r.ports),
    ).rejects.toThrow(expect.objectContaining({ code: 'privacy_request_unapproved_actor' }));
  });

  it('recusa o literal `default`', async () => {
    const r = recorder();
    await expect(
      executePrivacyRequest(approvedRequest({ tenant_id: 'default' }), subject(), r.ports),
    ).rejects.toThrow(expect.objectContaining({ code: 'privacy_request_default_literal' }));
  });

  it('recusa `rectification` em vez de fingir que a executou', async () => {
    const r = recorder();
    await expect(
      executePrivacyRequest(approvedRequest({ type: 'rectification' }), subject(), r.ports),
    ).rejects.toThrow(expect.objectContaining({ code: 'privacy_request_type_not_executable' }));
  });
});

describe('evidência não carrega conteúdo nem identificador', () => {
  it('nem audit nem evidence contêm o telefone do titular', async () => {
    const r = recorder();
    await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    const blob = JSON.stringify({ audits: r.audits, patches: r.patches });
    expect(blob).not.toContain('5511999990000');
  });

  it('a evidência é contagem por classe', async () => {
    const r = recorder();
    await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    const done = r.audits.find((a) => a.action === 'privacy_request_completed');
    expect(done?.metadata.purged).toMatchObject({ 'postgres.messages': 3 });
    expect(done?.metadata.tombstones).toBeGreaterThan(0);
  });

  it('um código de erro desconhecido não é ecoado — vira o código genérico', async () => {
    const r = recorder({
      purge: async () => {
        throw Object.assign(new Error('postgres://user:senha@host/db'), {
          code: 'postgres://user:senha@host/db',
        });
      },
    });
    const out = await executePrivacyRequest(approvedRequest(), subject(), r.ports);
    expect(out.reason_code).toBe('purge_failed');
    expect(JSON.stringify(r.audits)).not.toContain('senha');
  });
});
