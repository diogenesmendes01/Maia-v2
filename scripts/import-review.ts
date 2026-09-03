/**
 * Spec 13 reconciliation UX (CLI). Depois que `npm run import:ofx` cria uma
 * `import_run` com `status='pending_review'`, este script lista, detalha e
 * aplica essas runs.
 *
 *   npm run import:list  -- --tenant=<id> --agent=<id>
 *   npm run import:show  -- --tenant=<id> --agent=<id> --run=<id>
 *   npm run import:apply -- --tenant=<id> --agent=<id> --run=<id>
 *                           [--candidates=accept|reject]
 *
 * ---------------------------------------------------------------------------
 * ISSUE #720 — este script era INALCANÇÁVEL (nenhuma run era criada, porque
 * `import:ofx` morria antes), e por isso o defeito abaixo nunca tinha sido
 * exercido. No minuto em que a ingestão voltou a funcionar ele passou a ser
 * alcançável, então os dois foram consertados juntos: consertar só o `ofx`
 * entregaria uma CLI que funciona e escreve sem escopo — pior do que estava.
 *
 * O QUE ESTAVA ERRADO AQUI:
 *
 *   1. `INSERT INTO transacoes` sem `tenant_id`/`agent_id`. Ambas NOT NULL sem
 *      default desde `migrations/083_drop_default_column_default.sql` → o
 *      apply morreria com SQLSTATE 23502 no primeiro lançamento novo.
 *   2. TODOS os `UPDATE` eram `WHERE id = $1`, sem predicado de escopo:
 *      `transacoes`, `import_entries` e `import_runs`. Num sistema
 *      multi-tenant esse é exatamente o defeito que #504/#571 existem para
 *      impedir — `import_entries.matched_transacao_id` é um uuid vindo de uma
 *      LINHA DE DADOS, e `transacoes.id` é PK GLOBAL (não escopada por
 *      tenant). Um ponteiro para a transação de outro tenant, gravado por
 *      qualquer caminho, faria este apply sobrescrever `status`,
 *      `data_pagamento`, `confirmada_em` e `metadata` DAQUELA linha.
 *   3. Nenhum caminho entrava em `runWithTenantContext` — `applyTenantGuard`
 *      é opt-in por chamador, não um interceptador global, então "está no
 *      schema" não protegia nada.
 *
 * O CONSERTO:
 *
 *   - `--tenant`/`--agent` obrigatórios, sem default (mesma decisão de desenho
 *     de `scripts/import-ofx.ts`, argumentada lá no topo do arquivo). Todo o
 *     trabalho roda dentro de `runWithTenantContext`.
 *   - TODA leitura pina `tenant_id`+`agent_id`. Uma run de outro tenant
 *     simplesmente "não existe" para esta CLI (fail-closed, e a mensagem não
 *     revela o dono real).
 *   - TODO `UPDATE` pina `id` **E** `tenant_id` **E** `agent_id`, com
 *     `.returning()` e contagem verificada.
 *   - `INSERT INTO transacoes` passa por `applyTenantGuard` — a tupla vem do
 *     ALS, e um `tenant_id` explícito divergente é rejeitado.
 *
 * POR QUE FAIL-LOUD (throw) EM VEZ DE PULAR, quando o UPDATE casa 0 linhas:
 * o mesmo raciocínio de `contasRepo.addToBalance`
 * (`src/db/repositories/finance-repos.ts`). O `WHERE id` sozinho SEMPRE casava;
 * 0 linhas sob o novo predicado só pode significar que a linha alvo não é do
 * escopo em execução — um ponteiro cross-tenant. Engolir isso deixaria a
 * `import_entry` marcada como resolvida com a transação NUNCA confirmada: a
 * run fecharia como `aplicado` mentindo sobre o que aplicou. O throw aborta a
 * transação inteira (`db.transaction`), então nada é escrito e a run continua
 * `pending_review` para o operador investigar.
 *
 * Provado por `tests/integration/import-cli-tenant-scope-real-db.spec.ts`
 * (Postgres real, CLI executada como processo filho) e pela sonda de forma
 * `tests/unit/scripts/import-cli-escrita-escopada.spec.ts`, que fica
 * VERMELHA se um `UPDATE ... WHERE id = $1` sem escopo for reintroduzido.
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
import { db } from '@/db/client.js';
import { import_runs, import_entries, transacoes } from '@/db/schema.js';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { audit } from '@/governance/audit.js';
import { applyTenantGuard } from '@/db/tenant-guard.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type { ImportEntry, ImportRun } from '@/db/schema.js';

export function arg(argv: string[], name: string): string | undefined {
  const flag = `--${name}=`;
  for (const a of argv) if (a.startsWith(flag)) return a.slice(flag.length);
  return undefined;
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** Ver `scripts/import-ofx.ts` — mesma forma, mesmo `code`, mesmo exit 2. */
export class RequiredArgsError extends Error {
  readonly code = 'MISSING_REQUIRED_ARGS';
  constructor(missing: string[]) {
    super(
      `import-review: faltam argumentos obrigatórios: ${missing.join(', ')}. ` +
        'uso: npm run import:list|import:show|import:apply -- --tenant=<id> --agent=<id> [--run=<id>]',
    );
    this.name = 'RequiredArgsError';
  }
}

