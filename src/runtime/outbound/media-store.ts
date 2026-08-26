/**
 * Issue #634 (fatia E da épica #506) — ONDE A MÍDIA DE SAÍDA PASSA A MORAR.
 *
 * Três fatias seguidas empurraram esta decisão para cá, e cada uma escreveu o
 * motivo no código:
 *
 *   - #631, ramo de VOZ: `synthesizeSpeech` devolve um Buffer EM MEMÓRIA. O
 *     payload `audio` de #630 exige um `MediaRef`, e não existe variante que
 *     aceite bytes. O ramo NÃO commitava artefato durável — exceção declarada.
 *   - #631, ramo de DOCUMENTO: commitava com `local_path` apontando para o PDF
 *     temporário DESTA tentativa, que o `finally` remove logo em seguida. A
 *     row sobrevive ao crash; o arquivo, não.
 *   - #632, `provider-adapter.ts`: `storage_object` não era resolvível, então
 *     um artefato durável terminava em `rejected_permanent` com
 *     `media_ref_unresolved`.
 *
 * ─── A decisão ──────────────────────────────────────────────────────────────
 *
 * A mídia de saída passa a morar em `<MEDIA_ROOT>/outbound/`, e o artefato
 * carrega um `storage_object`.
 *
 * POR QUE `MEDIA_ROOT` E NÃO UM BUCKET NOVO. O projeto não tem object storage.
 * `MEDIA_ROOT` é o volume que a plataforma JÁ declara como o lugar durável da
 * mídia: `docker-compose.yml` o monta como volume próprio, o inventário de
 * retenção o nomeia (`media.blobs`, `source_of_truth:'filesystem:/app/media'`,
 * `backup_behavior:'excluded_volume'`) e a mídia de ENTRADA já vive lá e é
 * lida turnos depois. Introduzir S3 aqui seria uma dependência de
 * infraestrutura nova numa fatia cujo trabalho é fechar caminhos de envio.
 *
 * POR QUE ISSO NÃO É `local_path` COM OUTRO NOME — e esta é a pergunta certa.
 * A diferença não é o nome, é o DONO DO CICLO DE VIDA:
 *
 *   `local_path`   → o PDF de `<MEDIA_ROOT>/tmp/<uuid>.pdf` é removido pelo
 *                    `finally` do próprio envio. Uma segunda tentativa (o
 *                    delivery worker de #632, o recovery de #633) encontra
 *                    ENOENT com CERTEZA. A referência já nasce morta.
 *   `storage_object` → o objeto é escrito ANTES do commit e só é descartado
 *                    quando a linha do outbox chega a estado TERMINAL. Uma
 *                    segunda tentativa encontra exatamente os mesmos bytes.
 *
 * O que continua verdade, e fica dito: a durabilidade deste store é a
 * durabilidade do volume `MEDIA_ROOT`. Réplicas que compartilham o volume
 * (o desenho do `docker-compose.yml`) resolvem o objeto; uma réplica com
 * volume próprio não resolveria — e o desfecho nesse caso é
 * `media_ref_unresolved`, recusa DEFINITIVA e observável, nunca "enviar outra
 * coisa". Trocar o backend do store por S3 é trocar este módulo, e só ele: o
 * `MediaRef` persistido não carrega caminho, URL nem credencial.
 *
 * ─── A forma da chave ───────────────────────────────────────────────────────
 *
 *   bucket     = 'maia-outbound-media'   (namespace LÓGICO, não um bucket S3)
 *   object_key = '<tenant_id>/<agent_id>/<pessoa_id>/<sha256>.<ext>'
 *
 * Quatro segmentos, todos identificadores opacos ou hash de conteúdo — nenhum
 * telefone, nenhum nome, nenhum texto. E cada segmento existe por um motivo
 * verificável:
 *
 *   - `tenant_id`/`agent_id`: o resolvedor EXIGE que batam com o escopo ALS
 *     vigente. É a checagem que carrega o isolamento — uma row de outro tenant
 *     que carregue este `object_key` não resolve, mesmo que o arquivo exista
 *     no disco. (Ver a sonda de colisão forçada em
 *     `tests/integration/outbound-midia-duravel-real-db.spec.ts`.)
 *   - `pessoa_id`: é o que torna o APAGAMENTO POR TITULAR expressável. A LGPD
 *     do projeto (#536) purga por sujeito; um store endereçado só por conteúdo
 *     não teria como responder "quais objetos são deste titular", e a classe
 *     entraria em `UNSUPPORTED_CLASSES` com `no_subject_linkage` — que é
 *     exatamente o que acontece hoje com `media.blobs`. O diretório do titular
 *     É o mecanismo de purga.
 *   - `sha256`: endereçamento por conteúdo dentro do titular. Mesmo áudio
 *     sintetizado duas vezes ⇒ um objeto. E, principalmente: a escrita é
 *     IDEMPOTENTE, então um retry do commit não multiplica arquivos.
 */
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { assertContainedRegularFile, MediaValidationError } from '@/lib/media-guard.js';
import { sha256 } from '@/lib/utils.js';
import { TypedError } from '@/lib/utils.js';
import type { MediaRef } from './contract.js';

