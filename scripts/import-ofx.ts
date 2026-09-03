/**
 * Ingestão de extrato (OFX/CSV) — CLI operacional.
 *
 *   npm run import:ofx -- --tenant=<id> --agent=<id> --pessoa=<id|apelido> \
 *                         --conta=<id|apelido> --file=extrato.ofx
 *
 * ---------------------------------------------------------------------------
 * ISSUE #720 — a CLI estava MORTA desde a migration 083, e o conserto trouxe
 * junto a decisão de desenho que faltava: DE ONDE vêm `tenant_id` e `agent_id`
 * num processo operacional que não tem turno de agente nem requisição HTTP.
 *
 * O QUE ESTAVA QUEBRADO (verificado contra Postgres real, migrations aplicadas):
 *
 *   1. `db.insert(import_runs).values({...})` não passava `tenant_id` nem
 *      `agent_id`. Ambas as colunas são NOT NULL sem default desde
 *      `migrations/083_drop_default_column_default.sql`, que removeu o
 *      `DEFAULT 'default'` de todas elas (issue #323). O insert morria com:
 *        ERROR: null value in column "tenant_id" of relation "import_runs"
 *               violates not-null constraint   (SQLSTATE 23502)
 *   2. Antes MESMO de chegar lá, com um arquivo que tem lançamentos, o script
 *      morria em `reconcile()` → `transacoesRepo.byScope()` →
 *      `getCurrentTenant()` com `MissingTenantContextError`: nenhum caminho
 *      desta CLI entrava em `runWithTenantContext`. (Com um extrato VAZIO o
 *      `reconcile` não itera e o primeiro erro é o (1) — os dois são reais, a
 *      ordem depende do arquivo.)
 *   3. `--pessoa` caía em `'system'` por default. `import_runs.pessoa_id` é
 *      `UUID NOT NULL REFERENCES pessoas(id)` (migrations/002 §172), então o
 *      default nunca poderia funcionar — era um terceiro caminho morto no
 *      mesmo insert.
 *
 * ---------------------------------------------------------------------------
 * A DECISÃO DE DESENHO: escopo DECLARADO, VERIFICADO contra o dono da linha
 *
 * Três caminhos eram possíveis para obter a tupla numa CLI:
 *
 *   (1) argumento obrigatório (`--tenant`/`--agent`), sem default;
 *   (2) derivar da conta/pessoa que a CLI já resolve;
 *   (3) variável de ambiente.
 *
 * Escolhemos **(1) verificado contra (2)**, e as duas metades são necessárias:
 *
 *   - **Só (1)** deixa o operador escrever no tenant errado: ele digita
 *     `--tenant=acme` e passa o id de uma conta da `beta`; o insert grava
 *     `tenant_id='acme'` numa linha cuja `conta_id` pertence à `beta`. O banco
 *     aceita (a FK é para `contas_bancarias(id)`, que é PK GLOBAL — não há
 *     nada no schema que amarre a conta ao tenant declarado). Resultado: uma
 *     run órfã, invisível para os dois tenants e visível para o errado.
 *   - **Só (2)** deixa o ARQUIVO escolher o tenant. Quem passa `--conta`
 *     escolhe implicitamente onde o dado aterrissa, e um id copiado errado
 *     escreve silenciosamente noutro lugar sem nada para conferir contra.
 *   - **(3)** foi descartado por um motivo adicional e duro: `src/config/validate.ts`
 *     REJEITA qualquer `MAIA_*`/`FEATURE_*` fora do contrato
 *     (`src/config/contract.ts`, verificado por `npm run config:check:drift`).
 *     Uma env var nova exigiria mexer no contrato para dar à CLI um default
 *     ambiente-dependente — exatamente o oposto de fail-closed. Ambiente é
 *     estado invisível no shell; um argumento fica no histórico do comando e
 *     no `ps`.
 *
 * Então: o operador DECLARA `--tenant`/`--agent` (sem default, faltou → exit 2)
 * e a CLI RESOLVE conta e pessoa **dentro do escopo declarado**. Se a conta ou
 * a pessoa não pertencem à tupla declarada, a CLI RECUSA e não escreve nada.
 *
 * COMO a recusa é implementada, e por que assim: o SELECT de `contas_bancarias`
 * e o de `pessoas` já carregam `tenant_id = $1 AND agent_id = $2` no WHERE.
 * Uma linha de outro tenant simplesmente não é retornada, e a CLI para com
 * `ScopeMismatchError`. A alternativa — ler sem escopo e comparar o
 * `tenant_id` da linha em memória — foi rejeitada: a própria verificação seria
 * uma leitura cross-tenant, e a mensagem de erro passaria a revelar ao
 * operador de um tenant a existência (e o dono) de uma conta de outro. A
 * verificação tem de ser fail-closed sem virar o vazamento que existe para
 * impedir.
 *
 * TODO caminho de escrita roda dentro de `runWithTenantContext`, e todo INSERT
 * passa por `applyTenantGuard` (`src/db/tenant-guard.ts`) — que estampa a tupla
 * do ALS e ainda rejeita um `tenant_id` explícito divergente. `applyTenantGuard`
 * é opt-in por chamador, não um interceptador global: "está no schema" não
 * protegia nada aqui.
 *
 * Provado por `tests/integration/import-cli-tenant-scope-real-db.spec.ts`
 * (Postgres real, CLI executada como processo filho — a prova é do binário,
 * não de um helper interno).
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
import { pathToFileURL } from 'node:url';
import { sha256 } from '@/lib/utils.js';
import { parseOFX } from '@/import/ofx-parser.js';
import { parseCSV } from '@/import/csv-parser.js';
import { reconcile } from '@/import/reconciler.js';
import { db } from '@/db/client.js';
import { contas_bancarias, pessoas, import_runs, import_entries } from '@/db/schema.js';
import { applyTenantGuard } from '@/db/tenant-guard.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { and, eq } from 'drizzle-orm';

export function arg(argv: string[], name: string): string | undefined {
  const flag = `--${name}=`;
  for (const a of argv) if (a.startsWith(flag)) return a.slice(flag.length);
  return undefined;
}

/**
 * Argumentos obrigatórios ausentes. Mesma forma de
 * `scripts/embeddings-rebuild.ts` (`RequiredArgsError`, `code` estável, exit 2
 * na entrada da CLI) — a CLI operacional anterior que passou pelo mesmo
 * conserto de escopo (issue #239).
 */