/**
 * A run pedida não existe SOB O ESCOPO DECLARADO. Fail-closed e sem revelar o
 * dono real — a busca já foi feita escopada, então esta CLI nunca leu a linha
 * de outro tenant.
 */
export class RunNotInScopeError extends Error {
  readonly code = 'IMPORT_RUN_NOT_IN_SCOPE';
  constructor(run_id: string, tenant_id: string, agent_id: string) {
    super(
      `import-review: run "${run_id}" não existe sob o escopo declarado ` +
        `tenant_id=${tenant_id} agent_id=${agent_id} — recusando.`,
    );
    this.name = 'RunNotInScopeError';
  }
}

/**
 * Um UPDATE escopado casou um número de linhas diferente do esperado. Ver o
 * bloco "POR QUE FAIL-LOUD" no topo do arquivo: sob `WHERE id` sozinho isto
 * nunca acontecia, então só pode ser ponteiro para fora do escopo.
 */
export class CrossScopeWriteError extends Error {
  readonly code = 'IMPORT_CROSS_SCOPE_WRITE';
  constructor(what: string, id: string, matched: number, tenant_id: string, agent_id: string) {
    super(
      `import-review: UPDATE em ${what} id=${id} casou ${matched} linha(s) sob ` +
        `tenant_id=${tenant_id} agent_id=${agent_id} — esperava 1. A linha alvo não ` +
        'pertence ao escopo em execução (ponteiro cross-tenant). Abortando a ' +
        'transação inteira: nada foi aplicado e a run continua pending_review.',
    );
    this.name = 'CrossScopeWriteError';
  }
}

export interface Scope {
  tenant_id: string;
  agent_id: string;
}

/** `--tenant`/`--tenant_id` e `--agent`/`--agent_id`, sem default. */
export function parseScope(argv: string[]): Scope {
  const tenant_id = arg(argv, 'tenant_id') ?? arg(argv, 'tenant');
  const agent_id = arg(argv, 'agent_id') ?? arg(argv, 'agent');
  const missing: string[] = [];
  if (!tenant_id) missing.push('--tenant (ou --tenant_id)');
  if (!agent_id) missing.push('--agent (ou --agent_id)');
  if (missing.length > 0) throw new RequiredArgsError(missing);
  return { tenant_id: tenant_id as string, agent_id: agent_id as string };
}

/** Predicado de escopo reutilizado por TODA leitura/escrita de `import_runs`. */
function runScope(scope: Scope) {
  return and(eq(import_runs.tenant_id, scope.tenant_id), eq(import_runs.agent_id, scope.agent_id));
}

/** Idem para `import_entries`. */
function entryScope(scope: Scope) {
  return and(
    eq(import_entries.tenant_id, scope.tenant_id),
    eq(import_entries.agent_id, scope.agent_id),
  );
}

export async function listRuns(scope: Scope, log: (m: string) => void): Promise<ImportRun[]> {
  const rows = await db
    .select()
    .from(import_runs)
    .where(and(runScope(scope), eq(import_runs.status, 'pending_review')))
    .orderBy(import_runs.created_at);
  if (rows.length === 0) {
    log('no pending runs');
    return rows;
  }
  log('pending import runs:');
  for (const r of rows) {
    log(
      `  ${r.id}  ${r.fonte}  ${r.arquivo_nome ?? '?'}  total=${r.total_lancamentos} matched=${r.matched} cand=${r.candidates} new=${r.novos}`,
    );
  }
  return rows;
}

