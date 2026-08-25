/**
 * Issue #536 §2 — o GUARDA DESTRUTIVO do artefato de export (o `.enc`).
 *
 * Este arquivo existe porque o TTL do export deixou de ser um carimbo e virou
 * uma remoção de arquivo. Até aqui `privacy_requests.export_expires_at` só
 * dizia que o pacote tinha vencido; o `.enc` continuava no disco. O varredor
 * que apaga esse arquivo recebe o alvo do BANCO, e uma linha de banco é entrada
 * NÃO CONFIÁVEL para uma chamada de `rm`: basta um `export_locator` corrompido
 * (por bug de escrita, por restore de um snapshot torto, por qualquer caminho
 * que grave nessa coluna no futuro) para a varredura apagar um arquivo fora da
 * árvore de exports.
 *
 * A ORDEM DAS CHECAGENS FAZ PARTE DO CONTRATO — pelo mesmo motivo que em
 * `assertDrillTarget` (`src/ops/backup/drill.ts`): o código de recusa que
 * aterrissa na auditoria precisa nomear o PIOR fato verdadeiro sobre o alvo. Um
 * locator `../../etc/passwd` tem que ser registrado como `parent traversal`, não
 * como o tecnicamente-também-verdadeiro "não parece um UUID". As duas recusas
 * impedem o mesmo `rm`, mas só a primeira diz ao operador que alguém tentou sair
 * da árvore. Por isso as recusas ESTRUTURAIS (separador, `..`, absoluto, letra
 * de unidade, caractere de controle) vêm ANTES da recusa de forma.
 *
 * Três camadas, deliberadamente redundantes — a mesma disciplina de
 * `src/ops/backup/artifact-path.ts`:
 *
 *   1. FORMA — o locator é um basename com forma positiva (UUID). Nada é
 *      "saneado": um traversal limpo continua sendo um caminho escolhido por
 *      outra pessoa;
 *   2. CONTENÇÃO — o caminho resolvido precisa ser PROVADO filho direto da raiz
 *      de exports, por identidade e não por `startsWith`;
 *   3. INODE — a checagem que `artifact-path.ts` não faz e que aqui é
 *      obrigatória: o alvo não pode ser SYMLINK (apagar o link é inofensivo,
 *      mas um link é a prova de que o caminho não é o que o banco diz que é),
 *      precisa ser arquivo regular, e não pode ter outro hard link. Um `.enc`
 *      com `nlink > 1` é um artefato do qual alguém guardou uma segunda cópia:
 *      apagar o nosso e declarar o dado destruído seria evidência de
 *      conformidade sem a conformidade.
 *
 * FALHA FECHADO em todas elas. Locator irreconhecível é RECUSA AUDITADA — nunca
 * "apaga por precaução" (é remoção arbitrária de arquivo no host) e nunca
 * "ignora em silêncio" (é um pacote cifrado com dados de um titular vivendo
 * para sempre no disco, que é exatamente o vazamento que o TTL fecha).
 */
import nodePath from 'node:path';
import { TypedError } from '@/lib/utils.js';
import type { PathImpl } from '@/ops/backup/artifact-path.js';

/** Sufixo do artefato cifrado gravado por `sealExport`. */
export const EXPORT_ARTIFACT_SUFFIX = '.enc';

/**
 * Forma positiva do locator: o UUID v4 canônico, minúsculo, que
 * `sealExport` (`src/ops/privacy/adapters.ts`) emite via `randomUUID()`.
 *
 * Deliberadamente estreita. O locator é OPACO por contrato da migration 102
 * ("jamais uma URL assinada"), então não há caso legítimo de um locator com
 * qualquer outra forma. Ampliar isto é ampliar a superfície de um `rm`.
 */
const EXPORT_LOCATOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Códigos de recusa — vocabulário FECHADO, é o que vai para a auditoria. */
export type ExportLocatorRefusal =
  | 'empty_or_non_string'
  | 'surrounding_whitespace'
  | 'control_character'
  | 'path_separator'
  | 'parent_traversal'
  | 'drive_letter'
  | 'absolute_path'
  | 'not_an_export_locator'
  | 'empty_export_root'
  | 'not_a_direct_child'
  | 'escapes_export_root'
  | 'basename_changed'
  | 'root_unresolvable'
  | 'symlink'
  | 'not_a_regular_file'
  | 'multiply_linked'
  | 'stat_failed'
  | 'locator_not_bound_to_request'
  | 'request_vanished'
  | 'default_scope_sentinel';