export class RequiredArgsError extends Error {
  readonly code = 'MISSING_REQUIRED_ARGS';
  constructor(missing: string[]) {
    super(
      `import-ofx: faltam argumentos obrigatórios: ${missing.join(', ')}. ` +
        'uso: npm run import:ofx -- --tenant=<id> --agent=<id> --pessoa=<id|apelido> ' +
        '--conta=<id|apelido> --file=extrato.ofx',
    );
    this.name = 'RequiredArgsError';
  }
}

/**
 * O escopo DECLARADO não é dono da linha resolvida (ou a linha não existe).
 *
 * Fail-closed: a CLI não escreve nada. A mensagem NÃO revela quem é o dono
 * real — a busca já foi feita sob o escopo declarado, então esta CLI nunca
 * chegou a ler a linha do outro tenant.
 */
export class ScopeMismatchError extends Error {
  readonly code = 'IMPORT_SCOPE_MISMATCH';
  constructor(
    readonly kind: 'conta' | 'pessoa',
    ref: string,
    tenant_id: string,
    agent_id: string,
  ) {
    super(
      `import-ofx: ${kind} "${ref}" não existe sob o escopo declarado ` +
        `tenant_id=${tenant_id} agent_id=${agent_id} — recusando a importação. ` +
        `Confira --tenant/--agent, ou passe uma ${kind} desse escopo.`,
    );
    this.name = 'ScopeMismatchError';
  }
}

export interface ImportArgs {
  tenant_id: string;
  agent_id: string;
  file: string;
  conta: string;
  pessoa: string;
}

/**
 * Aceita `--tenant`/`--tenant_id` e `--agent`/`--agent_id` como aliases, igual
 * a `scripts/embeddings-rebuild.ts` (`parseRequiredArgs`). NENHUM tem default:
 * ausente → `RequiredArgsError` → exit 2. `--pessoa` passou a ser obrigatório
 * também (antes caía em `'system'`, que nunca poderia satisfazer
 * `pessoa_id UUID NOT NULL REFERENCES pessoas(id)`).
 */
