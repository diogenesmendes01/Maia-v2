/**
 * Issue #536 §2/§3 — o IO por trás de `PrivacyPorts` e `ReapplyPorts`.
 *
 * Mesma divisão de `service.ts`/`adapters.ts` e `drill.ts`/`drill-adapters.ts`:
 * a decisão vive em `execution.ts`/`reapply.ts` e é 100% testada com fakes;
 * este arquivo é só efeito colateral — SQL, arquivo, criptografia.
 *
 * COMO O PSEUDÔNIMO VIRA LINHA. `subject_ref` é HMAC de mão única, então
 * nenhuma query consegue partir dele para achar o titular. O adapter faz o
 * caminho que um ledger pseudonimizado permite: deriva o `subject_ref` de cada
 * pessoa DO ESCOPO e compara. Ele RECONHECE um sujeito; não o enumera — que é
 * literalmente o que a migration 102 diz sobre o ledger. O custo é uma
 * varredura por escopo, memoizada por execução; pedidos de titular são raros e
 * a alternativa (guardar o telefone junto do tombstone) desfaria a
 * pseudonimização inteira.
 *
 * O QUE ESTE ADAPTER AINDA NÃO FAZ, e por que isso é uma exceção declarada e
 * não um silêncio: `UNSUPPORTED_CLASSES` abaixo. Uma classe listada ali entra
 * no pedido como EXCEÇÃO registrada, com código de motivo. Ela NÃO é purgada e
 * NÃO recebe tombstone — e, principalmente, não é "purgada com zero linhas",
 * que faria o pedido se declarar cumprido sem ter apagado nada.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { config } from '@/config/env.js';
import { db } from '@/db/client.js';
import { audit } from '@/governance/audit.js';
import type { AuditAction } from '@/governance/audit-actions.js';
import { TypedError } from '@/lib/utils.js';
import { encryptFile, parseBackupKeyring } from '@/ops/backup/encryption.js';
import { deriveTombstoneSecret } from '@/ops/retention/tombstones.js';
import type { HoldRecord } from '@/ops/retention/legal-hold.js';
import type { TombstoneRecord } from '@/ops/retention/tombstones.js';
import { resolveSubjectRef } from './workflow.js';
import type {
  PrivacyPorts,
  PrivacyScope,
  PurgeJob,
  StageExportJob,
  SubjectBinding,
} from './execution.js';
import type { ReapplyPorts } from './reapply.js';

/**
 * As classes cujo mecanismo este adapter NÃO executa hoje, com o CÓDIGO do
 * motivo. Cada linha é uma dívida nomeada, não um esquecimento:
 *
 *  - `media.blobs` e `gateway.baileys_session` estão fora do PostgreSQL. É o
 *    eixo 4 da issue #536 (backup e mecanismo próprios), não implementado;
 *  - `postgres.audit` tem mecanismo `redact`, e QUAIS campos podem ser
 *    redigidos é uma das perguntas abertas ao DPO. Implementar agora seria
 *    codificar suposição jurídica como fato — o que a #520 proíbe
 *    explicitamente;
 *  - `postgres.memory` e `postgres.traces` não têm hoje uma ligação de
 *    titular no schema (`agent_memories`/`agent_facts` são escopo de agente
 *    com `escopo` textual; `runtime_trace_bodies` é por turno). Purgar por
 *    aproximação apagaria dado de outros titulares;
 *  - `privacy.export` guarda o artefato cifrado de outro pedido; a vida dele é
 *    a pergunta "vida do export de privacidade", também aberta.
 */
export const UNSUPPORTED_CLASSES: Readonly<Record<string, string>> = Object.freeze({
  'media.blobs': 'mechanism_not_implemented',
  'gateway.baileys_session': 'mechanism_not_implemented',
  'postgres.audit': 'pending_dpo_decision',
  'postgres.memory': 'no_subject_linkage',
  'postgres.traces': 'no_subject_linkage',
  'privacy.export': 'pending_dpo_decision',
  // `transacoes` NÃO tem `pessoa_id`. Tem `contraparte_id` e `registrado_por`,
  // e qual dos dois é "a transação DESTE titular" não está decidido em lugar
  // nenhum. A classe já é não-purgável (retenção contábil), então o efeito
  // prático é sobre o EXPORT — e exportar pelo join errado entregaria a um
  // titular o extrato de outro. Chutar aqui é um vazamento; recusar é uma
  // dívida nomeada.
  'postgres.financial': 'no_subject_linkage',
});

/**
 * Vida útil do export, conservadora por default.
 *
 * "Vida do export de privacidade" é uma das perguntas abertas ao DPO, então
 * este número é provisório — mas a direção conservadora aqui é o OPOSTO da
 * retenção: para apagamento, errar para mais tempo é recuperável; para um
 * pacote cifrado com os dados de um titular parado no disco, errar para menos
 * tempo é que é. Sete dias dá ao titular uma janela real e não deixa o
 * artefato virar acervo.
 */