/** Leitura escopada da run — a única porta de entrada por id neste arquivo. */
async function loadRunInScope(scope: Scope, run_id: string): Promise<ImportRun> {
  const rows = await db
    .select()
    .from(import_runs)
    .where(and(eq(import_runs.id, run_id), runScope(scope)))
    .limit(1);
  const run = rows[0];
  if (!run) throw new RunNotInScopeError(run_id, scope.tenant_id, scope.agent_id);
  return run;
}

export async function showRun(
  scope: Scope,
  run_id: string,
  log: (m: string) => void,
): Promise<void> {
  const run = await loadRunInScope(scope, run_id);
  log(`run ${run.id} — status=${run.status}`);
  log(`  conta=${run.conta_id} entidade=${run.entidade_id}`);
  log(
    `  total=${run.total_lancamentos} matched=${run.matched} cand=${run.candidates} new=${run.novos}`,
  );
  const entries = await db
    .select()
    .from(import_entries)
    .where(and(eq(import_entries.import_run_id, run.id), entryScope(scope)))
    .orderBy(import_entries.ordem);
  log(`entries (${entries.length}):`);
  for (const e of entries) {
    const tag = e.status.padEnd(10);
    const sign = e.tipo_oper === 'credit' ? '+' : '-';
    log(
      `  #${String(e.ordem).padStart(3)} ${tag} ${e.data_oper} ${sign}R$ ${e.valor}  ${e.memo ?? e.contraparte_raw ?? ''}`,
    );
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ApplyTotals = {
  confirmed: number;
  created: number;
  candidatesSettled: number;
  skipped: number;
};

/**
 * Confirma uma `transacao` existente a partir de um lançamento do extrato.
 *
 * Per spec 13: sobrescreve `data_pagamento` com a data do banco, leva o status
 * ao valor terminal e funde o FITID no metadata para dedup futura.
 *
 * O WHERE pina `id` **E** `tenant_id` **E** `agent_id` (#720). `transacao_id`
 * vem de `import_entries.matched_transacao_id` — um uuid armazenado em uma
 * LINHA DE DADOS, apontando para uma PK GLOBAL. Sem os dois predicados de
 * escopo, um ponteiro para a transação de outro tenant sobrescreveria aquela
 * linha. `.returning()` + contagem verificada tornam a recusa observável em vez
 * de um no-op silencioso — ver "POR QUE FAIL-LOUD" no topo.
 */
async function applyMatchedTo(
  tx: Tx,
  scope: Scope,
  e: ImportEntry,
  transacao_id: string,
  run_id: string,
): Promise<void> {
  const status = e.tipo_oper === 'credit' ? 'recebida' : 'paga';
  const rows = await tx
    .update(transacoes)
    .set({
      data_pagamento: e.data_oper,
      status,
      confirmada_em: new Date(),
      updated_at: new Date(),
      metadata: sql`coalesce(${transacoes.metadata}, '{}'::jsonb) || ${JSON.stringify({
        fitid: e.fitid ?? null,
        import_run_id: run_id,
      })}::jsonb`,
    })
    .where(
      and(
        eq(transacoes.id, transacao_id),
        eq(transacoes.tenant_id, scope.tenant_id),
        eq(transacoes.agent_id, scope.agent_id),
      ),
    )
    .returning({ id: transacoes.id });
  if (rows.length !== 1) {
    throw new CrossScopeWriteError(
      'transacoes',
      transacao_id,
      rows.length,
      scope.tenant_id,
      scope.agent_id,
    );
  }
}

/** UPDATE escopado + fail-loud de uma `import_entry`. */
async function updateEntryInScope(
  tx: Tx,
  scope: Scope,
  entry_id: string,
  patch: Partial<typeof import_entries.$inferInsert>,
): Promise<void> {
  const rows = await tx
    .update(import_entries)
    .set(patch)
    .where(and(eq(import_entries.id, entry_id), entryScope(scope)))
    .returning({ id: import_entries.id });
  if (rows.length !== 1) {
    throw new CrossScopeWriteError(
      'import_entries',
      entry_id,
      rows.length,
      scope.tenant_id,
      scope.agent_id,
    );
  }
}

export async function applyRun(
  scope: Scope,
  run_id: string,
  candidatesPolicy: 'accept' | 'reject' | 'skip',
  log: (m: string) => void,
): Promise<ApplyTotals> {
  const run = await loadRunInScope(scope, run_id);
  if (run.status !== 'pending_review') {
    throw new Error(`import-review: run está ${run.status}, não dá para aplicar`);
  }

  // Wrap the entire apply in a single DB transaction so a partial failure
  // doesn't leave entries half-applied (e.g., a transacao inserted but
  // import_entries.resolved_at not set, which would cause the next run to
  // duplicate it). Desde #720 isso também é o que torna o fail-loud seguro:
  // um ponteiro cross-tenant aborta TUDO.
  const totals: ApplyTotals = await db.transaction(async (tx) => {
    const entries = await tx
      .select()
      .from(import_entries)
      .where(and(eq(import_entries.import_run_id, run.id), entryScope(scope)));

    const t: ApplyTotals = { confirmed: 0, created: 0, candidatesSettled: 0, skipped: 0 };

    for (const e of entries) {
      if (e.resolved_at) {
        t.skipped++;
        continue;
      }

      if (e.status === 'matched') {
        if (!e.matched_transacao_id) {
          // Inconsistent — matched without a transacao_id. Leave for review.
          t.skipped++;
          continue;
        }
        await applyMatchedTo(tx, scope, e, e.matched_transacao_id, run.id);
        await updateEntryInScope(tx, scope, e.id, { resolved_at: new Date() });
        t.confirmed++;
        continue;
      }

      if (e.status === 'new') {
        const status = e.tipo_oper === 'credit' ? 'recebida' : 'paga';
        const inserted = await tx
          .insert(transacoes)
          .values(
            // `applyTenantGuard` estampa a tupla do ALS (#720): antes o INSERT
            // omitia tenant_id/agent_id, ambas NOT NULL desde a migration 083.
            applyTenantGuard({
              entidade_id: run.entidade_id,
              conta_id: run.conta_id,
              natureza: e.tipo_oper === 'credit' ? 'receita' : 'despesa',
              valor: e.valor,
              data_competencia: e.data_oper,
              data_pagamento: e.data_oper,
              status,
              descricao: e.memo ?? e.contraparte_raw ?? 'extrato',
              contraparte: e.contraparte_raw,
              origem: 'extrato',
              registrado_por: run.pessoa_id,
              metadata: { import_run_id: run.id, fitid: e.fitid ?? null },
              confirmada_em: new Date(),
            }),
          )
          .returning({ id: transacoes.id });
        await updateEntryInScope(tx, scope, e.id, {
          resolved_at: new Date(),
          matched_transacao_id: inserted[0]!.id,
          status: 'matched',
        });
        t.created++;
        continue;
      }

      if (e.status === 'candidate') {
        if (candidatesPolicy === 'accept') {
          const top = (e.candidates as Array<{ transacao_id: string }> | null)?.[0];
          if (!top) {
            t.skipped++;
            continue;
          }
          await applyMatchedTo(tx, scope, e, top.transacao_id, run.id);
          await updateEntryInScope(tx, scope, e.id, {
            status: 'matched',
            matched_transacao_id: top.transacao_id,
            resolved_at: new Date(),
          });
          t.candidatesSettled++;
        } else if (candidatesPolicy === 'reject') {
          await updateEntryInScope(tx, scope, e.id, {
            status: 'rejected',
            resolved_at: new Date(),
          });
          t.candidatesSettled++;
        } else {
          t.skipped++;
        }
        continue;
      }

      // status='rejected' or unknown — already terminal, just count.
      t.skipped++;
    }

    // Run is `aplicado` only when *every* entry has resolved_at set —
    // not just when no candidates remain. A matched entry that failed to
    // apply (e.g., missing matched_transacao_id) must keep the run in
    // pending_review so the operator can fix it.
    const unresolved = await tx
      .select({ id: import_entries.id })
      .from(import_entries)
      .where(
        and(
          eq(import_entries.import_run_id, run.id),
          entryScope(scope),
          isNull(import_entries.resolved_at),
        ),
      );

    const newStatus = unresolved.length === 0 ? 'aplicado' : 'pending_review';
    const updatedRuns = await tx
      .update(import_runs)
      .set({ status: newStatus, updated_at: new Date() })
      .where(and(eq(import_runs.id, run.id), runScope(scope)))
      .returning({ id: import_runs.id });
    if (updatedRuns.length !== 1) {
      throw new CrossScopeWriteError(
        'import_runs',
        run.id,
        updatedRuns.length,
        scope.tenant_id,
        scope.agent_id,
      );
    }

    return t;
  });

  // Roda dentro de `runWithTenantContext` (ver `main`), então a row de auditoria
  // aterrissa no tenant certo em vez do bucket `system` — `audit()` só cai no
  // `system` quando NÃO há contexto ativo (`src/governance/audit.ts`).
  await audit({
    acao: 'transaction_created',
    pessoa_id: run.pessoa_id,
    alvo_id: run.id,
    metadata: {
      import_run: true,
      confirmed: totals.confirmed,
      created: totals.created,
      candidatesSettled: totals.candidatesSettled,
      skipped: totals.skipped,
    },
  });

  // Re-read final status for the log line — the transaction has committed.
  const after = await loadRunInScope(scope, run.id);
  log(
    `applied run ${run.id}: confirmed=${totals.confirmed} created=${totals.created} candidates=${totals.candidatesSettled} skipped=${totals.skipped} status=${after.status}`,
  );
  return totals;
}

function printUsage(extra?: string): void {
  if (extra) console.error(extra);
  console.error(
    'uso: npm run import:list  -- --tenant=<id> --agent=<id>\n' +
      '     npm run import:show  -- --tenant=<id> --agent=<id> --run=<id>\n' +
      '     npm run import:apply -- --tenant=<id> --agent=<id> --run=<id> [--candidates=accept|reject]',
  );
  console.error('  --tenant e --agent são obrigatórios e não têm default.');
  console.error('  Runs de outro escopo não são visíveis nem aplicáveis por esta CLI.');
}

async function main(): Promise<void> {
  const argv = process.argv;
  const cmd = argv[2];

  let scope: Scope;
  try {
    scope = parseScope(argv);
  } catch (err) {
    if (err instanceof RequiredArgsError) {
      printUsage(`erro: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const isList = cmd === 'list' || flag(argv, 'list');
  const isShow = cmd === 'show' || flag(argv, 'show');
  const isApply = cmd === 'apply' || flag(argv, 'apply');

  if (!isList && !isShow && !isApply) {
    printUsage('erro: comando desconhecido');
    process.exit(2);
    return;
  }

  let run_id: string | undefined;
  if (!isList) {
    run_id = arg(argv, 'run');
    if (!run_id) {
      printUsage('erro: --run=<id> é obrigatório para show/apply');
      process.exit(2);
      return;
    }
  }

  let policy: 'accept' | 'reject' | 'skip' = 'skip';
  if (isApply) {
    policy = (arg(argv, 'candidates') ?? 'skip') as 'accept' | 'reject' | 'skip';
    if (!['accept', 'reject', 'skip'].includes(policy)) {
      printUsage(`erro: --candidates inválido: ${policy}`);
      process.exit(2);
      return;
    }
  }

  try {
    await runWithTenantContext(scope, async () => {
      if (isList) return listRuns(scope, (m) => console.log(m));
      if (isShow) return showRun(scope, run_id as string, (m) => console.log(m));
      return applyRun(scope, run_id as string, policy, (m) => console.log(m));
    });
  } catch (err) {
    if (err instanceof RunNotInScopeError || err instanceof CrossScopeWriteError) {
      console.error(err.message);
      process.exit(3);
      return;
    }
    throw err;
  }
  process.exit(0);
}

/** Ver `scripts/import-ofx.ts` — um `import` de teste não pode disparar main(). */
export function isDirectInvocation(entry: string | undefined, metaUrl: string): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url) && !process.env.IMPORT_REVIEW_NO_MAIN) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
