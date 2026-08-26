/**
 * O gate de schema do BOOT — issue #516, decisão do owner (ADR 0004).
 *
 * ### O que mudou
 *
 * Até aqui o passo `schema` de `src/index.ts` usava `checkSchemaVersion()`:
 * comparava o id mais novo do ledger com o arquivo mais novo em disco e nada
 * mais. Ele não enxergava checksum divergente, não enxergava `dirty` nem
 * `running` órfão, não enxergava uma migration que o banco aplicou e esta
 * build não empacota, e reportava "banco à frente do artefato" como `ok`.
 * Cada uma dessas condições é um schema que este processo não pode servir.
 *
 * Agora o boot consulta o **veredito canônico** (`getSchemaReadiness()`, via
 * `./schema-readiness.ts`) e DECIDE: qualquer veredito que não seja `ready`
 * encerra o processo com exit code != 0.
 *
 * ### Por que o crash loop é aceitável (e o que o impede)
 *
 * Produção greenfield não precisa preservar a postura intermediária ("uma
 * instância fora de rotação, com 503 auto-descritivo, mas inspecionável").
 * O que impede o processo de morrer no caminho normal é o **gate de
 * migration** (#516 §7 no Compose, #565 fora dele): as migrations são
 * aplicadas por um job one-shot ANTES de `app`/`admin-ui` subirem. Se o boot
 * do app ainda assim encontra um veredito negativo, uma invariante quebrou —
 * e o crash loop é o sinal, não o problema.
 *
 * O preço é que `/readyz` nunca chega a responder: o processo morre antes de
 * escutar. **Por isso a mensagem de morte é parte do contrato**, não um
 * detalhe de log. Um crash loop sem diagnóstico é pior que um 503. O
 * operador lê, nesta ordem: (1) o exit code do container, que já nomeia a
 * invariante; (2) a linha `maia.schema_boot_refused`, que nomeia a migration,
 * os dois checksums e o comando de remediação.
 *
 * ### Coerência com a ADR 0003
 *
 * A ADR 0003 mantém `/readyz` como o ÚNICO gate de roteamento role-aware e
 * fail-closed, e `/health` como diagnóstico. Nada disso muda: o veredito de
 * schema continua ligado ao `/readyz` exatamente como estava (uma instância
 * que já subiu e vê o schema mudar debaixo dela sai de rotação em 503). O que
 * este módulo acrescenta é o gate de BOOT, que responde a outra pergunta —
 * "posso existir?" em vez de "posso receber tráfego?". Os dois sinais são
 * complementares e a árvore de decisão está em
 * `docs/runbooks/operational.md` §8.1.
 *
 * ### Escopo
 *
 * PURO: sem I/O, sem `pg`, sem config, sem relógio. Recebe o veredito e
 * devolve a decisão. Quem faz I/O é `./schema-readiness.ts`; quem chama
 * `process.exit()` é `src/index.ts` — e só ele.
 *
 * Global, não escopado por tenant: DDL é global ao banco (ver
 * `src/migrations/types.ts`).
 */
import type { SchemaBlockerKind, SchemaReadiness } from '@/migrations/index.js';

