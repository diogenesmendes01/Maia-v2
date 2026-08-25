/**
 * Issue #520 — persistence for backup evidence (migration 101).
 *
 * Deliberately small: the runner in `src/ops/backup/service.ts` decides WHAT
 * to record; this module only writes it. Every row lands under the reserved
 * `system` sentinel (a `pg_dump` is DB-wide and has no owning tenant), which
 * migration 101 enforces with a CHECK — so a caller that somehow arrived under
 * a real tenant context is rejected by the database, not silently accepted.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, withTx } from '@/db/client.js';
import { audit, auditTx } from '@/governance/audit.js';
import {
  backup_manifests,
  backup_runs,
  data_tombstones,
  legal_holds,
  restore_drills,
  retention_runs,
} from '@/db/schema.js';
import type { DrillCandidate, RestoreDrillStore } from '@/ops/backup/drill.js';
import type { SignedManifest } from '@/ops/backup/manifest.js';
import type { RetentionCandidate } from '@/ops/backup/retention.js';
import type { BackupEvidenceStore, BackupTrigger } from '@/ops/backup/service.js';
import type { BackupState } from '@/ops/backup/state-machine.js';
import type { TombstoneRecord } from '@/ops/retention/tombstones.js';
import type { ExportBinding } from '@/ops/privacy/export-locator.js';
import type { ExpiredExportCandidate } from '@/ops/privacy/export-sweeper.js';

export const backupEvidenceStore: BackupEvidenceStore = {
  async createRun(row: {
    id: string;
    correlation_id: string;
    profile: string;
    trigger: BackupTrigger;
    state: BackupState;
  }): Promise<void> {
    await db.insert(backup_runs).values({
      id: row.id,
      correlation_id: row.correlation_id,
      profile: row.profile,
      trigger: row.trigger,
      state: row.state,
      // tenant_id/agent_id default to 'system' (migration 101 CHECK).
    });
  },

  async updateRun(id: string, patch: Record<string, unknown>): Promise<void> {
    await db
      .update(backup_runs)
      .set({ ...patch, updated_at: new Date() } as never)
      .where(eq(backup_runs.id, id));
  },

  async saveManifest(
    runId: string,
    signed: SignedManifest,
    manifestSha256: string,
  ): Promise<void> {
    await db.insert(backup_manifests).values({
      backup_run_id: runId,
      manifest_version: signed.manifest.manifest_version,
      manifest: signed.manifest,
      manifest_sha256: manifestSha256,
      signature: signed.signature,
      signature_alg: signed.signature_alg,
      signature_key_version: signed.signature_key_version,
    });
  },
};

/** A run that produced an artifact, whatever destination it ended up on. */
export interface ArtifactRunRow {
  backup_id: string;
  artifact_ref: string;
  state: RetentionCandidate['state'];
  destination_kind: 'local' | 's3';
  /** Remote expiry, from the policy at run time. */
  delete_after: Date | null;
  /** When the run finished — the base for the LOCAL expiry. */
  finished_at: Date | null;
  has_manifest: boolean;
}

/**
 * Every run that produced an artifact, keyed for retention (issue #520 §10).
 *
 * The join to `backup_manifests` is what makes `has_manifest` real: an artifact
 * with no signed manifest cannot be identified, so the planner refuses to
 * delete it. Selection is by EVIDENCE (state, expiry, manifest), never by file
 * mtime or `LastModified` — that was the round-1 P1 finding.
 *
 * ROUND-2 REVIEW FINDING: this used to filter by `destination_kind`, so the
 * LOCAL copy of a run that uploaded to S3 (`destination_kind='s3'`) was
 * invisible to the local pass and accumulated forever — disk, yes, but more
 * importantly data under a retention policy living outside the lifecycle this
 * issue promises to govern. The filter is gone; callers scope by destination.
 */