const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function privacyWorkspace(): string {
  // Mesma razão de `drillWorkspace()`: `BACKUP_DIR` já é tratado como
  // sensível pelo operador; espalhar dados de titular em `/tmp` desfaria a
  // criptografia que acabamos de aplicar.
  return join(config.BACKUP_DIR, 'privacy-export');
}

function tombstoneSecret(): string {
  return deriveTombstoneSecret(config.RUNTIME_TRACE_HMAC_MASTER_SECRET);
}

/**
 * Pessoas do escopo cujo `subject_ref` bate com o do pedido.
 *
 * Devolve ids, nunca telefones. Um resultado VAZIO não é erro: o titular pode
 * simplesmente não ter linha neste agente, e a purga por classe devolve zero
 * legitimamente.
 */
async function resolveSubjectPeople(
  scope: PrivacyScope,
  subject: SubjectBinding,
): Promise<string[]> {
  const secret = tombstoneSecret();
  const res = await db.execute<{ id: string; telefone_whatsapp: string }>(sql`
    SELECT id, telefone_whatsapp
      FROM pessoas
     WHERE tenant_id = ${scope.tenant_id}
       AND agent_id = ${scope.agent_id}
  `);
  const ids: string[] = [];
  for (const row of res.rows) {
    // As DUAS formas, porque um pedido pode ter nascido de qualquer uma e o
    // `subject_ref` gravado depende do `kind`. Derivar só uma faria um pedido
    // aberto por `person_id` não casar com linha nenhuma — e "não casou" aqui
    // não vira erro: vira uma exclusão que conclui sem apagar nada.
    for (const candidate of [
      { kind: 'phone_e164' as const, value: row.telefone_whatsapp },
      { kind: 'person_id' as const, value: row.id },
    ]) {
      let derived: string;
      try {
        derived = resolveSubjectRef(scope, candidate, secret).subject_ref;
      } catch {
        // Uma linha já anonimizada tem `telefone_whatsapp='anon:…'`, que não é
        // E.164 e faz o resolvedor recusar — corretamente. Ela simplesmente não
        // é candidata; deixar a exceção subir derrubaria a resolução do escopo
        // inteiro no primeiro titular já anonimizado.
        continue;
      }
      if (derived === subject.subject_ref) {
        ids.push(row.id);
        break;
      }
    }
  }
  return ids;
}

