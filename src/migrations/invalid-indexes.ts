/**
 * Issue #658 — a sonda de catálogo que torna um índice INVÁLIDO visível.
 *
 * ### O defeito que este módulo existe para fechar
 *
 * `CREATE UNIQUE INDEX CONCURRENTLY` que reprova (duplicata pré-existente,
 * deadlock, cancelamento) **não desaparece**: o índice fica no catálogo com
 * `pg_index.indisvalid = false`. Nada consulta o índice, nada é imposto por
 * ele — mas ele EXISTE. E `IF NOT EXISTS`, na tentativa seguinte, enxerga um
 * índice com aquele nome, pula a criação e devolve sucesso:
 *
 * ```
 * 1a tentativa:  ERROR: could not create unique index "t_k_uq"
 * catálogo:      t_k_uq | indisvalid = f
 * 2a tentativa:  NOTICE: relation "t_k_uq" already exists, skipping
 *                CREATE INDEX          ← exit 0
 * catálogo:      t_k_uq | indisvalid = f     ← continua inválido
 * ```
 *
 * O runner lê exit 0 e marca a migration como aplicada. Quando o índice é um
 * mecanismo de EXCLUSÃO (`agent_turns_stream_active_uq` e afins), o resultado é
 * a exclusão mútua não existir com o ledger dizendo "aplicada" — o modo de
 * falha exato que a épica #505 existe para eliminar.
 *
 * ### Escopo da varredura, e por que não é o banco inteiro
 *
 * A busca é limitada aos schemas que a CONEXÃO realmente resolve
 * (`current_schemas(false)` — o `search_path` explícito, sem o `pg_catalog`
 * implícito). É o mesmo escopo em que o runner resolve `schema_migrations` sem
 * qualificar, então "o schema que esta conexão está migrando" e "o schema onde
 * um índice inválido bloqueia" são o MESMO conjunto, por construção.
 *
 * A alternativa — varrer todo schema não-sistema do banco — trocaria um
 * falso-negativo improvável (uma migration que cria índice num schema fora do
 * `search_path`; nenhuma no repositório faz isso) por um falso-positivo real:
 * qualquer schema descartável de teste, de ferramenta externa ou de um banco
 * compartilhado passaria a bloquear o migrator e o boot de produção. O limite
 * está documentado no runbook (`docs/runbooks/migrations.md`).
 *
 * Uma única consulta somente-leitura ao catálogo, segura dentro de
 * `BEGIN READ ONLY` (é como o `maia doctor` a executa) e sem nenhum parâmetro
 * vindo de operador — não há o que injetar.
 */
import type { LedgerClient } from './ledger.js';
import type { InvalidIndex, SchemaBlocker } from './types.js';

/**
 * A consulta, exportada para que runbook, teste e produção citem UMA string em
 * vez de três que divergem.
 *
 * `indisvalid = false` é o predicado que importa: é o bit que o Postgres limpa
 * quando a construção concorrente reprova, e é o bit que faz o planejador
 * ignorar o índice. `indisready`/`indislive` vêm junto só como diagnóstico —
 * distinguem "build concorrente reprovou" (`indisready = false`) de
 * "`DROP INDEX CONCURRENTLY` interrompido" (`indislive = false`), que têm o
 * mesmo remédio mas histórias diferentes.
 */
export const INVALID_INDEX_QUERY = `
  SELECT n.nspname    AS schema_name,
         c.relname    AS index_name,
         t.relname    AS table_name,
         i.indisready AS is_ready,
         i.indislive  AS is_live
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT i.indisvalid
     AND n.nspname = ANY (current_schemas(false))
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   ORDER BY n.nspname, c.relname`;

interface InvalidIndexRow {
  readonly schema_name: string;
  readonly index_name: string;
  readonly table_name: string;
  readonly is_ready: boolean;
  readonly is_live: boolean;
}

/**
 * Todo índice inválido visível para esta conexão. READ-ONLY: uma consulta ao
 * catálogo, nada mais.
 *
 * Não engole erro: um catálogo ilegível é uma condição que o chamador precisa
 * ver. `getSchemaReadiness()` já converte qualquer exceção em `unknown`
 * (fail-closed), e o runner já trata a falha de leitura como falha do run.
 */
export async function readInvalidIndexes(client: LedgerClient): Promise<InvalidIndex[]> {
  const { rows } = await client.query<InvalidIndexRow>(INVALID_INDEX_QUERY);
  return rows.map((r) => ({
    schema: r.schema_name,
    index: r.index_name,
    table: r.table_name,
    ready: r.is_ready === true,
    live: r.is_live === true,
  }));
}

/** `schema.índice` — a identidade estável de um índice inválido. */
export function invalidIndexKey(index: InvalidIndex): string {
  return `${index.schema}.${index.index}`;
}

/**
 * Texto de operador para UM índice inválido. Nomeia o índice, a tabela e o
 * remédio. Nunca SQL de migration, nunca DSN, nunca mensagem de driver.
 */
export function describeInvalidIndex(index: InvalidIndex): string {
  const cause =
    index.live === false
      ? 'an interrupted `DROP INDEX CONCURRENTLY`'
      : 'a `CREATE INDEX CONCURRENTLY` that failed (duplicate rows, deadlock or cancellation)';
  return (
    `index "${invalidIndexKey(index)}" on table "${index.table}" is INVALID ` +
    `(pg_index.indisvalid = false), left behind by ${cause}. It enforces NOTHING, and ` +
    `\`CREATE INDEX CONCURRENTLY IF NOT EXISTS\` SKIPS it and reports success — so a migration ` +
    `that depends on it would be recorded as applied with the invariant missing. Remedy: ` +
    `\`DROP INDEX CONCURRENTLY ${invalidIndexKey(index)};\`, resolve the rows that made the build ` +
    `fail, then re-run the migrator (docs/runbooks/migrations.md §Índice inválido deixado por DDL CONCURRENTLY).`
  );
}

/**
 * UM blocker por índice inválido — a forma que o migrator e a readiness
 * compartilham, para que o operador leia o mesmo texto no `migrate up`, no
 * `/readyz`, no `maia doctor` e na mensagem de morte do boot.
 *
 * `SchemaBlocker.id` fica ausente de propósito: ele é contratado como "id da
 * MIGRATION culpada", e um índice inválido pode não ter migration culpada
 * nenhuma (um `CREATE INDEX CONCURRENTLY` rodado à mão deixa exatamente esse
 * estado). O nome do índice vai no `detail`, que é o campo de texto livre.
 */
export function invalidIndexBlockers(
  indexes: readonly InvalidIndex[],
): SchemaBlocker[] {
  return indexes.map((index) => ({
    kind: 'invalid_index' as const,
    detail: describeInvalidIndex(index),
  }));
}