export async function listArtifactRuns(): Promise<ArtifactRunRow[]> {
  const rows = await db.execute<{
    backup_id: string;
    artifact_ref: string | null;
    state: string;
    destination_kind: string;
    delete_after: string | null;
    finished_at: string | null;
    has_manifest: boolean;
  }>(sql`
    SELECT r.id AS backup_id,
           r.artifact_ref,
           r.state,
           r.destination_kind,
           r.delete_after::text AS delete_after,
           r.finished_at::text AS finished_at,
           (m.id IS NOT NULL) AS has_manifest
      FROM ${backup_runs} r
      LEFT JOIN ${backup_manifests} m ON m.backup_run_id = r.id
     WHERE r.state <> 'deleted'
       AND r.artifact_ref IS NOT NULL
     ORDER BY r.delete_after ASC NULLS LAST
  `);
  return rows.rows.map((r) => ({
    backup_id: r.backup_id,
    artifact_ref: r.artifact_ref ?? '',
    state: r.state as RetentionCandidate['state'],
    destination_kind: r.destination_kind === 's3' ? 's3' : 'local',
    delete_after: r.delete_after ? new Date(r.delete_after) : null,
    finished_at: r.finished_at ? new Date(r.finished_at) : null,
    has_manifest: r.has_manifest === true,
  }));
}

/**
 * Is ANY legal hold active right now?
 *
 * A dump is a container of every tenant's data, so a hold anywhere freezes the
 * whole artifact. Returns `null` when the question could not be answered — the
 * caller FAILS the pass rather than treating "I could not check" as "no hold".
 */
export async function anyActiveLegalHold(
  at: Date,
): Promise<{ held: boolean; hold_ids: string[] } | null> {
  try {
    const res = await db.execute<{ id: string }>(sql`
      SELECT id FROM ${legal_holds}
       WHERE status = 'active'
         AND effective_from <= ${at}
         AND (effective_until IS NULL OR effective_until > ${at})
       LIMIT 50
    `);
    const ids = res.rows.map((r) => r.id);
    return { held: ids.length > 0, hold_ids: ids };
  } catch {
    return null;
  }
}

/**
 * Terminalize runs abandoned by a process that never came back.
 *
 * WHY THIS EXISTS (issue #512 interaction). `nightly_backup` and
 * `backup_retention` are ordinary cron jobs, so #512's shutdown sequence
 * already covers them: `runTick` refuses to start new work once draining, and
 * step 2 (`cron_workers`) awaits the in-flight tick. But the drain budget is
 * `SHUTDOWN_GRACE_MS` (25s default) while a dump may legitimately run for
 * `BACKUP_DUMP_TIMEOUT_MS` (1h default) — so a backup caught by SIGTERM is
 * reported as `pending`, the process exits, and its row stays non-terminal.
 * The single-active partial index then refuses EVERY future run.
 *
 * Rather than special-casing shutdown, this reclaims on the way IN, which also
 * covers SIGKILL, OOM and a hard crash — none of which get to run cleanup code.
 *
 * The cutoff is what makes it safe: a run is only abandoned once it is older
 * than any live run could possibly be (the dump stage is itself bounded), so a
 * genuinely-running backup is never stolen from under itself.
 */
export async function reclaimAbandonedRuns(olderThan: Date): Promise<string[]> {
  const res = await db.execute<{ id: string }>(sql`
    UPDATE ${backup_runs}
       SET state = 'failed',
           outcome = 'failed',
           outcome_reason = 'abandoned',
           error_code = 'abandoned',
           finished_at = now(),
           updated_at = now()
     WHERE state NOT IN ('completed', 'completed_degraded', 'failed', 'expired', 'deleted')
       AND started_at < ${olderThan}
    RETURNING id
  `);
  return res.rows.map((r) => r.id);
}

/** Move a run row to `deleted` once its artifact is confirmed gone. */
export async function markRunDeleted(backupId: string): Promise<void> {
  await db
    .update(backup_runs)
    .set({ state: 'deleted', updated_at: new Date() })
    .where(eq(backup_runs.id, backupId));
}