/**
 * Namespace LÓGICO do store. Não é um bucket S3 e não vira caminho: ele existe
 * para que o resolvedor possa RECUSAR um `storage_object` de qualquer outra
 * origem. Sem essa recusa, um `bucket` arbitrário numa row seria só um
 * prefixo ignorado, e o contrato passaria a aceitar referências que este
 * processo não sabe resolver — que é o fail-open que #632 evitou declarando a
 * limitação em vez de escondê-la.
 */
export const OUTBOUND_MEDIA_BUCKET = 'maia-outbound-media';

/** Subdiretório de `MEDIA_ROOT` que o store possui INTEIRO. */
export const OUTBOUND_MEDIA_PREFIX = 'outbound';

/**
 * Teto de bytes de um objeto de saída. Alinhado ao `MAX_DOCUMENT_BYTES` do
 * `media-guard` (15 MiB): a mídia de saída não tem por que poder ser maior que
 * a de entrada, e um teto explícito impede que uma síntese degenerada encha o
 * volume.
 */
export const MAX_OUTBOUND_MEDIA_BYTES = 15 * 1024 * 1024;

/** Segmento de caminho seguro: uuid/hex. Nada de `.`, `..`, `/` ou `\`. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Extensão sem ponto, minúscula. */
const SAFE_EXT = /^[a-z0-9]{1,8}$/;

export type OutboundMediaResolutionCode =
  | 'foreign_bucket'
  | 'malformed_key'
  | 'scope_mismatch'
  | 'not_found';

export class OutboundMediaError extends TypedError {
  constructor(
    public readonly reason: OutboundMediaResolutionCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super('outbound_media_unresolved', message, details);
  }
}

/** Raiz do store. Lazy-import de `baileys.js` pelo mesmo motivo do media-guard. */
export async function outboundMediaRoot(): Promise<string> {
  const { MEDIA_ROOT } = await import('@/gateway/baileys.js');
  return join(MEDIA_ROOT, OUTBOUND_MEDIA_PREFIX);
}

/**
 * O diretório de UM titular dentro do escopo. Exportado porque é o mecanismo
 * de purga da LGPD (`src/ops/privacy/adapters.ts`) — quem apaga precisa da
 * MESMA função que quem escreve, nunca de uma cópia do layout.
 */
export async function outboundMediaSubjectDir(input: {
  tenant_id: string;
  agent_id: string;
  pessoa_id: string;
}): Promise<string> {
  assertSegment(input.tenant_id, 'tenant_id');
  assertSegment(input.agent_id, 'agent_id');
  assertSegment(input.pessoa_id, 'pessoa_id');
  const root = await outboundMediaRoot();
  return join(root, input.tenant_id, input.agent_id, input.pessoa_id);
}

