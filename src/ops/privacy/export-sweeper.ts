/**
 * Issue #536 §2 — o VARREDOR do artefato de export vencido.
 *
 * O QUE ISTO CONSERTA. `executePrivacyRequest` gravava `export_locator` e
 * `export_expires_at` e parava aí. O prazo existia no banco; o `.enc` continuava
 * no disco para sempre. Um pacote cifrado com o dado consolidado de um titular,
 * sem prazo real, é o mesmo vazamento com deadline infinito que a criptografia
 * de backup existe para evitar — só que este é mais fácil de esquecer, porque a
 * coluna dá a impressão de que alguém já cuidou disso.
 *
 * A decisão do dono: sete dias viram a POLÍTICA INICIAL (configurável, o DPO
 * ajusta depois) e o TTL passa a ser executado por este varredor.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IDEMPOTÊNCIA — e por que ela mora na ORDEM das operações.
 *
 * O varredor cruza duas coisas que não commitam juntas: um arquivo no disco e
 * uma linha no banco. Não existe transação sobre as duas, então a única
 * pergunta que importa é: QUAL ORDEM DEIXA O ESTADO INTERMEDIÁRIO LEGÍVEL?
 *
 *   marcar → apagar : uma queda no meio deixa o pedido dizendo "artefato
 *     removido" com o `.enc` vivo no disco. O pedido some da lista de
 *     candidatos (já está marcado), ninguém volta, e o arquivo fica órfão para
 *     sempre. A evidência mente na direção que importa.
 *
 *   apagar → marcar : uma queda no meio deixa o arquivo removido e o pedido
 *     ainda candidato. A execução seguinte reencontra o pedido, prova o
 *     caminho, chama a remoção sobre um arquivo ausente (`present: false`),
 *     confirma a ausência e marca. Um passe a mais, nenhum estado mentiroso.
 *
 * Escolhemos a segunda. Ela só é idempotente porque três coisas valem ao mesmo
 * tempo: ausência NÃO é falha (`proveExportArtifact` devolve `present: false`);
 * a remoção é `force` (ENOENT é sucesso); e a marcação é CONDICIONAL
 * (`export_purged_at IS NULL`), com a auditoria na MESMA transação da marcação.
 * É essa última parte que impede a auditoria duplicada: quem não ganhou a
 * transição não audita. Rodar duas vezes produz exatamente uma linha de
 * auditoria, e rodar duas vezes em paralelo também.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * LEGAL HOLD VENCE O TTL. Um hold ativo sobre o titular congela o artefato: a
 * cópia entregue sob aquele pedido é material responsivo tanto quanto a origem,
 * e destruí-la sob hold é a pior saída deste módulo. A avaliação é POR ESCOPO e
 * cobre `privacy.export` MAIS todas as classes que o pacote pode conter — um
 * hold sobre as mensagens do titular alcança o export que as empacotou. Não
 * conseguir LER os holds reprova o passe inteiro; "não sei se há hold" nunca
 * vira "não há hold".
 *
 * O varredor NÃO consulta `legal_hold_applicable` da classe para decidir se
 * avalia. Condicionar uma recusa destrutiva a um campo mutável de registro
 * significa que uma edição de um caractere desarma a proteção — a avaliação é
 * incondicional, e o campo serve à documentação.
 *
 * Puro + portas injetadas, como todo o resto de `src/ops/`: o planejador não
 * tem relógio nem IO, e os ramos adversariais (remoção que mente, hold
 * ilegível, locator envenenado, releitura divergente) são alcançáveis em teste
 * sem Postgres e sem disco.
 */
import { TypedError } from '@/lib/utils.js';
import { evaluateHold, type HoldRecord } from '@/ops/retention/legal-hold.js';
import { subjectScopedClasses } from '@/ops/retention/data-classes.js';
import {
  assertLocatorBoundToRequest,
  proveExportArtifact,
  UnsafeExportLocatorError,
  type ExportBinding,
  type ExportLocatorRefusal,
  type ExportPathProbe,
} from './export-locator.js';

/** A classe de dado do próprio artefato. */
export const EXPORT_DATA_CLASS = 'privacy.export';

/**
 * As classes cujo hold congela o artefato.
 *
 * `privacy.export` (o artefato em si) mais toda classe com escopo de titular —
 * o pacote empacota justamente essas. Um hold com `data_class='*'` é alcançado
 * por qualquer uma delas, porque `evaluateHold` já trata o curinga.
 */