/**
 * Exit codes do gate de schema — a PRIMEIRA coisa que um operador lê.
 *
 * A faixa 90-98 é escolhida para não colidir com nada que já signifique outra
 * coisa: `0`/`1`/`2` são os do migrator (`scripts/migrate.ts`) e o `1`
 * genérico de qualquer outra falha de boot; `SHUTDOWN_FORCED_EXIT_CODE` tem
 * default 1; o Node reserva 1-14 para seus próprios erros fatais; o shell usa
 * 126-165 (não executável, sinais) e 255. Um código dedicado por invariante
 * significa que `docker inspect --format '{{.State.ExitCode}}'` já responde
 * "qual invariante quebrou" antes de qualquer log ser lido.
 *
 * O `98` foi acrescentado pela #658 e estende a faixa em um degrau: reusar o
 * `90` (`dirty`) violaria a regra logo abaixo — a remediação de um índice
 * inválido é `DROP INDEX CONCURRENTLY` + resolver a duplicata, não
 * `migrate repair` —, e 98 continua fora de TODAS as faixas reservadas acima.
 *
 * Códigos IGUAIS para blockers diferentes só quando a remediação é a mesma
 * (`dirty_migration`/`orphaned_running` → repair auditável;
 * `schema_below_minimum`/`migration_failed` → rodar o migrator).
 *
 * | Código | Invariante quebrada | Remediação (resumo) |
 * |---|---|---|
 * | 90 | ledger `dirty` / `running` órfão — schema possivelmente parcial | inspeção + `migrate repair` |
 * | 91 | checksum divergente — migration aplicada foi editada | restaurar o arquivo / publicar a release certa |
 * | 92 | checksum ausente — aplicada por runner antigo, não verificável | `npm run db:migrate` (adota o checksum empacotado) |
 * | 93 | migration no banco que esta build NÃO empacota | publicar a release que a contém |
 * | 94 | migration obrigatória ausente — schema abaixo do mínimo | `npm run db:migrate` |
 * | 95 | schema acima do máximo suportado — build velha, banco novo | publicar a release nova |
 * | 96 | migration `running` — migrator em voo (ou morto) | aguardar o job; se não há migrator, é entulho |
 * | 97 | veredito `unknown` — ledger ausente/ilegível, banco fora do ar | `npm run doctor -- --online` |
 * | 98 | índice `indisvalid = false` — DDL `CONCURRENTLY` reprovou e a invariante de exclusão NÃO existe | `DROP INDEX CONCURRENTLY` + resolver a duplicata + reaplicar |
 */
export const SCHEMA_BOOT_EXIT_CODES = {
  dirty_migration: 90,
  orphaned_running: 90,
  checksum_mismatch: 91,
  checksum_unknown: 92,
  missing_file: 93,
  schema_below_minimum: 94,
  migration_failed: 94,
  schema_above_maximum: 95,
  running_migration: 96,
  ledger_missing: 97,
  ledger_unavailable: 97,
  invalid_index: 98,
  // Problemas de artefato não bloqueiam a readiness (descrevem o repositório,
  // não o schema no banco), então na prática não chegam aqui. Mapeado mesmo
  // assim: um `kind` sem código viraria um `undefined` no exit code.
  artifact_integrity: 97,
} as const satisfies Record<SchemaBlockerKind, number>;

/**
 * Ordem de PRECEDÊNCIA entre blockers simultâneos.
 *
 * Um veredito pode carregar vários blockers ao mesmo tempo (um `dirty` e três
 * `pending`, por exemplo). O exit code é UM só, então a ordem tem de ser
 * explícita e determinística — não "o primeiro que o loop encontrou".
 *
 * O critério é o custo de errar o diagnóstico: primeiro o que exige um humano
 * (schema possivelmente parcial, arquivo editado, banco com migration
 * desconhecida), por último o que se resolve rodando o migrator. Um operador
 * que vê 94 e roda o migrator está certo; um que visse 94 quando havia um
 * `dirty` rodaria o migrator contra um schema parcial.
 */
export const SCHEMA_BOOT_BLOCKER_PRECEDENCE: readonly SchemaBlockerKind[] = [
  // #658 vem ANTES do `dirty`: quando os dois aparecem juntos, o índice
  // inválido é a CAUSA e o `dirty` é a consequência. Um operador que lesse 90
  // primeiro repararia a linha do ledger e reaplicaria o arquivo — e o
  // `IF NOT EXISTS` devolveria sucesso sobre o índice ainda inválido, que é
  // precisamente o fail-open que esta invariante existe para fechar.
  'invalid_index',
  'dirty_migration',
  'orphaned_running',
  'checksum_mismatch',
  'missing_file',
  'schema_above_maximum',
  'running_migration',
  'checksum_unknown',
  'artifact_integrity',
  'schema_below_minimum',
  'migration_failed',
  'ledger_missing',
  'ledger_unavailable',
];

/**
 * Remediação por invariante. Texto de operador: o comando que ele deve rodar,
 * ou a decisão de deploy que ele deve tomar. Nunca SQL, nunca DSN.
 */