/**
 * Escreve os bytes e devolve a REFERÊNCIA durável.
 *
 * IDEMPOTENTE por construção (o nome é o sha do conteúdo) e ATÔMICA (escreve
 * num temporário do mesmo diretório e renomeia). O `rename` dentro do mesmo
 * filesystem é atômico no POSIX: nenhum leitor jamais vê um arquivo pela
 * metade, que é o modo de falha que faria o delivery worker enviar um áudio
 * truncado em vez de recusar.
 */
export type StoredOutboundMedia = {
  /** O que vai para o payload persistido. Sem caminho, sem URL, sem credencial. */
  ref: MediaRef;
  /**
   * Caminho absoluto RECÉM-escrito, para o envio inline desta mesma tentativa.
   * NÃO persista este valor em lugar nenhum: ele é derivável do `ref` por
   * `resolveOutboundMediaPath`, e persisti-lo recriaria o `local_path` que esta
   * fatia veio remover.
   */
  path: string;
};

export async function putOutboundMedia(input: {
  bytes: Buffer;
  /** Extensão SEM ponto, derivada do mimetype pelo chamador. */
  ext: string;
  pessoa_id: string;
}): Promise<StoredOutboundMedia> {
  if (input.bytes.length === 0) {
    throw new OutboundMediaError('malformed_key', 'outbound media object is empty');
  }
  if (input.bytes.length > MAX_OUTBOUND_MEDIA_BYTES) {
    throw new OutboundMediaError(
      'malformed_key',
      `outbound media object is ${input.bytes.length} bytes (cap ${MAX_OUTBOUND_MEDIA_BYTES})`,
    );
  }
  const ext = input.ext.toLowerCase();
  if (!SAFE_EXT.test(ext)) {
    throw new OutboundMediaError('malformed_key', 'outbound media extension is not safe', { ext });
  }
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const dir = await outboundMediaSubjectDir({
    tenant_id,
    agent_id,
    pessoa_id: input.pessoa_id,
  });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const digest = sha256(input.bytes);
  const file = `${digest}.${ext}`;
  const finalPath = join(dir, file);
  // `.tmp` com uuid: duas tentativas concorrentes do MESMO conteúdo não
  // disputam o mesmo temporário, e o `rename` faz as duas convergirem para o
  // mesmo destino sem que nenhuma leia o parcial da outra.
  const tmpPath = join(dir, `.${randomUUID()}.part`);
  try {
    await writeFile(tmpPath, input.bytes, { mode: 0o600 });
    await rename(tmpPath, finalPath);
  } catch (e) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw e;
  }
  return {
    ref: {
      kind: 'storage_object',
      bucket: OUTBOUND_MEDIA_BUCKET,
      object_key: [tenant_id, agent_id, input.pessoa_id, file].join('/'),
    },
    path: finalPath,
  };
}

/**
 * Resolve um `storage_object` para o caminho REAL, fail-closed em cada etapa.
 *
 * A ordem importa e é deliberada:
 *   1. bucket conhecido            — referência de outro store não resolve;
 *   2. forma da chave              — quatro segmentos seguros, nada de `..`;
 *   3. ESCOPO                      — tenant/agent da chave == ALS vigente;
 *   4. containment + regular file  — o guard já usado pela mídia de entrada.
 *
 * O passo 3 é o que carrega o isolamento entre tenants, e ele é INDEPENDENTE
 * do passo 4: os dois arquivos existem no mesmo volume, então a contenção
 * sozinha aprovaria a leitura cruzada. Uma sonda força exatamente essa
 * colisão.
 */