/** Persist the retention pass itself (the evidence that it ran, and how). */
export async function recordRetentionRun(row: {
  correlation_id: string;
  data_class: string;
  dry_run: boolean;
  policy_version: string;
  status: 'completed' | 'partial' | 'failed';
  scanned: number;
  eligible: number;
  deleted: number;
  skipped_held: number;
  failed: number;
  cursor_watermark: Date | null;
  error_code: string | null;
}): Promise<void> {
  await db.insert(retention_runs).values({
    // Backup artifacts are DB-wide; the reserved `system` sentinel is their
    // explicit home (migration 102 only forbids the legacy `default`).
    tenant_id: 'system',
    agent_id: 'system',
    correlation_id: row.correlation_id,
    data_class: row.data_class,
    dry_run: row.dry_run,
    policy_version: row.policy_version,
    status: row.status,
    scanned: row.scanned,
    eligible: row.eligible,
    deleted: row.deleted,
    skipped_held: row.skipped_held,
    failed: row.failed,
    cursor_watermark: row.cursor_watermark,
    error_code: row.error_code,
    finished_at: new Date(),
  });
}

/* ────────────────────────── restore drill (issue #536) ────────────────────── */

/**
 * The artifact a drill should exercise, selected BY EVIDENCE.
 *
 * The rules, and why each one is there:
 *
 *  - a candidate MUST carry a signed manifest (`INNER JOIN`). Without one there
 *    is nothing to bind the bytes to, and a drill that restored an
 *    unidentifiable file would prove nothing about the backup discipline;
 *  - an OFF-SITE candidate MUST have `remote_verified`. That flag means, since
 *    manifest v2, that a provider-computed checksum matched or the object was
 *    re-downloaded and re-hashed — never the uploader's own metadata stamp;
 *  - a LOCAL candidate MUST have `local_verified`, i.e. its catalog was read
 *    and its checksum computed. "The file exists" was the baseline's bar and is
 *    exactly what this issue exists to raise;
 *  - `state = 'deleted'` is excluded: retention already reaped those bytes.
 *
 * Ordering is by `finished_at DESC` — the NEWEST artifact, because a drill
 * proves the CURRENT recovery point, not a historical one.
 */
export async function selectDrillCandidate(
  source: 'local' | 'offsite',
): Promise<DrillCandidate | null> {
  const verifiedPredicate =
    source === 'offsite'
      ? sql`r.remote_verified = true AND r.destination_kind = 's3'`
      : sql`r.local_verified = true`;

  const res = await db.execute<{
    backup_id: string;
    artifact_ref: string | null;
    manifest: unknown;
    signature: string;
    signature_alg: string;
    signature_key_version: number;
  }>(sql`
    SELECT r.id AS backup_id,
           r.artifact_ref,
           m.manifest,
           m.signature,
           m.signature_alg,
           m.signature_key_version
      FROM ${backup_runs} r
      JOIN ${backup_manifests} m ON m.backup_run_id = r.id
     WHERE r.state IN ('completed', 'completed_degraded')
       AND r.artifact_ref IS NOT NULL
       AND ${verifiedPredicate}
     ORDER BY r.finished_at DESC
     LIMIT 1
  `);

  const row = res.rows[0];
  if (!row || !row.artifact_ref) return null;
  return {
    backup_id: row.backup_id,
    artifact_ref: row.artifact_ref,
    source,
    // Reassembled into the envelope shape `verifyManifest` expects. The drill
    // re-verifies the signature itself — this repository never asserts that a
    // manifest is valid, it only hands over what was stored.
    signed_manifest: {
      manifest: row.manifest,
      signature: row.signature,
      signature_alg: row.signature_alg,
      signature_key_version: row.signature_key_version,
    },
  };
}

export const restoreDrillStore: RestoreDrillStore = {
  async createDrill(row): Promise<void> {
    await db.insert(restore_drills).values({
      id: row.id,
      correlation_id: row.correlation_id,
      backup_run_id: row.backup_run_id,
      source: row.source,
      status: 'running',
      // tenant_id/agent_id default to 'system' (migration 101 CHECK).
    });
  },

  async finishDrill(id, patch): Promise<void> {
    await db
      .update(restore_drills)
      .set(patch as never)
      .where(eq(restore_drills.id, id));
  },
};