const REMEDIATION: Record<SchemaBlockerKind, string> = {
  invalid_index:
    'Um índice ficou com `pg_index.indisvalid = false`: a DDL `CONCURRENTLY` que o criaria reprovou e o índice inválido NÃO impõe nada — se ele é um índice único parcial, a exclusão mútua simplesmente não existe. NÃO reaplique a migration antes de removê-lo: o `IF NOT EXISTS` pularia a criação e devolveria sucesso. Ordem: `DROP INDEX CONCURRENTLY <schema>.<indice>;` (fora de transação), resolva as linhas que fizeram a construção reprovar, e só então `npm run db:migrate` (docs/runbooks/migrations.md §Índice inválido deixado por DDL CONCURRENTLY).',
  dirty_migration:
    'Inspecione o schema e repare com `tsx scripts/migrate.ts repair --id <migration.sql> --as applied|pending --reason "<motivo>"` (docs/runbooks/migrations.md §Recovery). NUNCA limpe a flag sem verificar o schema.',
  orphaned_running:
    'Nenhum migrator segura o lock: a linha é entulho de um run que morreu. `tsx scripts/migrate.ts status` e depois `repair --id <migration.sql> --as applied|pending --reason "<motivo>"`.',
  checksum_mismatch:
    'Uma migration aplicada foi editada, ou esta build empacota um arquivo diferente. Migrations são append-only (AGENTS.md §4.6): restaure o arquivo original ou publique a release que aplicou essa migration. Diagnóstico: `tsx scripts/migrate.ts status`.',
  checksum_unknown:
    'Rode `npm run db:migrate` para adotar o checksum empacotado (backfill único). Até lá o conteúdo aplicado é inverificável.',
  missing_file:
    'O banco aplicou uma migration que esta build não empacota — release velha contra banco novo. Publique a release que contém essa migration, ou reverta o banco pelo `_down` dela (docs/runbooks/migrations.md §Rollback).',
  schema_below_minimum:
    'Rode o gate de migration antes de subir o app: `npm run db:migrate` (ou `npm run release:migrate` no painel/pre-deploy). O app NUNCA aplica migration por conta própria.',
  migration_failed:
    'A migration transacional deu rollback limpo e é retentável: rode `npm run db:migrate`.',
  schema_above_maximum:
    'Uma release mais nova já migrou este banco. Não sirva tráfego desta build: publique a release nova (ou reverta o schema pelo runbook, com backup).',
  running_migration:
    'Há uma migration marcada como RUNNING: ou o job de migration está em voo (aguarde e deixe o supervisor reiniciar), ou ele morreu. Confirme com `tsx scripts/migrate.ts status`.',
  ledger_missing:
    '`schema_migrations` não existe ou não é legível: banco novo, sem migration nenhuma, ou permissão insuficiente. Rode `npm run db:migrate` e confirme o usuário do banco.',
  ledger_unavailable:
    'O estado do schema não pôde ser determinado (banco fora do ar, timeout, permissão). Diagnóstico: `npm run doctor -- --online`.',
  artifact_integrity:
    'O artefato empacotado está inconsistente (migration sem `_down`, prefixo malformado, envelope de transação inverificável). Corrija o repositório e reconstrua a imagem.',
};

/** Uma decisão de recusa de boot, pronta para log estruturado e para o exit. */
export interface SchemaBootFailure {
  /** Exit code que o processo DEVE adotar. Sempre != 0. */
  readonly exit_code: number;
  /** Invariante quebrada — a chave de `SCHEMA_BOOT_EXIT_CODES`. */
  readonly kind: SchemaBlockerKind;
  /** `ready` nunca chega aqui; `blocked` vs `unknown` muda o tom da mensagem. */
  readonly state: 'blocked' | 'unknown';
  /** Migration culpada, quando o blocker é atribuível a uma. */
  readonly migration_id: string | null;
  /** Checksum do ARQUIVO empacotado nesta build (`null` se não empacotado). */
  readonly expected_checksum: string | null;
  /** Checksum registrado no LEDGER (`null` se nunca registrado). */
  readonly found_checksum: string | null;
  readonly expected_head: string | null;
  readonly applied_head: string | null;
  /** Todos os kinds presentes, para o operador saber que há mais de um. */
  readonly blocker_kinds: readonly SchemaBlockerKind[];
  readonly remediation: string;
  /** Texto do blocker, literal nosso — nunca SQL, driver ou DSN. */
  readonly detail: string;
  /** Mensagem multi-linha, acionável, que vai para o log e para o erro. */
  readonly message: string;
}

/**
 * O veredito vira uma decisão de boot — ou `null` quando o schema está
 * verificadamente compatível.
 *
 * FAIL-CLOSED em duas camadas: `ready !== true` já recusa (não confia só na
 * presença de blockers), e um veredito sem blocker nenhum ainda produz uma
 * recusa `ledger_unavailable` em vez de deixar o boot seguir por omissão.
 */