export class UnsafeExportLocatorError extends TypedError {
  constructor(
    public readonly reason: ExportLocatorRefusal,
    locator: string,
  ) {
    // O locator é ecoado porque é um identificador opaco, nunca uma
    // credencial e nunca um dado do titular — e quem investiga uma linha
    // envenenada precisa ver o que estava nela. Truncado para que um valor
    // patológico não inunde a linha de log.
    super('unsafe_export_locator', `refusing to use export locator (${reason})`, {
      reason,
      locator_sample: locator.slice(0, 120),
    });
  }
}

/**
 * Camada 1 — o locator é um basename de forma conhecida?
 *
 * Devolve o locator INALTERADO. Nunca normaliza: um traversal normalizado
 * continua sendo um traversal que passou.
 */
export function assertSafeExportLocator(locator: unknown): string {
  if (typeof locator !== 'string' || locator.length === 0) {
    throw new UnsafeExportLocatorError('empty_or_non_string', String(locator ?? ''));
  }
  if (locator !== locator.trim()) {
    throw new UnsafeExportLocatorError('surrounding_whitespace', locator);
  }
  // Caracteres de controle, incluindo o NUL que trunca um caminho em C.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(locator)) {
    throw new UnsafeExportLocatorError('control_character', locator);
  }
  // OS DOIS separadores, em toda plataforma: um host POSIX ainda precisa
  // recusar um locator em forma Windows.
  if (locator.includes('/') || locator.includes('\\')) {
    throw new UnsafeExportLocatorError('path_separator', locator);
  }
  if (locator.includes('..')) {
    throw new UnsafeExportLocatorError('parent_traversal', locator);
  }
  // `C:foo` é RELATIVO À UNIDADE no Windows e resolve fora da nossa raiz, sem
  // nenhum separador à vista.
  if (/^[A-Za-z]:/.test(locator)) {
    throw new UnsafeExportLocatorError('drive_letter', locator);
  }
  if (nodePath.posix.isAbsolute(locator) || nodePath.win32.isAbsolute(locator)) {
    throw new UnsafeExportLocatorError('absolute_path', locator);
  }
  if (!EXPORT_LOCATOR.test(locator)) {
    throw new UnsafeExportLocatorError('not_an_export_locator', locator);
  }
  return locator;
}

/** Forma não-lançante, para filtrar uma listagem sem tratar exceção. */
export function isSafeExportLocator(locator: unknown): locator is string {
  try {
    assertSafeExportLocator(locator);
    return true;
  } catch {
    return false;
  }
}

/** O nome do arquivo que `sealExport` grava para um locator. */
export function exportArtifactFilename(locator: string): string {
  return `${assertSafeExportLocator(locator)}${EXPORT_ARTIFACT_SUFFIX}`;
}

/**
 * Camada 2 — resolve para um caminho absoluto e PROVA que ele é filho DIRETO da
 * raiz de exports.
 *
 * Lança em vez de devolver booleano, pelo mesmo motivo de `resolveArtifactPath`:
 * um chamador não pode apagar por ter esquecido de conferir.
 */
export function resolveExportArtifactPath(
  root: string,
  locator: string,
  path: PathImpl = nodePath,
): string {
  const safe = assertSafeExportLocator(locator);
  if (typeof root !== 'string' || root.trim() === '') {
    throw new UnsafeExportLocatorError('empty_export_root', safe);
  }
  const name = `${safe}${EXPORT_ARTIFACT_SUFFIX}`;
  const absRoot = path.resolve(root);
  const candidate = path.resolve(absRoot, name);

  // Prova de contenção por IDENTIDADE. `startsWith(absRoot + sep)` sozinho
  // aceitaria `/exports-evil/x` para uma raiz `/exports`.
  const expected = path.join(absRoot, name);
  if (candidate !== expected) {
    throw new UnsafeExportLocatorError('not_a_direct_child', locator);
  }
  if (!candidate.startsWith(absRoot + path.sep)) {
    throw new UnsafeExportLocatorError('escapes_export_root', locator);
  }
  if (path.basename(candidate) !== name) {
    throw new UnsafeExportLocatorError('basename_changed', locator);
  }
  return candidate;
}

/**
 * O que a camada 3 precisa do sistema de arquivos. Injetável para que symlink,
 * FIFO e hard link sejam TESTÁVEIS sem depender do que existe no host.
 */
export interface ExportPathProbe {
  /** Resolve links da RAIZ. Um erro aqui é recusa, não permissão de seguir. */
  realpath(p: string): Promise<string>;
  /** `lstat` — NUNCA `stat`: `stat` segue o link e esconde exatamente o caso. */
  lstat(p: string): Promise<{
    isSymbolicLink(): boolean;
    isFile(): boolean;
    nlink: number;
  }>;
}