export function holdClassesForExport(): readonly string[] {
  return [EXPORT_DATA_CLASS, ...subjectScopedClasses().map((c) => c.id)].filter(
    (id, i, all) => all.indexOf(id) === i,
  );
}

/** Uma linha de `privacy_requests` reduzida ao que a varredura precisa. */
export interface ExpiredExportCandidate {
  request_id: string;
  tenant_id: string;
  agent_id: string;
  /** Pseudônimo — é ele que a avaliação de hold usa. Nunca o identificador cru. */
  subject_ref: string;
  locator: string;
  expires_at: Date | null;
  purged_at: Date | null;
}

export type ExportKeepReason =
  | 'not_expired'
  | 'no_expiry_set'
  | 'already_purged'
  | 'legal_hold';

export type ExportSweepDecision =
  | { action: 'delete'; reason: 'expired' }
  | { action: 'keep'; reason: ExportKeepReason };

export interface PlannedExport {
  candidate: ExpiredExportCandidate;
  decision: ExportSweepDecision;
}

/**
 * Decide, artefato a artefato, SÓ a partir da evidência. PURA — sem relógio,
 * sem IO.
 *
 * `held` chega pronto porque o veredito de hold precisa ser tomado sob o lock
 * do passe, imediatamente antes da remoção — nunca lido de uma coluna que pode
 * estar minutos atrasada.
 */
export function planExportSweep(
  candidates: readonly ExpiredExportCandidate[],
  now: Date,
  held: (c: ExpiredExportCandidate) => boolean,
): PlannedExport[] {
  return candidates.map((candidate) => ({
    candidate,
    decision: decide(candidate, now, held(candidate)),
  }));
}

function decide(
  c: ExpiredExportCandidate,
  now: Date,
  held: boolean,
): ExportSweepDecision {
  // Já varrido. Não é erro: é a segunda execução encontrando o próprio
  // trabalho, e é ela que não pode duplicar auditoria.
  if (c.purged_at !== null) return { action: 'keep', reason: 'already_purged' };

  // Hold vence tudo enquanto está ativo (§11). Antes do prazo, de propósito:
  // o operador que lê a decisão precisa ver `legal_hold` e não `not_expired`
  // num artefato congelado que por acaso ainda está dentro da janela.
  if (held) return { action: 'keep', reason: 'legal_hold' };

  // O CHECK `privacy_requests_export_expiry_chk` (migration 102) proíbe locator
  // sem expiração, então isto é uma linha que não deveria existir. Ela NÃO é
  // apagada por precaução: um artefato sem prazo conhecido é um artefato cujo
  // prazo ninguém pode provar que venceu.
  if (c.expires_at === null) return { action: 'keep', reason: 'no_expiry_set' };

  if (c.expires_at.getTime() > now.getTime()) {
    return { action: 'keep', reason: 'not_expired' };
  }
  return { action: 'delete', reason: 'expired' };
}

export interface ExportSweepScope {
  tenant_id: string;
  agent_id: string;
}

export interface ExportPurgeRecord {
  request_id: string;
  tenant_id: string;
  agent_id: string;
  locator: string;
  expires_at: Date | null;
  purged_at: Date;
  /** `true` quando o arquivo já não estava lá (retomada de um passe caído). */
  already_absent: boolean;
  correlation_id: string;
}

export interface ExportRefusalRecord {
  request_id: string;
  tenant_id: string;
  agent_id: string;
  locator: string;
  reason: ExportLocatorRefusal | 'delete_unconfirmed' | 'delete_failed';
  correlation_id: string;
}