/**
 * Read the tombstone ledger for the drill's reconciliation dry run.
 *
 * `available: false` on ANY read failure — the caller must be able to tell an
 * unreadable ledger from an empty one, because the first blocks a restore and
 * the second does not (issue #520 round-1 P1, preserved here).
 *
 * DELIBERATELY UNBOUNDED BY TENANT: a `pg_dump` is a container of every
 * tenant's data, so the reconciliation that guards its restore has to see every
 * tenant's tombstones. The rows carry PSEUDONYMS only, so reading them all does
 * not disclose a single identifier.
 *
 * BOUNDED BY COUNT, and fail-closed at the bound. A silently truncated ledger
 * is the worst possible answer here: the missing rows are exactly the deletions
 * that would NOT be replayed, so a restore would resurrect them while the plan
 * reported `ok`. Hitting the cap therefore reports the ledger as UNREADABLE,
 * which blocks the restore and asks a human to reconcile in batches.
 */
export const TOMBSTONE_LEDGER_READ_LIMIT = 100_000;

export async function readTombstoneLedger(): Promise<{
  available: boolean;
  tombstones: TombstoneRecord[];
}> {
  try {
    const rows = await db
      .select()
      .from(data_tombstones)
      .orderBy(data_tombstones.effective_at)
      // +1 so the cap is DETECTED rather than silently reached.
      .limit(TOMBSTONE_LEDGER_READ_LIMIT + 1);
    if (rows.length > TOMBSTONE_LEDGER_READ_LIMIT) {
      return { available: false, tombstones: [] };
    }
    return {
      available: true,
      tombstones: rows.map((r) => ({
        id: r.id,
        tenant_id: r.tenant_id,
        agent_id: r.agent_id,
        data_class: r.data_class,
        subject_ref: r.subject_ref,
        resource_locator: r.resource_locator,
        action: r.action as TombstoneRecord['action'],
        effective_at: r.effective_at,
        origin: r.origin as TombstoneRecord['origin'],
        version: r.version,
        hmac: r.hmac,
        hmac_key_version: r.hmac_key_version,
      })),
    };
  } catch {
    return { available: false, tombstones: [] };
  }
}

/**
 * O `tombstone_watermark` do artefato que foi restaurado (issue #536 §3).
 *
 * `null` no retorno significa "não há watermark conhecido para este backup", e
 * `planReconciliation` bloqueia nesse caso — que é o certo: sem saber até onde
 * o snapshot já continha exclusões, não se sabe o que reaplicar.
 */
export async function readBackupWatermark(backupId: string): Promise<Date | null> {
  const res = await db.execute<{ tombstone_watermark: string | null }>(sql`
    SELECT tombstone_watermark FROM ${backup_runs} WHERE id = ${backupId}::uuid LIMIT 1
  `);
  const raw = res.rows[0]?.tombstone_watermark ?? null;
  return raw === null ? null : new Date(raw);
}

/** A linha de `privacy_requests` que o executor precisa, e nada além dela. */
export async function readPrivacyRequest(id: string): Promise<{
  id: string;
  tenant_id: string;
  agent_id: string;
  type: string;
  status: string;
  subject_ref: string;
  identity_verified_by: string | null;
  approved_by: string | null;
} | null> {
  const res = await db.execute<{
    id: string;
    tenant_id: string;
    agent_id: string;
    type: string;
    status: string;
    subject_ref: string;
    identity_verified_by: string | null;
    approved_by: string | null;
  }>(sql`
    SELECT id, tenant_id, agent_id, type, status, subject_ref,
           identity_verified_by, approved_by
      FROM privacy_requests WHERE id = ${id}::uuid LIMIT 1
  `);
  return res.rows[0] ?? null;
}

/* ──────────── TTL do export de privacidade (issue #536, migration 118) ─────────── */