export function parseImportArgs(argv: string[]): ImportArgs {
  const tenant_id = arg(argv, 'tenant_id') ?? arg(argv, 'tenant');
  const agent_id = arg(argv, 'agent_id') ?? arg(argv, 'agent');
  const file = arg(argv, 'file');
  const conta = arg(argv, 'conta');
  const pessoa = arg(argv, 'pessoa');

  const missing: string[] = [];
  if (!tenant_id) missing.push('--tenant (ou --tenant_id)');
  if (!agent_id) missing.push('--agent (ou --agent_id)');
  if (!pessoa) missing.push('--pessoa');
  if (!conta) missing.push('--conta');
  if (!file) missing.push('--file');
  if (missing.length > 0) throw new RequiredArgsError(missing);

  return {
    tenant_id: tenant_id as string,
    agent_id: agent_id as string,
    file: file as string,
    conta: conta as string,
    pessoa: pessoa as string,
  };
}

export interface ImportResult {
  run_id: string;
  duplicate: boolean;
  total: number;
  matched: number;
  candidates: number;
  novos: number;
}

/**
 * Resolve a conta DENTRO do escopo já ativo no ALS.
 *
 * O SELECT pina `tenant_id`+`agent_id`; o casamento por `id` ou `apelido` é
 * feito em memória sobre esse conjunto já escopado, porque `id` é `uuid` e
 * comparar um `--conta=<apelido>` diretamente com a coluna uuid derrubaria a
 * query com erro de cast (`invalid input syntax for type uuid`) antes de
 * qualquer verificação de escopo. Escopar primeiro, casar depois: o custo é
 * uma leitura das contas DO PRÓPRIO tenant, e nenhuma linha de outro tenant
 * jamais entra no processo.
 */
async function resolveContaNoEscopo(
  tenant_id: string,
  agent_id: string,
  ref: string,
): Promise<typeof contas_bancarias.$inferSelect> {
  const rows = await db
    .select()
    .from(contas_bancarias)
    .where(
      and(eq(contas_bancarias.tenant_id, tenant_id), eq(contas_bancarias.agent_id, agent_id)),
    );
  const found = rows.find((c) => c.id === ref) ?? rows.find((c) => c.apelido === ref);
  if (!found) throw new ScopeMismatchError('conta', ref, tenant_id, agent_id);
  return found;
}

/** Mesmo contrato de `resolveContaNoEscopo`, para `pessoas` (id ou apelido). */
async function resolvePessoaNoEscopo(
  tenant_id: string,
  agent_id: string,
  ref: string,
): Promise<typeof pessoas.$inferSelect> {
  const rows = await db
    .select()
    .from(pessoas)
    .where(and(eq(pessoas.tenant_id, tenant_id), eq(pessoas.agent_id, agent_id)));
  const found = rows.find((p) => p.id === ref) ?? rows.find((p) => p.apelido === ref);
  if (!found) throw new ScopeMismatchError('pessoa', ref, tenant_id, agent_id);
  return found;
}

/**
 * Núcleo da ingestão. Exportado para que os testes dirijam o MESMO código que
 * a CLI executa (a spec de integração dirige o binário por processo filho; esta
 * assinatura existe para quem precisar do núcleo sem `process.exit`).
 *
 * TODO o corpo roda dentro de `runWithTenantContext` — inclusive `reconcile()`,
 * que chama `transacoesRepo.byScope` e portanto `getCurrentTenant()`.
 */