/** Memoiza a resolução dentro de UMA execução — a varredura não se repete por classe. */
function memoizedResolver(): (s: PrivacyScope, b: SubjectBinding) => Promise<string[]> {
  const cache = new Map<string, Promise<string[]>>();
  return (scope, subject) => {
    const key = `${scope.tenant_id}|${scope.agent_id}|${subject.subject_ref}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = resolveSubjectPeople(scope, subject);
      cache.set(key, hit);
    }
    return hit;
  };
}

async function purgeClass(
  job: PurgeJob,
  resolve: (s: PrivacyScope, b: SubjectBinding) => Promise<string[]>,
): Promise<number> {
  if (UNSUPPORTED_CLASSES[job.data_class] !== undefined) {
    // Nunca deveria chegar: `executePrivacyRequest` filtra antes. Se chegou,
    // LANÇA — devolver 0 aqui seria a falsa conformidade que este módulo
    // inteiro existe para evitar.
    throw new TypedError(
      'purge_mechanism_not_implemented',
      'this adapter does not implement a purge for this class',
      { data_class: job.data_class },
    );
  }

  const people = await resolve(job.scope, job.subject);
  if (people.length === 0) return 0;

  switch (job.data_class) {
    case 'postgres.messages': {
      // Roda ANTES de `postgres.conversations` — ver `PURGE_ORDER` em
      // `execution.ts`. `mensagens.conversa_id` tem `ON DELETE CASCADE`, então
      // apagar as conversas primeiro levaria as mensagens junto e esta contagem
      // sairia zero, mentindo na evidência do pedido.
      const res = await db.execute(sql`
        DELETE FROM mensagens
         WHERE tenant_id = ${job.scope.tenant_id}
           AND agent_id = ${job.scope.agent_id}
           AND conversa_id IN (
             SELECT id FROM conversas
              WHERE tenant_id = ${job.scope.tenant_id}
                AND agent_id = ${job.scope.agent_id}
                AND pessoa_id = ANY(${people}::uuid[])
           )
      `);
      return res.rowCount ?? 0;
    }
    case 'postgres.conversations': {
      const res = await db.execute(sql`
        DELETE FROM conversas
         WHERE tenant_id = ${job.scope.tenant_id}
           AND agent_id = ${job.scope.agent_id}
           AND pessoa_id = ANY(${people}::uuid[])
      `);
      return res.rowCount ?? 0;
    }
    case 'postgres.people': {
      // ANONIMIZAR, não apagar: a linha é referenciada por transações que a
      // classe `postgres.financial` mantém por obrigação contábil. Apagá-la
      // quebraria a integridade do que a lei manda guardar. O telefone vira um
      // valor irreversível e único (o pseudônimo do próprio titular), para que
      // a unicidade composta `(tenant, agent, telefone_whatsapp)` continue
      // valendo e nenhuma mensagem nova se ligue a ele.
      //
      // `status` vai para `inativa`, um dos quatro valores que
      // `pessoas_status_check` (migration 002) admite — `ativa`, `inativa`,
      // `bloqueada`, `quarentena`. Um status novo como `anonimizada` precisaria
      // de migration própria; o marcador de anonimização é o prefixo `anon:` no
      // telefone, e é ele que torna a operação idempotente.
      const res = await db.execute(sql`
        UPDATE pessoas
           SET nome = 'anonimizado',
               apelido = NULL,
               email = NULL,
               observacoes = NULL,
               telefone_whatsapp = ${`anon:${job.subject.subject_ref.slice(0, 32)}`},
               preferencias = '{}'::jsonb,
               modelo_mental = '{}'::jsonb,
               status = 'inativa',
               updated_at = now()
         WHERE tenant_id = ${job.scope.tenant_id}
           AND agent_id = ${job.scope.agent_id}
           AND id = ANY(${people}::uuid[])
           AND telefone_whatsapp NOT LIKE 'anon:%'
      `);
      return res.rowCount ?? 0;
    }
    default:
      throw new TypedError('purge_mechanism_not_implemented', 'unknown data class for purge', {
        data_class: job.data_class,
      });
  }
}

async function listHolds(scope: PrivacyScope): Promise<readonly HoldRecord[] | null> {
  try {
    const res = await db.execute<{
      id: string;
      tenant_id: string;
      agent_id: string;
      data_class: string;
      subject_ref: string | null;
      status: 'active' | 'released';
      effective_from: Date;
      effective_until: Date | null;
      reason_code: string;
    }>(sql`
      SELECT id, tenant_id, agent_id, data_class, subject_ref, status,
             effective_from, effective_until, reason_code
        FROM legal_holds
       WHERE tenant_id = ${scope.tenant_id}
         AND agent_id = ${scope.agent_id}
         AND status = 'active'
    `);
    return res.rows.map((r) => ({
      ...r,
      effective_from: new Date(r.effective_from),
      effective_until: r.effective_until === null ? null : new Date(r.effective_until),
    }));
  } catch {
    // `null`, não `[]`. A diferença é a diferença entre "não há hold" e "não
    // sei se há hold", e `executePrivacyRequest` falha fechado na segunda.
    return null;
  }
}

async function recordTombstone(t: TombstoneRecord): Promise<void> {
  await db.execute(sql`
    INSERT INTO data_tombstones
      (id, tenant_id, agent_id, data_class, subject_ref, resource_locator,
       action, effective_at, origin, version, hmac, hmac_key_version)
    VALUES
      (${t.id}::uuid, ${t.tenant_id}, ${t.agent_id}, ${t.data_class}, ${t.subject_ref},
       ${t.resource_locator}, ${t.action}, ${t.effective_at}, ${t.origin}, ${t.version},
       ${t.hmac}, ${t.hmac_key_version})
  `);
}

async function stageExport(job: StageExportJob): Promise<{
  path: string;
  rows: Record<string, number>;
}> {
  const people = await resolveSubjectPeople(job.scope, job.subject);
  const rows: Record<string, number> = {};
  const bundle: Record<string, unknown[]> = {};

  if (people.length > 0) {
    for (const klass of job.data_classes) {
      const data = await exportClass(job.scope, klass, people);
      if (data === null) continue;
      bundle[klass] = data;
      rows[klass] = data.length;
    }
  }

  await mkdir(privacyWorkspace(), { recursive: true });
  const path = join(privacyWorkspace(), `${randomUUID()}.json`);
  // `wx`: nunca sobrescrever. O nome é aleatório, então uma colisão significa
  // que algo está errado o bastante para parar.
  await writeFile(path, JSON.stringify({ generated_at: new Date().toISOString(), bundle }), {
    flag: 'wx',
    mode: 0o600,
  });
  return { path, rows };
}

async function exportClass(
  scope: PrivacyScope,
  klass: string,
  people: string[],
): Promise<unknown[] | null> {
  switch (klass) {
    case 'postgres.people': {
      const res = await db.execute(sql`
        SELECT id, nome, apelido, telefone_whatsapp, email, tipo, status, created_at
          FROM pessoas
         WHERE tenant_id = ${scope.tenant_id} AND agent_id = ${scope.agent_id}
           AND id = ANY(${people}::uuid[])
      `);
      return res.rows;
    }
    case 'postgres.conversations': {
      const res = await db.execute(sql`
        SELECT id, status, ultima_atividade_em, created_at
          FROM conversas
         WHERE tenant_id = ${scope.tenant_id} AND agent_id = ${scope.agent_id}
           AND pessoa_id = ANY(${people}::uuid[])
      `);
      return res.rows;
    }
    case 'postgres.messages': {
      const res = await db.execute(sql`
        SELECT m.id, m.direcao, m.tipo, m.conteudo, m.created_at
          FROM mensagens m
          JOIN conversas c ON c.id = m.conversa_id
         WHERE m.tenant_id = ${scope.tenant_id} AND m.agent_id = ${scope.agent_id}
           AND c.pessoa_id = ANY(${people}::uuid[])
      `);
      return res.rows;
    }
    default:
      // Classe sem extrator: `null` faz o chamador OMITIR a classe do pacote,
      // e ela já consta como exceção registrada no pedido.
      return null;
  }
}

async function sealExport(
  plaintextPath: string,
): Promise<{ locator: string; bytes: number; key_id: string }> {
  const keyring = parseBackupKeyring(
    config.BACKUP_ENCRYPTION_KEYRING,
    config.BACKUP_ENCRYPTION_ACTIVE_KEY_ID,
  );
  const locator = randomUUID();
  const dest = join(privacyWorkspace(), `${locator}.enc`);
  try {
    const result = await encryptFile(plaintextPath, dest, keyring);
    return { locator, bytes: result.bytes, key_id: result.key_id };
  } finally {
    // O texto em claro sai SEMPRE, inclusive quando a cifragem falha — é o
    // caminho em que ele é mais perigoso, porque ninguém vai voltar para
    // limpá-lo.
    await rm(plaintextPath, { force: true });
  }
}

async function updateRequest(id: string, patch: Record<string, unknown>): Promise<void> {
  // Colunas de vocabulário FECHADO, montadas uma a uma. Um `SET` construído a
  // partir das chaves do objeto deixaria o chamador escolher a coluna.
  const set = [sql`updated_at = now()`];
  if ('status' in patch) set.push(sql`status = ${patch.status as string}`);
  if ('completed_at' in patch) set.push(sql`completed_at = ${patch.completed_at as Date | null}`);
  if ('denied_reason_code' in patch) {
    set.push(sql`denied_reason_code = ${patch.denied_reason_code as string | null}`);
  }
  if ('systems_covered' in patch) {
    set.push(sql`systems_covered = ${JSON.stringify(patch.systems_covered)}::jsonb`);
  }
  if ('exceptions' in patch) {
    set.push(sql`exceptions = ${JSON.stringify(patch.exceptions)}::jsonb`);
  }
  if ('evidence' in patch) set.push(sql`evidence = ${JSON.stringify(patch.evidence)}::jsonb`);
  if ('export_locator' in patch) {
    set.push(sql`export_locator = ${patch.export_locator as string | null}`);
  }
  if ('export_expires_at' in patch) {
    set.push(sql`export_expires_at = ${patch.export_expires_at as Date | null}`);
  }
  await db.execute(sql`
    UPDATE privacy_requests SET ${sql.join(set, sql`, `)} WHERE id = ${id}::uuid
  `);
}

export function createPrivacyPorts(): PrivacyPorts {
  const resolve = memoizedResolver();
  return {
    listHolds,
    purge: (job) => purgeClass(job, resolve),
    stageExport,
    sealExport,
    recordTombstone,
    updateRequest,
    audit: (action: AuditAction, metadata) => audit({ acao: action, metadata }),
    now: () => new Date(),
    newId: () => randomUUID(),
    tombstoneSecret,
    exportTtlMs: EXPORT_TTL_MS,
    unsupported: UNSUPPORTED_CLASSES,
  };
}

/**
 * As portas da reaplicação pós-restore.
 *
 * `purge` é literalmente a mesma função de `createPrivacyPorts`. Se fosse uma
 * segunda implementação, as duas divergiriam, e a divergência apareceria como
 * dado de titular voltando à vida depois de um incidente — a pior hora
 * possível para descobrir.
 */
export function createReapplyPorts(): ReapplyPorts {
  const resolve = memoizedResolver();
  return {
    purge: (job) => purgeClass(job, resolve),
    markReconciled: async (tombstoneId, at) => {
      await db.execute(sql`
        UPDATE data_tombstones SET last_reconciled_at = ${at} WHERE id = ${tombstoneId}::uuid
      `);
    },
    audit: (action: AuditAction, metadata) => audit({ acao: action, metadata }),
    now: () => new Date(),
  };
}
