/**
 * P8d §8 — Data migration: popula `priorities[]` em versões `active` existentes.
 *
 * Estratégia (preserva invariante append-only — master §15.4):
 *  1. Para cada (tenant, agent) com versão `active`, parsear `maia-prompt.md`
 *  2. Se `priorities` já populated → skip (idempotência)
 *  3. Senão, criar nova versão `proposed` com priorities populated
 *     (demais campos copiados, schema_version atualizado, previous_version_id
 *     aponta para a versão antiga)
 *  4. Transition antiga `active → frozen`
 *  5. Transition nova `proposed → active`
 *  6. Em caso de falha no activate, rollback: `frozen → active` da antiga
 *
 * Idempotente: re-rodar é seguro. Rodar manualmente após deploy
 * (dev → staging → prod, espaçar 24h).
 */
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/client.js';
import { PROFILE_BODY_SCHEMA_VERSION } from '@/db/schema.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { operationalProfileVersionsRepo, tenantsRepo } from '@/db/repositories.js';
import { parsePrioritiesFromMarkdown } from '@/identity/proposal-generator.js';
import type { ProfileBody } from '@/db/schema.js';

const PROMPT_PATH = 'src/identity/maia-prompt.md';

async function main(): Promise<void> {
  const tenants = await tenantsRepo.list();
  const promptText = await readFile(PROMPT_PATH, 'utf8');
  const parsed = parsePrioritiesFromMarkdown(promptText);

  if (parsed.length === 0) {
    logger.warn({}, 'p8d_migrate.no_priorities_inferable_global');
    return;
  }

  let seeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const t of tenants) {
    const rows = await db.execute<{ agent_id: string }>(sql`
      SELECT DISTINCT agent_id FROM agent_operational_profile_versions
       WHERE tenant_id = ${t.id} AND status = 'active'
    `);

    for (const row of rows.rows) {
      const agent_id = row.agent_id;
      try {
        await runWithTenantContext({ tenant_id: t.id, agent_id }, async () => {
          const active = await operationalProfileVersionsRepo.getActive();
          if (!active) {
            skipped++;
            return;
          }

          const body = (active.profile_body ?? {}) as Record<string, unknown>;
          const identity = (body.identity ?? {}) as Record<string, unknown>;
          const existing = Array.isArray(identity.priorities)
            ? (identity.priorities as unknown[]).filter((p) => typeof p === 'string')
            : [];
          if (existing.length > 0) {
            logger.info(
              { tenant: t.id, agent: agent_id },
              'p8d_migrate.already_populated_skip',
            );
            skipped++;
            return;
          }

          const newBody = {
            ...body,
            schema_version: PROFILE_BODY_SCHEMA_VERSION,
            identity: {
              ...identity,
              priorities: parsed,
              learned_voice_modifiers: Array.isArray(identity.learned_voice_modifiers)
                ? identity.learned_voice_modifiers
                : [],
            },
            metadata: {
              ...((body.metadata ?? {}) as Record<string, unknown>),
              effective_from: new Date().toISOString(),
              created_by: 'p8d_migration_priorities',
              previous_version_id: active.id,
            },
          } as unknown as ProfileBody;

          // Step 1: criar nova versão proposed
          const newVersion = await operationalProfileVersionsRepo.create({
            profile_body: newBody,
            proposed_by: 'p8d_migration_priorities',
            proposed_reason: `populate priorities[]: ${parsed.join(', ')}`,
          });

          // Step 2: freeze antiga
          const freezeR = await operationalProfileVersionsRepo.transition({
            id: active.id,
            to: 'frozen',
            approved_by: 'p8d_migration_priorities',
          });
          if (!freezeR.ok) throw new Error(`freeze_failed: ${freezeR.reason}`);

          // Step 3: ativar nova
          const activateR = await operationalProfileVersionsRepo.transition({
            id: newVersion.id,
            to: 'active',
            approved_by: 'p8d_migration_priorities',
          });
          if (!activateR.ok) {
            // Rollback: re-ativar a antiga (frozen → active permitido)
            await operationalProfileVersionsRepo.transition({
              id: active.id,
              to: 'active',
              approved_by: 'p8d_migration_priorities_rollback',
            });
            throw new Error(`activate_failed: ${activateR.reason}`);
          }

          logger.info(
            {
              tenant: t.id,
              agent: agent_id,
              old_v: active.version,
              new_v: newVersion.version,
              priorities: parsed,
            },
            'p8d_migrate.seeded',
          );
          seeded++;
        });
      } catch (err) {
        failed++;
        logger.error(
          { tenant: t.id, agent: agent_id, err: (err as Error).message },
          'p8d_migrate.failed',
        );
      }
    }
  }

  logger.info({ seeded, skipped, failed }, 'p8d_migrate.done');
}

void main().catch((err) => {
  logger.error({ err: (err as Error).message }, 'p8d_migrate.fatal');
  process.exitCode = 1;
});