export interface ProvenExportArtifact {
  /** Caminho absoluto provado. */
  path: string;
  /**
   * `false` quando o arquivo já não existe.
   *
   * NÃO é erro: é o estado normal da SEGUNDA execução do varredor sobre o mesmo
   * pedido, e é o que torna a idempotência possível sem tratar ausência como
   * falha.
   */
  present: boolean;
}

/**
 * Camada 3 — o inode. Roda DEPOIS das camadas 1 e 2, sempre.
 *
 * O que cada recusa impede:
 *
 *  - `root_unresolvable` — não dá para provar contenção contra uma raiz que
 *    não se sabe onde está. Fail-closed: não conseguir determinar a raiz não é
 *    permissão para pular a prova, é o motivo para parar (mesmo raciocínio de
 *    `drill_target_unverifiable`);
 *  - `symlink` — o caminho não é o arquivo que o banco diz que é. Apagar o
 *    link não apagaria o pacote cifrado, e o pedido passaria a afirmar que o
 *    artefato foi destruído;
 *  - `not_a_regular_file` — diretório, FIFO ou socket no lugar do `.enc`. Nada
 *    disso foi escrito por `sealExport`;
 *  - `multiply_linked` — existe outro nome para os MESMOS bytes. Remover o
 *    nosso destrói o rastro e não o dado.
 */
export async function proveExportArtifact(
  root: string,
  locator: string,
  probe: ExportPathProbe,
  path: PathImpl = nodePath,
): Promise<ProvenExportArtifact> {
  const abs = resolveExportArtifactPath(root, locator, path);

  let realRoot: string;
  try {
    realRoot = await probe.realpath(root);
  } catch {
    throw new UnsafeExportLocatorError('root_unresolvable', locator);
  }

  let st: Awaited<ReturnType<ExportPathProbe['lstat']>>;
  try {
    st = await probe.lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { path: abs, present: false };
    }
    throw new UnsafeExportLocatorError('stat_failed', locator);
  }

  if (st.isSymbolicLink()) {
    throw new UnsafeExportLocatorError('symlink', locator);
  }
  if (!st.isFile()) {
    throw new UnsafeExportLocatorError('not_a_regular_file', locator);
  }
  if (typeof st.nlink === 'number' && st.nlink > 1) {
    throw new UnsafeExportLocatorError('multiply_linked', locator);
  }

  // Prova final, contra a árvore REAL. As camadas 1 e 2 raciocinam sobre
  // strings; esta pergunta ao kernel onde os bytes estão. Com a raiz sendo ela
  // mesma um symlink (um `privacy-export` montado em outro volume, coisa que o
  // operador legitimamente faz), a camada 2 provaria contenção contra o caminho
  // NOMINAL e não contra o físico — e é aqui que os dois se encontram.
  let realTarget: string;
  try {
    realTarget = await probe.realpath(abs);
  } catch {
    throw new UnsafeExportLocatorError('stat_failed', locator);
  }
  const expectedReal = path.join(
    path.resolve(realRoot),
    `${locator}${EXPORT_ARTIFACT_SUFFIX}`,
  );
  if (realTarget !== expectedReal) {
    throw new UnsafeExportLocatorError('escapes_export_root', locator);
  }

  return { path: abs, present: true };
}

/**
 * O quarto eixo: o locator CORRESPONDE ao pedido?
 *
 * O varredor planeja a partir de uma listagem e apaga instantes depois. Entre
 * as duas coisas a linha pode ter mudado — outro processo pode ter reemitido o
 * export, ou a linha pode ter sumido. Apagar o arquivo do plano nesse caso
 * destruiria um artefato VIVO enquanto o pedido acha que ele existe.
 *
 * Por isso a releitura é obrigatória imediatamente antes da remoção, e a
 * comparação é por (id do pedido, escopo, locator) — não só pelo locator.
 */
export interface ExportBinding {
  request_id: string;
  tenant_id: string;
  agent_id: string;
  locator: string;
}

export function assertLocatorBoundToRequest(
  planned: ExportBinding,
  fresh: ExportBinding | null,
): void {
  if (fresh === null) {
    throw new UnsafeExportLocatorError('request_vanished', planned.locator);
  }
  if (
    fresh.request_id !== planned.request_id ||
    fresh.tenant_id !== planned.tenant_id ||
    fresh.agent_id !== planned.agent_id ||
    fresh.locator !== planned.locator
  ) {
    throw new UnsafeExportLocatorError('locator_not_bound_to_request', planned.locator);
  }
  // Defesa em profundidade sobre o CHECK da migration 102: um escopo `default`
  // é um caminho não migrado, e um caminho não migrado não apaga arquivo.
  if (fresh.tenant_id === 'default' || fresh.agent_id === 'default') {
    throw new UnsafeExportLocatorError('default_scope_sentinel', planned.locator);
  }
}
