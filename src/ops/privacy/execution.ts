/**
 * Issue #536 §2 — a execução do pedido de privacidade.
 *
 * Este módulo é o BACKEND DECIDINDO (invariante 3 do `AGENTS.md`). Nenhum LLM
 * chega perto dele: a entrada é uma linha de `privacy_requests` já aprovada por
 * um humano, e a saída é um desfecho de vocabulário fechado com contagens.
 *
 * TRÊS REGRAS QUE MANDAM AQUI, na ordem em que mandam.
 *
 * 1. **`legal_holds` vence apagamento — bloqueando, não adiando.** A avaliação
 *    de hold é PRÉ-VOO: todas as classes são avaliadas ANTES de a primeira ser
 *    tocada. Um executor que avaliasse classe a classe apagaria metade dos
 *    dados do titular e só então descobriria o hold — e nenhuma das duas
 *    metades pode ser desfeita. Hold ativo ⇒ o pedido termina `denied` com
 *    `denied_reason_code='legal_hold'`, com a decisão auditada. `denied` é
 *    terminal de propósito: um pedido que ficasse "pendente até o hold cair"
 *    seria uma exclusão adiada em silêncio, que é exatamente o que o §11 proíbe.
 *
 * 2. **O tombstone é escrito ANTES da exclusão.** Esta é a decisão menos
 *    óbvia do arquivo, então: as duas ordens erram, e elas erram para lados de
 *    custo MUITO diferente. Tombstone depois da exclusão, com o processo
 *    morrendo no meio, deixa dado apagado SEM registro no ledger — e um
 *    restore posterior o ressuscita, sem ninguém para impedir. É a falha exata
 *    que o ledger existe para cobrir. Tombstone antes, com o processo morrendo
 *    no meio, deixa um tombstone para dado que ainda vive — e a reaplicação
 *    (`reapply.ts`) simplesmente apaga de novo, porque toda purga por sujeito é
 *    idempotente. Um exagera e se auto-corrige; o outro omite e não tem
 *    conserto. Escrevemos antes.
 *
 * 3. **Evidência é contagem e código, nunca conteúdo.** O que vai para
 *    `privacy_requests.evidence`, para `audit_logs` e para o log é o número de
 *    linhas por classe e códigos de vocabulário fechado. O identificador cru do
 *    titular existe dentro de `SubjectBinding` porque o adapter precisa dele
 *    para achar as linhas, e ele NÃO atravessa nenhuma dessas fronteiras.
 */
import { TypedError } from '@/lib/utils.js';
import type { AuditAction } from '@/governance/audit-actions.js';
import { evaluateHold, type HoldRecord } from '@/ops/retention/legal-hold.js';
import {
  signTombstone,
  type TombstoneAction,
  type TombstoneRecord,
} from '@/ops/retention/tombstones.js';
import {
  getDataClass,
  subjectScopedClasses,
  type DataClass,
} from '@/ops/retention/data-classes.js';
import {
  assertPrivacyTransition,
  type PrivacyRequestStatus,
  type PrivacyRequestType,
  type SubjectIdentifier,
} from './workflow.js';

/**
 * O sujeito, nas duas formas que este fluxo precisa ao mesmo tempo.
 *
 * `subject_ref` é o pseudônimo — é ele que vai para o ledger, para a avaliação
 * de hold e para qualquer evidência. `identifier` é o valor cru, e existe por
 * um motivo só: o pseudônimo é de mão única, então nenhum adapter consegue
 * achar as linhas do titular a partir dele. O valor cru fica confinado ao par
 * (executor → adapter) e é proibido em log, audit e evidence.
 */
export interface SubjectBinding {
  subject_ref: string;
  identifier: SubjectIdentifier;
}

export interface PrivacyScope {
  tenant_id: string;
  agent_id: string;
}

/** A linha de `privacy_requests`, reduzida ao que a execução precisa saber. */
export interface PrivacyRequestRecord {
  id: string;
  tenant_id: string;
  agent_id: string;
  type: PrivacyRequestType;
  status: PrivacyRequestStatus;
  identity_verified_by: string | null;
  approved_by: string | null;
}

export interface PurgeJob {
  scope: PrivacyScope;
  data_class: string;
  mechanism: Exclude<DataClass['purge_mechanism'], 'not_purgeable'>;
  subject: SubjectBinding;
}

export interface StageExportJob {
  scope: PrivacyScope;
  subject: SubjectBinding;
  data_classes: readonly string[];
}