export function describeSchemaBootFailure(verdict: SchemaReadiness): SchemaBootFailure | null {
  if (verdict.ready && verdict.state === 'ready') return null;

  const kinds = verdict.blockers.map((b) => b.kind);
  const chosenKind =
    SCHEMA_BOOT_BLOCKER_PRECEDENCE.find((k) => kinds.includes(k)) ??
    // Sem blocker nomeado, o veredito ainda não é `ready`: trate como estado
    // indeterminado. Um `else` que deixasse passar seria o fallback silencioso
    // que a AGENTS.md §4.2 proíbe.
    'ledger_unavailable';
  const blocker = verdict.blockers.find((b) => b.kind === chosenKind);
  const id = blocker?.id ?? null;
  const entry = id === null ? undefined : verdict.status?.entries.find((e) => e.id === id);

  const failure = {
    exit_code: SCHEMA_BOOT_EXIT_CODES[chosenKind],
    kind: chosenKind,
    state: verdict.state === 'unknown' ? ('unknown' as const) : ('blocked' as const),
    migration_id: id,
    expected_checksum: entry?.checksum ?? null,
    found_checksum: entry?.ledger_checksum ?? null,
    expected_head: verdict.expected_head,
    applied_head: verdict.applied_head,
    blocker_kinds: [...new Set(kinds)],
    remediation: REMEDIATION[chosenKind],
    detail: blocker?.detail ?? verdict.reason ?? 'schema state unavailable',
  };
  return { ...failure, message: renderSchemaBootFailure(failure) };
}

/**
 * A mensagem de morte.
 *
 * Ela existe porque o processo NÃO vai responder `/readyz`: um crash loop sem
 * diagnóstico obriga o operador a reproduzir a falha para saber o que houve.
 * Tudo o que ele precisa está aqui — a invariante, a migration, os dois
 * checksums, os dois heads e o comando.
 */
function renderSchemaBootFailure(f: Omit<SchemaBootFailure, 'message'>): string {
  const lines = [
    `SCHEMA BOOT REFUSED — exit ${f.exit_code} (${f.kind}, verdict ${f.state})`,
    `  detail:      ${f.detail}`,
  ];
  if (f.migration_id) lines.push(`  migration:   ${f.migration_id}`);
  if (f.expected_checksum !== null || f.found_checksum !== null) {
    lines.push(`  checksum expected (packaged file): ${f.expected_checksum ?? 'none'}`);
    lines.push(`  checksum found    (ledger row):    ${f.found_checksum ?? 'none'}`);
  }
  lines.push(`  expected head: ${f.expected_head ?? 'none'} · applied head: ${f.applied_head ?? 'none'}`);
  if (f.blocker_kinds.length > 1) {
    lines.push(`  other blockers: ${f.blocker_kinds.filter((k) => k !== f.kind).join(', ')}`);
  }
  lines.push(`  remediation: ${f.remediation}`);
  lines.push(
    '  NOTE: this process exits before HTTP starts, so /readyz never answers. The exit code above IS the signal — see docs/runbooks/operational.md §8.1.',
  );
  return lines.join('\n');
}

/**
 * Erro terminal do gate. Carrega o exit code para que o handler de `main()`
 * não precise reclassificar nada — reclassificar seria a segunda cópia da
 * regra, e a segunda cópia é a que envelhece.
 */
export class SchemaBootAbortError extends Error {
  readonly code = 'SCHEMA_BOOT_REFUSED';
  readonly exitCode: number;
  readonly failure: SchemaBootFailure;

  constructor(failure: SchemaBootFailure) {
    super(failure.message);
    this.name = 'SchemaBootAbortError';
    this.exitCode = failure.exit_code;
    this.failure = failure;
  }
}

/**
 * Exit code que o processo deve adotar para um erro fatal de boot qualquer.
 *
 * `1` para tudo que não for o gate de schema — o comportamento histórico —, e
 * o código específico da invariante quando for. Fica aqui, e não inline no
 * `catch`, para ser testável sem subir o processo.
 */
export function bootExitCode(err: unknown): number {
  return err instanceof SchemaBootAbortError ? err.exitCode : 1;
}