export interface ExportSweepPorts {
  now(): Date;
  /** Raiz da árvore de exports. UMA definição, compartilhada com quem escreve. */
  exportRoot(): string;
  /** Candidatos: locator presente, ainda não varrido. Ordem determinística. */
  listCandidates(limit: number): Promise<ExpiredExportCandidate[]>;
  /**
   * Holds ATIVOS do escopo. `null` significa "não deu para ler", NÃO "não há
   * hold" — e o passe reprova, porque prosseguir seria apagar sob um hold que
   * existe e não foi visto.
   */
  listHolds(scope: ExportSweepScope): Promise<readonly HoldRecord[] | null>;
  /** Releitura no instante da remoção — o quarto eixo do guarda. */
  readBinding(requestId: string): Promise<ExportBinding | null>;
  /** Registra que este pedido entrou em varredura. Idempotente. */
  claim(requestId: string, at: Date): Promise<void>;
  /** `lstat`/`realpath` — injetado para que symlink e hard link sejam testáveis. */
  probe: ExportPathProbe;
  /** Remove o arquivo. DEVE ser `force` (ausência é sucesso). */
  remove(path: string): Promise<void>;
  /** Prova que sumiu. "a remoção não lançou" não é evidência. */
  confirmRemoved(path: string): Promise<boolean>;
  /**
   * Marca o pedido como varrido E audita, NA MESMA TRANSAÇÃO.
   *
   * Devolve `false` quando outra execução já tinha marcado — e é esse `false`
   * que impede a auditoria duplicada. Um `markPurged` seguido de um `audit`
   * separado deixaria uma janela em que a queda perde a linha de auditoria de
   * uma remoção que aconteceu.
   */
  finalize(record: ExportPurgeRecord): Promise<boolean>;
  /** Audita uma RECUSA. Nada é apagado, e o silêncio não é opção. */
  recordRefusal(record: ExportRefusalRecord): Promise<void>;
  log(event: string, detail: Record<string, unknown>): void;
}

export interface ExportSweepOutcome {
  status: 'completed' | 'partial' | 'failed';
  scanned: number;
  eligible: number;
  purged: number;
  /** Removidos que já estavam ausentes — retomada, não anomalia. */
  already_absent: number;
  skipped_held: number;
  /** Locators recusados pelo guarda. Acionável pelo operador. */
  refused: number;
  failed: number;
  error_code: string | null;
  /** Vencimento do primeiro artefato NÃO processado — onde um passe retomado recomeça. */
  cursor_watermark: Date | null;
}

export interface ExportSweepOptions {
  dryRun: boolean;
  correlationId: string;
  /** Teto do passe. Um passe ilimitado seguraria o lock indefinidamente. */
  limit: number;
}

/**
 * Executa um passe de varredura.
 *
 * Contrato:
 *  - hold ilegível ABORTA o passe (`failed`), nunca vira "não há hold";
 *  - todo locator passa pelo guarda ANTES da remoção, e um locator recusado é
 *    auditado e contado, nunca apagado nem ignorado;
 *  - toda remoção é confirmada; uma não confirmada conta como falha;
 *  - qualquer falha rebaixa o desfecho — um passe que meio funcionou jamais
 *    audita `completed`;
 *  - `dryRun` conta sem tocar em nada.
 */