export interface PrivacyPorts {
  /**
   * Holds do escopo. `null` significa "não deu para ler", NÃO "não há hold":
   * o executor falha fechado, porque prosseguir seria apagar sob um hold que
   * existe e não foi visto.
   */
  listHolds(scope: PrivacyScope): Promise<readonly HoldRecord[] | null>;
  /** Apaga/anonimiza/redige uma classe para um titular. Devolve linhas afetadas. */
  purge(job: PurgeJob): Promise<number>;
  /** Materializa o export EM CLARO num arquivo de staging. */
  stageExport(job: StageExportJob): Promise<{ path: string; rows: Record<string, number> }>;
  /**
   * Cifra o staging e devolve um locator OPACO. Obrigada a remover o texto em
   * claro — um export de titular em claro no disco é o mesmo vazamento que a
   * criptografia de backup existe para evitar.
   */
  sealExport(plaintextPath: string): Promise<{ locator: string; bytes: number; key_id: string }>;
  recordTombstone(t: TombstoneRecord): Promise<void>;
  updateRequest(id: string, patch: Record<string, unknown>): Promise<void>;
  audit(action: AuditAction, metadata: Record<string, unknown>): Promise<void>;
  now(): Date;
  newId(): string;
  tombstoneSecret(): string;
  /** Vida útil do export. Um export sem expiração é um vazamento com prazo infinito. */
  exportTtlMs: number;
  /**
   * Classes cujo mecanismo este adapter NÃO executa, mapeadas para o CÓDIGO do
   * motivo (`mechanism_not_implemented`, `pending_dpo_decision`, …).
   *
   * Existe para que "não implementado" seja uma EXCEÇÃO REGISTRADA no pedido e
   * não um `purge` que devolve zero. As duas produzem o mesmo desfecho técnico
   * e desfechos jurídicos opostos: a segunda faz o pedido se declarar cumprido
   * sem ter apagado nada, que é evidência de conformidade sem conformidade — a
   * pior saída possível deste módulo. Um adapter que ganhar o mecanismo depois
   * some da lista e a classe passa a ser purgada, sem mais nenhuma mudança.
   */
  unsupported: Readonly<Record<string, string>>;
}

export interface PrivacyExecutionResult {
  request_id: string;
  status: 'completed' | 'denied' | 'failed';
  /** Código fechado. `null` só em `completed`. */
  reason_code: string | null;
  /** Classes efetivamente tocadas (ou exportadas). */
  systems_covered: string[];
  /** Classes deliberadamente NÃO tocadas, com o motivo estrutural. */
  exceptions: { data_class: string; reason: string }[];
  /** Linhas por classe. Contagem, nunca conteúdo. */
  purged: Record<string, number>;
  tombstone_ids: string[];
  export_issued: boolean;
  hold_ids: string[];
}

/**
 * Ordem determinística de execução.
 *
 * Duas execuções do mesmo pedido tocam as mesmas classes na mesma sequência, o
 * que é o que torna uma execução interrompida legível: a evidência diz até
 * onde foi, e a ordem diz o que faltava.
 */
function classesForRequest(type: PrivacyRequestType): readonly DataClass[] {
  const all = [...subjectScopedClasses()].sort((a, b) => a.id.localeCompare(b.id));
  if (type === 'access_export') {
    // O ledger de tombstones é sobre o titular, mas é registro interno de
    // conformidade — exportá-lo devolveria ao titular a lista pseudonimizada
    // das próprias exclusões, sem valor para ele e com valor para quem quisesse
    // correlacionar o ledger. Fica de fora, e a exceção é registrada.
    return all.filter((c) => c.id !== 'privacy.tombstone' && c.id !== 'privacy.export');
  }
  return all;
}

function purgeAction(mechanism: DataClass['purge_mechanism']): TombstoneAction {
  // `not_purgeable` nunca chega aqui — as classes são separadas antes.
  return mechanism as TombstoneAction;
}

function assertExecutable(req: PrivacyRequestRecord): void {
  if (req.tenant_id === 'default' || req.agent_id === 'default') {
    throw new TypedError(
      'privacy_request_default_literal',
      'privacy execution refuses the legacy `default` sentinel',
      {},
    );
  }
  if (req.status !== 'approved') {
    // Não é "ainda não": é "este pedido não pode executar". A aprovação humana
    // é o que separa uma exclusão irreversível de um bug com permissão de escrita.
    throw new TypedError(
      'privacy_request_not_approved',
      `privacy execution requires status 'approved', got '${req.status}'`,
      { status: req.status },
    );
  }
  if (!req.approved_by || req.approved_by.trim().length === 0) {
    throw new TypedError(
      'privacy_request_unapproved_actor',
      'privacy execution requires a recorded approver',
      {},
    );
  }
  if (!req.identity_verified_by || req.identity_verified_by.trim().length === 0) {
    // Defesa em profundidade: a migration 102 já tem o CHECK. Um pedido que
    // chegasse aqui sem o carimbo executaria uma exclusão em nome de alguém
    // cuja identidade ninguém conferiu.
    throw new TypedError(
      'privacy_request_identity_unverified',
      'privacy execution requires a verified identity',
      {},
    );
  }
  if (req.type === 'rectification') {
    // Correção precisa do CONTEÚDO corrigido, que este executor não tem e não
    // deve inventar. Recusar explicitamente é melhor que uma implementação que
    // "completa" sem corrigir nada — ver runbook §9.
    throw new TypedError(
      'privacy_request_type_not_executable',
      'rectification is not executed by this engine',
      { type: req.type },
    );
  }
}