export async function resolveOutboundMediaPath(ref: MediaRef): Promise<string> {
  if (ref.kind !== 'storage_object') {
    throw new OutboundMediaError('foreign_bucket', 'media ref is not a storage object');
  }
  if (ref.bucket !== OUTBOUND_MEDIA_BUCKET) {
    throw new OutboundMediaError('foreign_bucket', 'storage object belongs to another store', {
      bucket: ref.bucket,
    });
  }
  const parts = ref.object_key.split('/');
  if (parts.length !== 4) {
    throw new OutboundMediaError('malformed_key', 'storage object key has an unexpected shape');
  }
  const [tenant_id, agent_id, pessoa_id, file] = parts as [string, string, string, string];
  for (const [value, label] of [
    [tenant_id, 'tenant_id'],
    [agent_id, 'agent_id'],
    [pessoa_id, 'pessoa_id'],
  ] as const) {
    if (!SAFE_SEGMENT.test(value)) {
      throw new OutboundMediaError('malformed_key', `storage object key segment ${label} is unsafe`);
    }
  }
  if (!/^[0-9a-f]{64}\.[a-z0-9]{1,8}$/.test(file)) {
    throw new OutboundMediaError('malformed_key', 'storage object file name is unsafe');
  }
  // ── O ISOLAMENTO ────────────────────────────────────────────────────────
  // Não é redundante com a contenção abaixo: os objetos de todos os tenants
  // vivem sob a MESMA raiz, então `assertContainedRegularFile` aprovaria com
  // prazer o objeto de outro tenant. Esta comparação é a única coisa entre uma
  // row adulterada e o áudio de outro cliente.
  if (tenant_id !== getCurrentTenant() || agent_id !== getCurrentAgent()) {
    throw new OutboundMediaError(
      'scope_mismatch',
      'storage object key does not belong to the current tenant/agent scope',
    );
  }
  const root = await outboundMediaRoot();
  const candidate = join(root, tenant_id, agent_id, pessoa_id, file);
  try {
    return await assertContainedRegularFile(root, candidate);
  } catch (e) {
    if (e instanceof MediaValidationError) {
      throw new OutboundMediaError('not_found', 'storage object is not readable', {
        code: e.code,
      });
    }
    throw e;
  }
}

/** Existe e é legível? Usado pelo commit para não persistir referência morta. */
export async function outboundMediaExists(ref: MediaRef): Promise<boolean> {
  try {
    const p = await resolveOutboundMediaPath(ref);
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Descarta o objeto — o GC de uma saída que chegou a estado TERMINAL.
 *
 * Isto NÃO é retenção e não é política: é a coleta do buffer de entrega, o
 * mesmo papel que o `cleanupPDF` do `finally` já cumpria para o PDF
 * temporário. A única mudança é QUANDO: antes, no fim da tentativa inline
 * (o que matava a referência para qualquer retry); agora, quando a linha do
 * outbox não pode mais ser tentada.
 *
 * Best-effort de propósito: uma falha aqui deixa um objeto órfão, que é
 * desperdício de disco; lançar aqui transformaria desperdício em falha de
 * entrega. O órfão é visível (o diretório do titular) e some no apagamento por
 * titular.
 */
export async function discardOutboundMedia(ref: MediaRef): Promise<boolean> {
  if (ref.kind !== 'storage_object') return false;
  let p: string;
  try {
    p = await resolveOutboundMediaPath(ref);
  } catch {
    return false;
  }
  try {
    await rm(p, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extensão segura a partir de um nome de arquivo ou de um mimetype, com
 * fallback explícito.
 *
 * Existe para que o call site não precise decidir o que fazer com
 * `relatorio.tar.gz` ou com um nome sem ponto: qualquer coisa que não case com
 * `SAFE_EXT` vira o fallback, e o fallback é sempre um literal do chamador —
 * nunca uma string derivada de dado do usuário.
 */
export function safeOutboundExtension(candidate: string | null | undefined, fallback: string): string {
  const tail = (candidate ?? '').split('.').pop()?.toLowerCase() ?? '';
  return SAFE_EXT.test(tail) ? tail : fallback;
}

function assertSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new OutboundMediaError('malformed_key', `${label} is not a safe path segment`, { label });
  }
}

/** O separador do SO, exposto só para a sonda de contenção. */
export const _pathSeparatorForTests = sep;