export async function runExportSweep(
  ports: ExportSweepPorts,
  options: ExportSweepOptions,
): Promise<ExportSweepOutcome> {
  const now = ports.now();
  const outcome: ExportSweepOutcome = {
    status: 'completed',
    scanned: 0,
    eligible: 0,
    purged: 0,
    already_absent: 0,
    skipped_held: 0,
    refused: 0,
    failed: 0,
    error_code: null,
    cursor_watermark: null,
  };

  let candidates: ExpiredExportCandidate[];
  try {
    candidates = await ports.listCandidates(options.limit);
  } catch (err) {
    ports.log('privacy.export_sweep_list_failed', { error: (err as Error).name });
    return { ...outcome, status: 'failed', error_code: 'candidate_listing_failed' };
  }
  outcome.scanned = candidates.length;
  if (candidates.length === 0) return outcome;

  // Holds UMA vez por escopo, sob o lock do chamador, antes de qualquer
  // remoção. Falhar aqui é fatal: seguir significaria apagar cego a holds.
  const holdsByScope = new Map<string, readonly HoldRecord[]>();
  for (const c of candidates) {
    const key = `${c.tenant_id}|${c.agent_id}`;
    if (holdsByScope.has(key)) continue;
    const holds = await ports
      .listHolds({ tenant_id: c.tenant_id, agent_id: c.agent_id })
      .catch(() => null);
    if (holds === null) {
      ports.log('privacy.export_sweep_hold_unavailable', {
        impact: 'refusing to delete while legal holds cannot be evaluated',
      });
      return { ...outcome, status: 'failed', error_code: 'legal_hold_unavailable' };
    }
    holdsByScope.set(key, holds);
  }

  const classes = holdClassesForExport();
  const heldIds = new Map<string, string[]>();
  const isHeld = (c: ExpiredExportCandidate): boolean => {
    const holds = holdsByScope.get(`${c.tenant_id}|${c.agent_id}`) ?? [];
    const ids = new Set<string>();
    for (const data_class of classes) {
      const verdict = evaluateHold(holds, {
        tenant_id: c.tenant_id,
        agent_id: c.agent_id,
        data_class,
        subject_ref: c.subject_ref,
        at: now,
      });
      for (const id of verdict.hold_ids) ids.add(id);
    }
    if (ids.size > 0) heldIds.set(c.request_id, [...ids].sort());
    return ids.size > 0;
  };

  const planned = planExportSweep(candidates, now, isHeld);
  outcome.skipped_held = planned.filter((p) => p.decision.reason === 'legal_hold').length;
  const toDelete = planned.filter((p) => p.decision.action === 'delete');
  outcome.eligible = toDelete.length;

  for (const p of planned) {
    if (p.decision.reason !== 'legal_hold') continue;
    ports.log('privacy.export_sweep_held', {
      request_id: p.candidate.request_id,
      // Ids do hold e nada mais: `reason_code` de hold pode ser sensível e o
      // §11 proíbe que ele chegue a um log.
      hold_ids: heldIds.get(p.candidate.request_id) ?? [],
    });
  }

  if (options.dryRun) {
    // Só contagens. É esta linha que o operador compara com a expectativa
    // antes de armar o executor pela primeira vez num ambiente.
    return outcome;
  }

  for (const { candidate } of toDelete) {
    try {
      await sweepOne(candidate, ports, options, outcome);
    } catch (err) {
      if (err instanceof UnsafeExportLocatorError) {
        // RECUSA — não é falha de infraestrutura, é o guarda funcionando. Vai
        // para a auditoria com o código, e o arquivo NÃO é tocado.
        outcome.refused += 1;
        outcome.cursor_watermark ??= candidate.expires_at;
        await ports
          .recordRefusal({
            request_id: candidate.request_id,
            tenant_id: candidate.tenant_id,
            agent_id: candidate.agent_id,
            locator: candidate.locator,
            reason: err.reason,
            correlation_id: options.correlationId,
          })
          .catch(() => undefined);
        ports.log('privacy.export_sweep_refused', {
          request_id: candidate.request_id,
          reason: err.reason,
        });
        continue;
      }
      outcome.failed += 1;
      outcome.cursor_watermark ??= candidate.expires_at;
      ports.log('privacy.export_sweep_failed', {
        request_id: candidate.request_id,
        error: (err as Error).name,
      });
    }
  }

  // Um passe que recusou ou falhou uma vez NUNCA é `completed`. Uma recusa é
  // tão conclusiva quanto uma falha para efeito de evidência: o artefato
  // continua no disco e alguém precisa olhar.
  if (outcome.failed > 0 || outcome.refused > 0) {
    outcome.status = outcome.purged > 0 ? 'partial' : 'failed';
    outcome.error_code = outcome.failed > 0 ? 'purge_failed' : 'locator_refused';
  }
  return outcome;
}

/**
 * Um artefato, na ordem que a idempotência exige.
 *
 * claim → releitura+guarda → remover → confirmar → marcar-e-auditar.
 *
 * A remoção só é ALCANÇADA depois que o guarda provou o caminho. É essa
 * propriedade que a sonda de segurança verifica: com a validação neutralizada,
 * um locator com traversal chega ao `remove`; com ela no lugar, `remove` nem é
 * chamado.
 */