/**
 * Executa um pedido de privacidade aprovado, ponta a ponta.
 *
 * Nunca lança por um desfecho de NEGÓCIO (hold ativo, falha de purga): esses
 * viram `denied`/`failed` persistidos e auditados, porque um pedido que
 * terminasse com uma exceção não tratada ficaria eternamente `in_progress`.
 * Lança apenas por erro de PROGRAMAÇÃO/OPERAÇÃO (pedido não aprovado, escopo
 * `default`, tipo não executável) — aí não há desfecho a registrar, há um
 * chamador a consertar.
 */
export async function executePrivacyRequest(
  req: PrivacyRequestRecord,
  subject: SubjectBinding,
  ports: PrivacyPorts,
): Promise<PrivacyExecutionResult> {
  assertExecutable(req);

  const scope: PrivacyScope = { tenant_id: req.tenant_id, agent_id: req.agent_id };
  const base: PrivacyExecutionResult = {
    request_id: req.id,
    status: 'failed',
    reason_code: null,
    systems_covered: [],
    exceptions: [],
    purged: {},
    tombstone_ids: [],
    export_issued: false,
    hold_ids: [],
  };

  assertPrivacyTransition(req.status, 'in_progress');
  await ports.updateRequest(req.id, { status: 'in_progress', updated_at: ports.now() });

  const classes = classesForRequest(req.type);
  // Duas famílias de exceção, com motivos diferentes e ambos registrados: a
  // classe que é estruturalmente não-purgável (retenção contábil, o próprio
  // ledger) e a classe cujo mecanismo este adapter ainda não executa.
  const exceptions = classes
    .filter((c) => c.purge_mechanism === 'not_purgeable' || ports.unsupported[c.id] !== undefined)
    .map((c) => ({
      data_class: c.id,
      reason:
        c.purge_mechanism === 'not_purgeable'
          ? 'class_not_purgeable'
          : (ports.unsupported[c.id] ?? 'mechanism_not_implemented'),
    }));

  // ── 1. Hold: pré-voo sobre TODAS as classes, antes de tocar em qualquer uma.
  const holds = await ports.listHolds(scope);
  if (holds === null) {
    return finish(req, ports, {
      ...base,
      status: 'failed',
      reason_code: 'hold_unreadable',
      exceptions,
    });
  }

  const heldIds = new Set<string>();
  const heldClasses: string[] = [];
  const heldReasons = new Set<string>();
  for (const c of classes) {
    if (!c.legal_hold_applicable) continue;
    const verdict = evaluateHold(holds, {
      tenant_id: scope.tenant_id,
      agent_id: scope.agent_id,
      data_class: c.id,
      subject_ref: subject.subject_ref,
      at: ports.now(),
    });
    if (verdict.held) {
      heldClasses.push(c.id);
      for (const id of verdict.hold_ids) heldIds.add(id);
      for (const r of verdict.reason_codes) heldReasons.add(r);
    }
  }

  // O hold bloqueia até o EXPORT: entregar ao titular a cópia de um dado
  // congelado por processo judicial é a mesma divulgação que o hold congela.
  if (heldClasses.length > 0) {
    await ports.audit('legal_hold_blocked_purge', {
      privacy_request_id: req.id,
      data_classes: heldClasses.sort(),
      hold_ids: [...heldIds].sort(),
      reason_codes: [...heldReasons].sort(),
    });
    return finish(req, ports, {
      ...base,
      status: 'denied',
      reason_code: 'legal_hold',
      exceptions,
      hold_ids: [...heldIds].sort(),
    });
  }

  // ── 2a. Export cifrado.
  if (req.type === 'access_export') {
    const exportable = classes.filter(
      (c) => c.id !== 'privacy.tombstone' && ports.unsupported[c.id] === undefined,
    );
    let staged: { path: string; rows: Record<string, number> };
    try {
      staged = await ports.stageExport({
        scope,
        subject,
        data_classes: exportable.map((c) => c.id),
      });
    } catch (err) {
      return finish(req, ports, {
        ...base,
        status: 'failed',
        reason_code: codeOf(err, 'export_stage_failed'),
        exceptions,
      });
    }

    let sealed: { locator: string; bytes: number; key_id: string };
    try {
      sealed = await ports.sealExport(staged.path);
    } catch (err) {
      return finish(req, ports, {
        ...base,
        status: 'failed',
        reason_code: codeOf(err, 'export_seal_failed'),
        exceptions,
      });
    }

    const expires = new Date(ports.now().getTime() + ports.exportTtlMs);
    await ports.updateRequest(req.id, {
      export_locator: sealed.locator,
      export_expires_at: expires,
      updated_at: ports.now(),
    });

    return finish(req, ports, {
      ...base,
      status: 'completed',
      reason_code: null,
      systems_covered: exportable.map((c) => c.id),
      exceptions,
      purged: staged.rows,
      export_issued: true,
    });
  }

  // ── 2b. Exclusão / anonimização.
  const purgeable = classes.filter(
    (c) => c.purge_mechanism !== 'not_purgeable' && ports.unsupported[c.id] === undefined,
  );
  const purged: Record<string, number> = {};
  const tombstoneIds: string[] = [];
  const covered: string[] = [];

  for (const c of purgeable) {
    const action = purgeAction(c.purge_mechanism);
    const t: Omit<TombstoneRecord, 'hmac' | 'hmac_key_version'> = {
      id: ports.newId(),
      tenant_id: scope.tenant_id,
      agent_id: scope.agent_id,
      data_class: c.id,
      subject_ref: subject.subject_ref,
      resource_locator: null,
      action,
      effective_at: ports.now(),
      origin: 'privacy_request',
      version: 1,
    };
    const record: TombstoneRecord = {
      ...t,
      hmac: signTombstone(t, ports.tombstoneSecret()),
      hmac_key_version: 1,
    };

    try {
      // Ordem deliberada — ver o cabeçalho, regra 2.
      await ports.recordTombstone(record);
    } catch (err) {
      return finish(req, ports, {
        ...base,
        status: 'failed',
        reason_code: codeOf(err, 'tombstone_write_failed'),
        systems_covered: covered,
        exceptions,
        purged,
        tombstone_ids: tombstoneIds,
      });
    }
    tombstoneIds.push(record.id);

    try {
      purged[c.id] = await ports.purge({
        scope,
        data_class: c.id,
        mechanism: c.purge_mechanism as PurgeJob['mechanism'],
        subject,
      });
      covered.push(c.id);
    } catch (err) {
      // O tombstone já está no ledger e FICA: ele diz a verdade sobre a
      // intenção, e a reaplicação vai terminar o serviço. O pedido, porém, não
      // pode se declarar cumprido.
      return finish(req, ports, {
        ...base,
        status: 'failed',
        reason_code: codeOf(err, 'purge_failed'),
        systems_covered: covered,
        exceptions,
        purged,
        tombstone_ids: tombstoneIds,
      });
    }
  }

  return finish(req, ports, {
    ...base,
    status: 'completed',
    reason_code: null,
    systems_covered: covered,
    exceptions,
    purged,
    tombstone_ids: tombstoneIds,
  });
}