/**
 * A fila do varredor: exports com locator vivo que ainda não foram varridos.
 *
 * ORDEM E TETO fazem parte do contrato. `ORDER BY export_expires_at ASC` faz o
 * passe atacar o artefato que está vencido há mais tempo (o de maior exposição)
 * primeiro, e o `LIMIT` impede que um passe segure o lock de varredura
 * indefinidamente num backlog grande — o restante sai no passe seguinte, que é
 * horário. Sem ordem determinística, dois passes concorrentes se pisariam nos
 * mesmos artefatos e o `cursor_watermark` do desfecho não significaria nada.
 *
 * O filtro é por EVIDÊNCIA da linha (locator presente, `export_purged_at`
 * nulo), nunca pelo que está no diretório — a inversão disso foi o achado P1 da
 * rodada 1 da #520 na retenção de artefatos, e o mesmo erro aqui apagaria um
 * `.enc` que nenhum pedido reivindica.
 */
export async function listExpiredExportArtifacts(
  now: Date,
  limit: number,
): Promise<ExpiredExportCandidate[]> {
  const res = await db.execute<{
    id: string;
    tenant_id: string;
    agent_id: string;
    subject_ref: string;
    export_locator: string;
    export_expires_at: string | null;
    export_purged_at: string | null;
  }>(sql`
    SELECT id, tenant_id, agent_id, subject_ref, export_locator,
           export_expires_at::text AS export_expires_at,
           export_purged_at::text AS export_purged_at
      FROM privacy_requests
     WHERE export_locator IS NOT NULL
       AND export_purged_at IS NULL
       AND export_expires_at IS NOT NULL
       AND export_expires_at <= ${now}
     ORDER BY export_expires_at ASC
     LIMIT ${limit}
  `);
  return res.rows.map((r) => ({
    request_id: r.id,
    tenant_id: r.tenant_id,
    agent_id: r.agent_id,
    subject_ref: r.subject_ref,
    locator: r.export_locator,
    expires_at: r.export_expires_at ? new Date(r.export_expires_at) : null,
    purged_at: r.export_purged_at ? new Date(r.export_purged_at) : null,
  }));
}

/**
 * A releitura do instante da remoção — o quarto eixo do guarda de path.
 *
 * Existe porque planejar e apagar não são o mesmo instante. Entre os dois a
 * linha pode ter mudado de locator (um export reemitido) ou sumido, e apagar o
 * arquivo do PLANO destruiria um artefato vivo enquanto o pedido acha que ele
 * existe. `assertLocatorBoundToRequest` compara os quatro campos; esta função
 * só os lê.
 */
export async function readExportBinding(requestId: string): Promise<ExportBinding | null> {
  const res = await db.execute<{
    id: string;
    tenant_id: string;
    agent_id: string;
    export_locator: string | null;
  }>(sql`
    SELECT id, tenant_id, agent_id, export_locator
      FROM privacy_requests WHERE id = ${requestId}::uuid LIMIT 1
  `);
  const row = res.rows[0];
  if (!row || row.export_locator === null) return null;
  return {
    request_id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    locator: row.export_locator,
  };
}

/**
 * Registra que um passe COMEÇOU neste pedido. Idempotente de propósito.
 *
 * Não é um lease e não autoriza nada: o `WHERE export_purged_at IS NULL` evita
 * reescrever um pedido já concluído, e um segundo passe sobre um pedido ainda
 * aberto simplesmente atualiza o carimbo. O que impede duas execuções
 * concorrentes é o advisory lock do job, não esta coluna — ela existe para que
 * um passe que caiu no meio seja VISÍVEL (started sem purged) em vez de ter que
 * ser deduzido de log.
 */
export async function claimExportPurge(requestId: string, at: Date): Promise<void> {
  await db.execute(sql`
    UPDATE privacy_requests
       SET export_purge_started_at = ${at}, updated_at = now()
     WHERE id = ${requestId}::uuid
       AND export_purged_at IS NULL
  `);
}