export async function importarExtrato(
  args: ImportArgs,
  log: (msg: string) => void = () => undefined,
): Promise<ImportResult> {
  const { tenant_id, agent_id } = args;
  const buf = await readFile(args.file);
  const text = buf.toString('utf8');
  const arquivo_sha256 = sha256(buf);

  return runWithTenantContext({ tenant_id, agent_id }, async () => {
    // Escopo DECLARADO verificado contra o dono da linha: os dois resolvers
    // buscam SÓ dentro da tupla declarada, então uma conta/pessoa de outro
    // tenant faz a CLI recusar antes de qualquer escrita.
    const contaRow = await resolveContaNoEscopo(tenant_id, agent_id, args.conta);
    const pessoaRow = await resolvePessoaNoEscopo(tenant_id, agent_id, args.pessoa);

    // Dedup do mesmo arquivo na mesma conta. Escopado: sem os predicados de
    // tupla, um sha256 igual em OUTRO tenant faria esta CLI reportar
    // "already imported" e a run daqui nunca seria criada — um vazamento de
    // existência e uma perda silenciosa de ingestão ao mesmo tempo.
    const existing = await db
      .select()
      .from(import_runs)
      .where(
        and(
          eq(import_runs.tenant_id, tenant_id),
          eq(import_runs.agent_id, agent_id),
          eq(import_runs.arquivo_sha256, arquivo_sha256),
          eq(import_runs.conta_id, contaRow.id),
        ),
      );
    const dup = existing[0];
    if (dup) {
      log(`already imported as run ${dup.id}, status=${dup.status}`);
      return {
        run_id: dup.id,
        duplicate: true,
        total: dup.total_lancamentos,
        matched: dup.matched,
        candidates: dup.candidates,
        novos: dup.novos,
      };
    }

    const isOfx = /<OFX/i.test(text);
    const parsed = isOfx ? parseOFX(text) : null;
    const csv = isOfx ? null : parseCSV(text);
    const entries = parsed?.entries ?? csv?.entries ?? [];
    const fonte = isOfx ? 'ofx' : 'csv';

    const recon = await reconcile({
      conta_id: contaRow.id,
      entidade_id: contaRow.entidade_id,
      pessoa_id: pessoaRow.id,
      entries,
    });

    const matched = recon.filter((r) => r.status === 'matched').length;
    const candidates = recon.filter((r) => r.status === 'candidate').length;
    const novos = recon.filter((r) => r.status === 'new').length;

    // `applyTenantGuard` estampa tenant_id/agent_id a partir do ALS — a mesma
    // fronteira que os repositories usam (`transacoesRepo.create`), em vez de
    // repetir a tupla à mão em cada `values()`.
    const inserted = await db
      .insert(import_runs)
      .values(
        applyTenantGuard({
          pessoa_id: pessoaRow.id,
          entidade_id: contaRow.entidade_id,
          conta_id: contaRow.id,
          fonte,
          arquivo_sha256,
          arquivo_nome: args.file,
          periodo_de: parsed?.periodo_de ?? null,
          periodo_ate: parsed?.periodo_ate ?? null,
          total_lancamentos: entries.length,
          matched,
          candidates,
          novos,
          status: 'pending_review',
          metadata: csv ? { csv_profile: csv.profile } : {},
        }),
      )
      .returning({ id: import_runs.id });
    const run_id = inserted[0]!.id;

    if (recon.length > 0) {
      await db.insert(import_entries).values(
        recon.map((r, i) =>
          applyTenantGuard({
            import_run_id: run_id,
            ordem: i + 1,
            tipo_oper: r.entry.tipo_oper,
            valor: r.entry.valor.toFixed(2),
            data_oper: r.entry.data_oper,
            fitid: r.entry.fitid ?? null,
            memo: r.entry.memo ?? null,
            contraparte_raw: r.entry.contraparte_raw ?? null,
            status: r.status,
            matched_transacao_id: r.matched?.transacao_id ?? null,
            candidates: r.candidates ?? null,
          }),
        ),
      );
    }

    log(
      `imported run=${run_id}: total=${entries.length}, matched=${matched}, candidates=${candidates}, new=${novos}`,
    );
    return { run_id, duplicate: false, total: entries.length, matched, candidates, novos };
  });
}

function printUsage(extra?: string): void {
  if (extra) console.error(extra);
  console.error(
    'uso: npm run import:ofx -- --tenant=<id> --agent=<id> --pessoa=<id|apelido> --conta=<id|apelido> --file=extrato.ofx',
  );
  console.error('  Obrigatórios: --tenant (ou --tenant_id), --agent (ou --agent_id),');
  console.error('                --pessoa, --conta, --file. Nenhum tem default.');
  console.error('  A conta e a pessoa são resolvidas DENTRO do escopo declarado;');
  console.error('  se não pertencerem a ele, a importação é recusada sem escrever nada.');
}

async function main(): Promise<void> {
  let args: ImportArgs;
  try {
    args = parseImportArgs(process.argv);
  } catch (err) {
    if (err instanceof RequiredArgsError) {
      printUsage(`erro: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  let result: ImportResult;
  try {
    result = await importarExtrato(args, (m) => console.log(m));
  } catch (err) {
    if (err instanceof ScopeMismatchError) {
      console.error(err.message);
      process.exit(3);
      return;
    }
    throw err;
  }

  if (!result.duplicate) {
    console.log('status: pending_review — abra o app e revise pelo WhatsApp');
  }
  process.exit(0);
}

/**
 * Só executa a CLI quando o arquivo é o entrypoint. Mesma checagem de
 * `scripts/embeddings-rebuild.ts` (`isDirectInvocation`), e pelo mesmo motivo:
 * um `import` vindo de um teste não pode disparar `main()` nem `process.exit`.
 */
export function isDirectInvocation(entry: string | undefined, metaUrl: string): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url) && !process.env.IMPORT_OFX_NO_MAIN) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