function codeOf(err: unknown, fallback: string): string {
  const code = (err as TypedError)?.code;
  // Só códigos conhecidos deste domínio são ecoados. Uma mensagem arbitrária
  // pode carregar a URL de conexão com senha — a mesma razão de
  // `drillFailureCode` não ecoar nada.
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : fallback;
}

/**
 * Persiste o desfecho e audita. Um único ponto de saída, para que nenhum
 * caminho consiga terminar sem deixar rastro.
 */
async function finish(
  req: PrivacyRequestRecord,
  ports: PrivacyPorts,
  result: PrivacyExecutionResult,
): Promise<PrivacyExecutionResult> {
  const at = ports.now();
  assertPrivacyTransition('in_progress', result.status);
  await ports.updateRequest(req.id, {
    status: result.status,
    completed_at: result.status === 'completed' ? at : null,
    denied_reason_code: result.status === 'completed' ? null : result.reason_code,
    systems_covered: result.systems_covered,
    exceptions: result.exceptions,
    evidence: {
      purged: result.purged,
      tombstones: result.tombstone_ids.length,
      export_issued: result.export_issued,
      hold_ids: result.hold_ids,
    },
    updated_at: at,
  });

  const action: AuditAction =
    result.status === 'completed'
      ? 'privacy_request_completed'
      : result.status === 'denied'
        ? 'privacy_request_denied'
        : 'privacy_request_failed';

  await ports.audit(action, {
    privacy_request_id: req.id,
    type: req.type,
    outcome: result.status,
    reason_code: result.reason_code,
    systems_covered: result.systems_covered,
    exceptions: result.exceptions.map((e) => e.data_class),
    // Contagens por classe. Nenhum conteúdo, nenhum identificador do titular.
    purged: result.purged,
    tombstones: result.tombstone_ids.length,
    export_issued: result.export_issued,
    hold_ids: result.hold_ids,
  });

  return result;
}

/** Reexportado para o adapter montar `PurgeJob` sem reimplementar o lookup. */
export { getDataClass };