async function sweepOne(
  candidate: ExpiredExportCandidate,
  ports: ExportSweepPorts,
  options: ExportSweepOptions,
  outcome: ExportSweepOutcome,
): Promise<void> {
  // O quarto eixo: o locator ainda é DESTE pedido? Entre planejar e apagar a
  // linha pode ter mudado, e apagar o arquivo do plano destruiria um artefato
  // vivo enquanto o pedido acha que ele existe.
  const fresh = await ports.readBinding(candidate.request_id);
  assertLocatorBoundToRequest(
    {
      request_id: candidate.request_id,
      tenant_id: candidate.tenant_id,
      agent_id: candidate.agent_id,
      locator: candidate.locator,
    },
    fresh,
  );

  const proven = await proveExportArtifact(
    ports.exportRoot(),
    candidate.locator,
    ports.probe,
  );

  // O claim vem DEPOIS do guarda, e isso importa para o diagnóstico. Ele
  // significa "estávamos prestes a remover", não "olhamos para este pedido".
  // Marcado antes, um locator RECUSADO deixaria `export_purge_started_at`
  // preenchido para sempre, e a consulta de plantão "algum passe começou e
  // nunca terminou?" — que existe para achar processo morto no meio —
  // devolveria também toda recusa, que é um diagnóstico completamente
  // diferente e já tem auditoria própria.
  await ports.claim(candidate.request_id, ports.now());

  if (proven.present) {
    await ports.remove(proven.path);
    if (!(await ports.confirmRemoved(proven.path))) {
      // A remoção disse que deu certo e o arquivo continua lá. Foi exatamente
      // esta forma de falha (delete que mente) que a retenção de artefatos
      // pegou na rodada 1 da #520. NÃO é recusa do guarda — é FALHA — mas
      // recebe a mesma linha de auditoria, porque o efeito para quem investiga
      // é o mesmo: o artefato continua no host.
      await ports
        .recordRefusal({
          request_id: candidate.request_id,
          tenant_id: candidate.tenant_id,
          agent_id: candidate.agent_id,
          locator: candidate.locator,
          reason: 'delete_unconfirmed',
          correlation_id: options.correlationId,
        })
        .catch(() => undefined);
      throw new TypedError(
        'export_delete_unconfirmed',
        'remove reported success but the export artifact is still present',
        { request_id: candidate.request_id },
      );
    }
  }

  const marked = await ports.finalize({
    request_id: candidate.request_id,
    tenant_id: candidate.tenant_id,
    agent_id: candidate.agent_id,
    locator: candidate.locator,
    expires_at: candidate.expires_at,
    purged_at: ports.now(),
    already_absent: !proven.present,
    correlation_id: options.correlationId,
  });

  if (!marked) {
    // Outra execução ganhou a transição e já auditou. Nada a contar aqui —
    // contar de novo seria a duplicação que a transação existe para impedir.
    ports.log('privacy.export_sweep_already_finalized', {
      request_id: candidate.request_id,
    });
    return;
  }

  outcome.purged += 1;
  if (!proven.present) outcome.already_absent += 1;
}

/* ───────────────────────── a LEITURA do pedido ───────────────────────── */

/**
 * O estado do artefato, do ponto de vista de quem LÊ o pedido.
 *
 * Sem isto, um pedido varrido continuaria devolvendo `export_locator` e
 * apontando para um arquivo que não existe mais — o operador iria buscá-lo,
 * não acharia, e não saberia se o artefato expirou ou se o sistema o perdeu.
 * São diagnósticos opostos.
 */
export type ExportArtifactState = 'none' | 'available' | 'expired' | 'purged';

export interface ExportArtifactRow {
  export_locator: string | null;
  export_expires_at: Date | null;
  export_purged_at: Date | null;
}

export interface ExportArtifactView {
  state: ExportArtifactState;
  /**
   * SÓ é devolvido em `available`.
   *
   * Um locator devolvido em `expired` seria um convite a buscar um arquivo que
   * a política já condenou — e, entre o vencimento e a passagem do varredor,
   * ele ainda EXISTE. Entregá-lo nessa janela furaria o próprio TTL.
   */
  locator: string | null;
  expires_at: Date | null;
  purged_at: Date | null;
}

export function readExportArtifact(row: ExportArtifactRow, now: Date): ExportArtifactView {
  const base = { expires_at: row.export_expires_at, purged_at: row.export_purged_at };
  if (row.export_purged_at !== null) {
    return { state: 'purged', locator: null, ...base };
  }
  if (row.export_locator === null) {
    return { state: 'none', locator: null, ...base };
  }
  // Locator sem prazo viola o CHECK da migration 102. Fail-closed: um artefato
  // cujo prazo ninguém consegue provar não é entregável.
  if (row.export_expires_at === null) {
    return { state: 'expired', locator: null, ...base };
  }
  if (row.export_expires_at.getTime() <= now.getTime()) {
    return { state: 'expired', locator: null, ...base };
  }
  return { state: 'available', locator: row.export_locator, ...base };
}