/**
 * Marca o pedido como varrido E audita a remoção, NA MESMA TRANSAÇÃO.
 *
 * É aqui que a idempotência do varredor se fecha. O `WHERE export_purged_at IS
 * NULL` torna a marcação uma transição de VENCEDOR ÚNICO, e a auditoria só
 * acontece dentro da transação que venceu: rodar duas vezes — em série ou em
 * paralelo — produz exatamente uma linha `privacy_export_purged`. Uma marcação
 * seguida de um `audit()` separado deixaria uma janela em que uma queda perde a
 * linha de auditoria de uma remoção que realmente aconteceu, e a auditoria é a
 * única coisa que sobra para provar o que o TTL fez.
 *
 * Devolve `false` quando outra execução já tinha marcado — o chamador NÃO conta
 * a remoção de novo.
 */
export async function finalizeExportPurge(record: {
  request_id: string;
  tenant_id: string;
  agent_id: string;
  locator: string;
  expires_at: Date | null;
  purged_at: Date;
  already_absent: boolean;
  correlation_id: string;
}): Promise<boolean> {
  return withTx(async (tx) => {
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE privacy_requests
         SET export_purged_at = ${record.purged_at}, updated_at = now()
       WHERE id = ${record.request_id}::uuid
         AND export_purged_at IS NULL
      RETURNING id
    `);
    if (updated.rows.length === 0) return false;

    await auditTx(tx, {
      acao: 'privacy_export_purged',
      alvo_id: record.request_id,
      entidade_alvo: 'privacy_request',
      metadata: {
        privacy_request_id: record.request_id,
        correlation_id: record.correlation_id,
        data_class: 'privacy.export',
        // Locator OPACO — é um identificador, nunca um caminho, nunca um dado
        // do titular. O caminho não entra: um log com o diretório de exports é
        // um mapa para quem quiser ir buscar os que ainda estão lá.
        export_locator: record.locator,
        export_expires_at: record.expires_at?.toISOString() ?? null,
        purged_at: record.purged_at.toISOString(),
        // Distingue a remoção efetiva da retomada de um passe que caiu depois
        // de apagar e antes de marcar. As duas concluem o TTL; só a primeira
        // destruiu bytes nesta execução.
        already_absent: record.already_absent,
        actor: 'privacy_export_sweeper',
      },
    });
    return true;
  });
}

/**
 * Audita uma RECUSA do guarda (ou uma remoção não confirmada). NADA foi
 * apagado, e o silêncio não é opção: um locator irreconhecível apontando para
 * fora da árvore de exports é o sinal de que uma linha do banco foi corrompida
 * ou plantada, e ele precisa chegar a alguém.
 */
export async function recordExportPurgeRefusal(record: {
  request_id: string;
  tenant_id: string;
  agent_id: string;
  locator: string;
  reason: string;
  correlation_id: string;
}): Promise<void> {
  await audit({
    acao: 'privacy_export_purge_refused',
    alvo_id: record.request_id,
    entidade_alvo: 'privacy_request',
    metadata: {
      privacy_request_id: record.request_id,
      correlation_id: record.correlation_id,
      data_class: 'privacy.export',
      reason: record.reason,
      // Truncado: um locator envenenado pode ser arbitrariamente longo, e o
      // que interessa ao operador é reconhecer a forma, não guardá-la inteira.
      export_locator_sample: record.locator.slice(0, 120),
      outcome: 'refused',
      actor: 'privacy_export_sweeper',
    },
  });
}

/**
 * A LEITURA do pedido do ponto de vista do artefato (issue #536).
 *
 * Devolve a linha crua; quem decide o que o leitor pode ver é
 * `readExportArtifact` (`src/ops/privacy/export-sweeper.ts`), que é puro e
 * testável. Sem esse par, um pedido varrido continuaria devolvendo
 * `export_locator` e apontando para um arquivo que não existe mais.
 */
export async function readPrivacyExportRow(requestId: string): Promise<{
  request_id: string;
  tenant_id: string;
  agent_id: string;
  export_locator: string | null;
  export_expires_at: Date | null;
  export_purged_at: Date | null;
} | null> {
  const res = await db.execute<{
    id: string;
    tenant_id: string;
    agent_id: string;
    export_locator: string | null;
    export_expires_at: string | null;
    export_purged_at: string | null;
  }>(sql`
    SELECT id, tenant_id, agent_id, export_locator,
           export_expires_at::text AS export_expires_at,
           export_purged_at::text AS export_purged_at
      FROM privacy_requests WHERE id = ${requestId}::uuid LIMIT 1
  `);
  const row = res.rows[0];
  if (!row) return null;
  return {
    request_id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    export_locator: row.export_locator,
    export_expires_at: row.export_expires_at ? new Date(row.export_expires_at) : null,
    export_purged_at: row.export_purged_at ? new Date(row.export_purged_at) : null,
  };
}

export interface ReadinessFacts {
  last_local_verified_at: Date | null;
  last_offsite_verified_at: Date | null;
  last_restore_drill_at: Date | null;
  last_restore_drill_result: 'passed' | 'failed' | null;
  last_restore_drill_duration_ms: number | null;
  /**
   * Teardown verdict of that same drill (issue #536). The SCHEDULER needs it:
   * a drill that could not prove it removed its decrypted copy of production
   * blocks the next one, because starting another would materialise a second
   * copy instead of proving anything. `null` when no drill has ever reached a
   * terminal state.
   */
  last_restore_drill_cleanup_status: 'clean' | 'unsafe' | 'unknown' | null;
  /**
   * Start time of the OLDEST drill that never reached a terminal state — the
   * `running` / `cleanup_status='unknown'` rows (issue #536, owner review of
   * #553). `null` when there is none.
   *
   * ADDITIVE on purpose: the four `last_restore_drill_*` fields above keep
   * meaning exactly what they meant (the newest TERMINAL drill), because
   * `rpo.ts` grades RPO/RTO from them and widening that query would have
   * changed what "the last drill" means for every consumer. This is a separate
   * question — "is there an execution whose teardown nobody ever proved?" — and
   * it gets a separate field.
   *
   * The OLDEST rather than the newest: with one live drill and one corpse, the
   * corpse is the row that matters, and it is the one whose age decides whether
   * this is normal operation or debris.
   */
  open_restore_drill_started_at: Date | null;
  consecutive_failures: number;
}

/**
 * Facts behind the RPO/RTO verdict (`src/ops/backup/rpo.ts`).
 *
 * "Verified" is the operative word in both age queries: a run that produced a
 * file but never proved its checksum is NOT a recovery point, so it is
 * excluded — this is the query that makes `backup_age_local` honest.
 */
export async function readReadinessFacts(): Promise<ReadinessFacts> {
  const [localRow] = await db
    .select({ at: backup_runs.finished_at })
    .from(backup_runs)
    .where(and(eq(backup_runs.local_verified, true)))
    .orderBy(desc(backup_runs.finished_at))
    .limit(1);

  const [offsiteRow] = await db
    .select({ at: backup_runs.remote_verified_at })
    .from(backup_runs)
    .where(and(eq(backup_runs.remote_verified, true)))
    .orderBy(desc(backup_runs.remote_verified_at))
    .limit(1);

  // ONE STATEMENT for both drill facts — issue #536, round 2 of the owner's
  // review of #553.
  //
  // These used to be two independent `SELECT`s, each in its own autocommit and
  // therefore each with its own snapshot. A drill terminalizing BETWEEN them
  // produced a state that never existed: the first query still returned the
  // OLD terminal row, the second no longer found the open row (it had just
  // become terminal), so the decisor saw neither the new verdict nor the
  // execution in flight. In the worst case the drill terminalized as
  // `cleanup_status='unsafe'` inside that window: the tick graded the previous
  // `clean` row, found it due, took the advisory lock the finished drill had
  // just released, and started another drill — materialising the second copy
  // of production this whole review exists to prevent.
  //
  // A single statement takes a SINGLE snapshot under READ COMMITTED, so the
  // two branches below cannot disagree about what has finished. A transaction
  // with REPEATABLE READ would also have worked and was rejected on cost: this
  // function is a cheap read on the `/metrics` scrape path and has consumers
  // beyond the scheduler, so paying for a transaction (and holding a snapshot
  // open across four statements) to fix an interleaving between two of them is
  // the wrong trade.
  //
  // `skipped` is excluded with the terminal states in the open branch:
  // `runRestoreDrill` returns it BEFORE creating a row (backups disabled), so a
  // skipped drill never staged a file nor created a database — there is nothing
  // of it left on the host.
  //
  // The `anchor` join guarantees exactly one result row even when both branches
  // are empty, so "no drills at all" reads as nulls rather than as no row.
  // `::text` on both timestamps, then `new Date(...)` below — the same shape
  // `listArtifactRuns` above uses. A raw `db.execute` does not get drizzle's
  // per-column parsers, so a `timestamptz` would arrive as a string and silently
  // fail an `instanceof Date` contract; casting makes that explicit at the
  // boundary instead of depending on the driver's default parser.
  const drills = await db.execute<{
    terminal_at: string | null;
    terminal_status: string | null;
    terminal_duration: number | null;
    terminal_cleanup: string | null;
    open_started_at: string | null;
  }>(sql`
    WITH terminal AS (
      SELECT finished_at, status, duration_ms, cleanup_status
        FROM ${restore_drills}
       WHERE status IN ('passed', 'failed')
       ORDER BY finished_at DESC
       LIMIT 1
    ),
    open_drill AS (
      SELECT started_at
        FROM ${restore_drills}
       WHERE status NOT IN ('passed', 'failed', 'skipped')
       ORDER BY started_at ASC
       LIMIT 1
    )
    SELECT t.finished_at::text    AS terminal_at,
           t.status              AS terminal_status,
           t.duration_ms         AS terminal_duration,
           t.cleanup_status      AS terminal_cleanup,
           o.started_at::text    AS open_started_at
      FROM (SELECT 1) AS anchor
      LEFT JOIN terminal   AS t ON true
      LEFT JOIN open_drill AS o ON true
  `);
  const drillRow = drills.rows[0];

  // Consecutive failures since the last non-failed terminal run.
  const failures = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n
    FROM (
      SELECT state
      FROM ${backup_runs}
      WHERE state IN ('completed', 'completed_degraded', 'failed')
      ORDER BY started_at DESC
      LIMIT 50
    ) recent
    WHERE state = 'failed'
      AND NOT EXISTS (
        SELECT 1 FROM ${backup_runs} ok
        WHERE ok.state IN ('completed', 'completed_degraded')
          AND ok.started_at > (
            SELECT min(started_at) FROM ${backup_runs} f WHERE f.state = 'failed'
          )
      )
  `);

  return {
    last_local_verified_at: localRow?.at ?? null,
    last_offsite_verified_at: offsiteRow?.at ?? null,
    last_restore_drill_at: drillRow?.terminal_at ? new Date(drillRow.terminal_at) : null,
    last_restore_drill_result:
      drillRow?.terminal_status === 'passed' || drillRow?.terminal_status === 'failed'
        ? (drillRow.terminal_status as 'passed' | 'failed')
        : null,
    last_restore_drill_duration_ms: drillRow?.terminal_duration ?? null,
    // Anything the column can hold that is not `clean` is treated as `unknown`
    // rather than being coerced to `clean`: an unrecognised teardown verdict is
    // a doubt, and a doubt about a decrypted copy of production is not a pass.
    last_restore_drill_cleanup_status:
      drillRow?.terminal_status == null
        ? null
        : drillRow.terminal_cleanup === 'clean' || drillRow.terminal_cleanup === 'unsafe'
          ? drillRow.terminal_cleanup
          : 'unknown',
    open_restore_drill_started_at: drillRow?.open_started_at
      ? new Date(drillRow.open_started_at)
      : null,
    consecutive_failures: Number(failures.rows[0]?.n ?? 0),
  };
}
