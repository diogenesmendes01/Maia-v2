/**
 * Issue #503 §7 — backfill de `agent_turns` a partir do inbound histórico.
 *
 * Mapeamento (o único inferível com honestidade a partir da projeção legada):
 *   `processada_em IS NOT NULL` -> `completed` / `legacy_processed`,
 *                                  `completed_at = processada_em`;
 *   `processada_em IS NULL`     -> `received`, `next_attempt_at = now()`.
 *
 * Propriedades:
 *   - IDEMPOTENTE: a unique em `agent_turn_inputs.mensagem_id` e a unique em
 *     `agent_turns.representative_message_id` fazem uma segunda execução criar
 *     zero turnos. Rodar duas vezes é seguro.
 *   - RESUMÍVEL: cada lote é uma transação curta e o critério de seleção é
 *     "inbound sem turno" — matar o processo e recomeçar continua de onde parou.
 *   - EM LOTES: nunca abre transação longa sobre a tabela inteira.
 *   - CROSS-TENANT: varre par a par (tenant, agent), sem sentinel `'default'`.
 *
 * Limitações declaradas (issue § Riscos residuais): NÃO tenta reconstruir
 * agregações de debounce antigas (um turno por mensagem histórica) e NÃO
 * consegue inferir se uma resposta foi de fato entregue — daí o outcome
 * explícito `legacy_processed`, que nunca deve ser confundido com
 * `reply_delivered`.
 *
 * Uso:
 *   npm run backfill:turns              # lotes de 500, sem limite total
 *   npm run backfill:turns -- --batch=200 --max=10000 --dry-run
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

import { pathToFileURL } from 'node:url';
import { agentTurnsRepo } from '@/db/repositories.js';
import { shutdownDb } from '@/db/client.js';
import { logger } from '@/lib/logger.js';

export type BackfillOptions = {
  batchSize: number;
  /** Teto de turnos criados no total (0 = sem teto). */
  maxTotal: number;
  dryRun: boolean;
};

export function parseArgs(argv: readonly string[]): BackfillOptions {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const batch = Number(get('batch') ?? 500);
  const max = Number(get('max') ?? 0);
  return {
    batchSize: Number.isFinite(batch) && batch > 0 ? Math.min(batch, 5000) : 500,
    maxTotal: Number.isFinite(max) && max > 0 ? max : 0,
    dryRun: argv.includes('--dry-run'),
  };
}

export async function runBackfill(opts: BackfillOptions): Promise<{ created: number }> {
  const pairs = await agentTurnsRepo.listTenantAgentPairsPendingBackfill();
  if (pairs.length === 0) {
    logger.info('backfill_agent_turns.nothing_to_do');
    return { created: 0 };
  }

  const pendingTotal = pairs.reduce((acc, p) => acc + p.pending, 0);
  logger.info(
    { pairs: pairs.length, pending: pendingTotal, dry_run: opts.dryRun },
    'backfill_agent_turns.start',
  );
  if (opts.dryRun) return { created: 0 };

  let created = 0;
  for (const pair of pairs) {
    let pairCreated = 0;
    // Progresso por par. O laço para quando um lote não cria nada — ou o par
    // acabou, ou toda a fatia restante já tem turno (idempotência).
    for (;;) {
      if (opts.maxTotal > 0 && created >= opts.maxTotal) break;
      const remaining =
        opts.maxTotal > 0 ? Math.min(opts.batchSize, opts.maxTotal - created) : opts.batchSize;
      const batch = await agentTurnsRepo.backfillBatch({
        tenant_id: pair.tenant_id,
        agent_id: pair.agent_id,
        limit: remaining,
      });
      if (batch.created === 0) break;
      created += batch.created;
      pairCreated += batch.created;
      logger.info(
        {
          tenant_id: pair.tenant_id,
          agent_id: pair.agent_id,
          batch: batch.created,
          pair_created: pairCreated,
          total_created: created,
          pending: pair.pending,
        },
        'backfill_agent_turns.batch',
      );
    }
    if (opts.maxTotal > 0 && created >= opts.maxTotal) {
      logger.warn({ total_created: created }, 'backfill_agent_turns.max_reached_resume_later');
      break;
    }
  }

  logger.info({ total_created: created }, 'backfill_agent_turns.done');
  return { created };
}

/** Mesmo guard cross-platform de scripts/migrate.ts. */
export function isDirectInvocation(entry: string | undefined, metaUrl: string): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  runBackfill(parseArgs(process.argv.slice(2)))
    .then(async () => {
      await shutdownDb();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      logger.error({ err: (err as Error).message }, 'backfill_agent_turns.failed');
      await shutdownDb().catch(() => undefined);
      process.exit(1);
    });
}
