/**
 * P8d §8 — Data migration: popula `priorities[]` em versões `active` existentes.
 *
 * Estratégia (preserva invariante append-only — master §15.4):
 *  1. Para cada (tenant, agent) com versão `active`, parsear `maia-prompt.md`
 *  2. Se `priorities` já populated → skip (idempotência)
 *  3. Senão, chamar `seedNewActiveAtomic` que numa única transação:
 *     - lock FOR UPDATE na active atual
 *     - freeze antiga
 *     - insert nova como `active` direto
 *     Qualquer falha rola tudo back — old active row stays active.
 *
 * Review #100: o caminho antigo (create proposed → transition freeze →
 * transition active) podia deixar agente sem active row se o processo morresse
 * entre passos. `seedNewActiveAtomic` torna a sequência atômica por design.
 *
 * Idempotente: re-rodar é seguro. Rodar manualmente após deploy
 * (dev → staging → prod, espaçar 24h).
 *
 * Exit code:
 *  - 0 quando todos os agentes pular ou migrar com sucesso
 *  - 1 quando há ao menos uma falha por-agente (failed > 0). Crash global
 *    também resulta em exit 1 via process.exitCode.
 */
// Boot fail-closed do subset `runtime`, EXPLÍCITO (issue #596).
//
// Este processo já validava o contrato inteiro no boot — mas por acidente: ele
// alcançava `@/config/env.ts` de carona, por `@/lib/logger.js` ou
// `@/db/client.ts`. A #596 tirou o singleton daqueles módulos (eles são
// COMPARTILHADOS com o container do console, que não pode pagar o boot do
// `runtime`), e sem esta linha o script passaria a descobrir configuração
// inválida uma variável por vez, em runtime, em vez de reprovar de uma vez no
// início. `tests/unit/config/admin-import-boundary.spec.ts` fixa a lista dos
// processos que precisam dela.
import '@/config/env.js';

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

          // Review #100: atomic create-frozen-active in one tx with FOR UPDATE
          // lock. Replaces the legacy create→freeze→activate sequence which
          // had a 3-step window where a crash could leave the agent without
          // any active profile (old frozen, new still proposed).
          //
          // expected_current_active_id catches the rare race where another
          // writer (Admin UI, drift engine) promoted a different row to active
          // between getActive() above and the lock inside the tx.
          const { new_active: newVersion } =
            await operationalProfileVersionsRepo.seedNewActiveAtomic({
              profile_body: newBody,
              proposed_by: 'p8d_migration_priorities',
              proposed_reason: `populate priorities[]: ${parsed.join(', ')}`,
              expected_current_active_id: active.id,
            });

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

  // Review #100: partial failure must surface as nonzero exit so CI/runbook
  // detect "migration finished with errors" instead of silently succeeding.
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main().catch((err) => {
  logger.error({ err: (err as Error).message }, 'p8d_migrate.fatal');
  process.exitCode = 1;
});
