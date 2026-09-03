/**
 * Fixtures das jornadas do console (issue #623) — identidade e estado.
 *
 * Duas responsabilidades, e só elas:
 *
 *   1. Os IDENTIFICADORES das linhas que `scripts/seed-admin-ui-e2e-fixtures.ts`
 *      semeia. Eles são UUID por obrigação, não por estilo: o contrato de
 *      entrada dos routers é `z.string().uuid()`
 *      (`src/admin-ui/trpc/routers/proposals.ts` e `.../traces.ts`), então os
 *      antigos `test-id`/`locked-test`/`test-trace-id` nunca chegariam ao
 *      repositório — reprovariam na validação e a tela renderizaria
 *      `ErrorState`. Ver o relatório da issue.
 *
 *   2. RESTAURAR o estado antes de cada jornada que MUTA (aprovar, rejeitar,
 *      rejeitar em massa). Sem isso a segunda execução — inclusive a segunda
 *      TENTATIVA da mesma execução, com `retries: 2` no CI — encontraria a
 *      proposta já decidida, com os botões desabilitados, e o teste mediria
 *      outra coisa. A asserção de auditoria também deixa de poder ser um
 *      delta: depois de restaurar, o número de linhas para aquele
 *      `resource_id` é ABSOLUTO (exatamente 1 aprovação, exatamente 3
 *      rejeições), e não "uma a mais que antes".
 *
 * O acesso é `pg` cru de propósito: o processo do Playwright não precisa —
 * nem deve — carregar o grafo de módulos de produção (`@/config/env.js` e
 * companhia) só para apagar três linhas.
 */
import pg from 'pg';
import { TENANT_E2E } from './sessao.js';

/**
 * Propostas semeadas. Cada jornada que MUTA tem a SUA — duas jornadas
 * dividindo uma linha se contaminariam pela ordem de execução.
 */
export const PROPOSTAS_E2E = {
  /** Risco baixo, sem trava: classe `capability_safe_tool` (só `owner`). */
  simples: 'e2e10000-0000-4000-8000-000000000001',
  /** Com trava de arquitetura: banner + botões desabilitados fora de founder. */
  travada: 'e2e10000-0000-4000-8000-000000000002',
  /** Classe `capability_dangerous_tool`: aprovação dupla (owner + compliance). */
  dupla: 'e2e10000-0000-4000-8000-000000000003',
  /** Exclusiva da jornada de trilha de auditoria (aprovação). */
  auditoria: 'e2e10000-0000-4000-8000-000000000004',
  /** Exclusiva da jornada de rejeição. */
  rejeicao: 'e2e10000-0000-4000-8000-000000000005',
  /**
   * Trava vinda da CLASSE de aprovação (`capability_dangerous_tool`), não do
   * spec — o caso que a tela lia errado antes da #623.
   */
  perigosa: 'e2e10000-0000-4000-8000-000000000009',
  /** As três de risco baixo que a rejeição em massa consome. */
  lote1: 'e2e10000-0000-4000-8000-000000000006',
  lote2: 'e2e10000-0000-4000-8000-000000000007',
  lote3: 'e2e10000-0000-4000-8000-000000000008',
} as const;

/** Todas as propostas semeadas — a fila inteira, para as jornadas de leitura. */
export const TODAS_AS_PROPOSTAS = Object.values(PROPOSTAS_E2E);

export const PROPOSTAS_DO_LOTE = [
  PROPOSTAS_E2E.lote1,
  PROPOSTAS_E2E.lote2,
  PROPOSTAS_E2E.lote3,
] as const;

/** Trace semeado pelo escritor de produção (envelope + corpo assinados). */
export const TRACE_E2E = 'e2e20000-0000-4000-8000-000000000001';

/**
 * Linha WhatsApp DECLARADA (inativa) — o estado em que uma linha nasce (#518)
 * e o único que a listagem consegue exibir sem o worker `channel_pairing` do
 * runtime. Semeada por `scripts/seed-admin-ui-e2e-fixtures.ts`; o
 * `external_id` é o texto que a jornada procura na tabela.
 */
export const LINHA_DECLARADA_E2E = {
  channelId: 'e2e40000-0000-4000-8000-000000000001',
  externalId: '+5511990000001',
} as const;

/**
 * A SEGUNDA linha WhatsApp declarada — exclusiva da jornada de degradação
 * fechada (`channel-lines.spec.ts`).
 *
 * Ela existe separada porque aquela jornada precisa colocar a linha num estado
 * que as demais não podem encontrar: `pareando` com um envelope de material
 * que o console NÃO consegue abrir. Compartilhar a linha de
 * `channel-lines-pairing.spec.ts` faria uma jornada herdar o estado da outra
 * — o mesmo motivo pelo qual cada jornada que muta tem a SUA proposta.
 */
export const LINHA_MATERIAL_ILEGIVEL_E2E = {
  channelId: 'e2e40000-0000-4000-8000-000000000002',
  externalId: '+5511990000002',
} as const;

function urlDoBanco(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL ausente no processo do Playwright. As jornadas restauram ' +
        'o estado das fixtures antes de mutar; sem banco elas mediriam o que ' +
        'a execução anterior deixou para trás.',
    );
  }
  return url;
}

async function comCliente<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const cliente = new pg.Client({ connectionString: urlDoBanco() });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end();
  }
}

/**
 * Devolve as propostas ao estado semeado: pendentes, sem aprovação e sem
 * trilha. Idempotente e barata (três DELETE/UPDATE por id).
 */
export async function restaurarPropostas(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await comCliente(async (c) => {
    await c.query(`DELETE FROM proposal_approvals WHERE proposal_id = ANY($1::uuid[])`, [ids]);
    await c.query(
      `DELETE FROM admin_audit_log WHERE tenant_id = $1 AND resource_id = ANY($2::text[])`,
      [TENANT_E2E, ids],
    );
    await c.query(
      `UPDATE capability_proposals
          SET status = 'submitted',
              decided_at = NULL,
              decided_by = NULL,
              decision_reason = NULL
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [TENANT_E2E, ids],
    );
  });
}

/**
 * Devolve a linha ao estado DECLARADO, pelo caminho real.
 *
 * As jornadas de pareamento deixam a linha em `pareando` com uma
 * PairingSession VIVA na memória do runtime. Um `UPDATE ... SET
 * state='declared'` limparia a tabela e deixaria o socket falso vivo: o start
 * seguinte bateria em `pairing_in_progress` dentro de `line-pairing.ts` (o
 * mapa em memória, que o SQL não alcança) e a jornada mediria a colisão.
 *
 * Por isso o cancelamento é ENFILEIRADO como o console o enfileiraria —
 * `abort_pairing`, `command_claimed_at` nulo, sem endereçamento — e este
 * helper ESPERA o runtime confirmar. Quem executa é o worker
 * `channel_pairing`, com a mesma `executeAbort` de produção.
 *
 * Caminho rápido: linha já limpa (declarada, sem comando e sem dono) não paga
 * um tick de 5s.
 */
export async function restaurarLinhaParaDeclarada(
  channelId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const limpa = await comCliente(async (c) => {
    const r = await c.query<{ limpa: boolean }>(
      `SELECT (state = 'declared' AND command IS NULL AND owner_instance IS NULL) AS limpa
         FROM channel_line_state WHERE channel_id = $1::uuid`,
      [channelId],
    );
    return r.rows[0]?.limpa ?? false;
  });
  if (limpa) return;

  await comCliente(async (c) => {
    await c.query(
      `UPDATE channel_line_state
          SET command = 'abort_pairing',
              command_method = NULL,
              command_id = gen_random_uuid(),
              command_requested_at = now(),
              command_claimed_at = NULL,
              target_instance = NULL,
              actor_id = 'e2e-user-owner',
              actor_role = 'owner',
              correlation_id = gen_random_uuid()::text,
              updated_at = now()
        WHERE channel_id = $1::uuid`,
      [channelId],
    );
  });

  const limite = Date.now() + timeoutMs;
  for (;;) {
    const pronta = await comCliente(async (c) => {
      const r = await c.query<{ pronta: boolean }>(
        `SELECT (state = 'declared' AND command IS NULL) AS pronta
           FROM channel_line_state WHERE channel_id = $1::uuid`,
        [channelId],
      );
      return r.rows[0]?.pronta ?? false;
    });
    if (pronta) return;
    if (Date.now() > limite) {
      throw new Error(
        `a linha ${channelId} não voltou para 'declarada' em ${timeoutMs}ms. O ` +
          `worker \`channel_pairing\` do runtime é quem confirma o abort — se ` +
          `ele não está no ar, o job subiu só o console e as jornadas de ` +
          `pareamento não têm o que medir (ver scripts/admin-ui-e2e.sh).`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Coloca a linha em `pareando` com um envelope de material que o console NÃO
 * consegue abrir, e devolve quantos BYTES de material ficaram na tabela.
 *
 * O envelope tem a forma exata do de produção (`src/gateway/staging-crypto.ts`):
 * versão 0x01, `key_id`, nonce de 12B, tag de 16B, ciphertext. O `key_id`
 * aponta uma chave que não está no keyring — é o cenário REAL de uma chave
 * rotacionada e removida enquanto ainda havia row referenciando-a. Nada aqui
 * é "lixo aleatório": bytes inválidos testariam o parser, não a decisão.
 *
 * O número de bytes devolvido é a ANTI-VACUIDADE da jornada: sem ele, "a tela
 * não mostra material" ficaria verde também se a semeadura tivesse falhado e
 * não houvesse material nenhum para recusar.
 *
 * `owner_instance` recebe um dono com LEASE VIVA, e não NULL: o worker
 * `channel_pairing` do runtime varre (`failStalePairings`) todo `pairing` sem
 * dono ou com lease vencida — é assim que ele reconhece a réplica que morreu
 * levando a sessão junto. Com o dono nulo, ele marcaria esta linha `failed` e
 * APAGARIA o material no meio da jornada, e a asserção mediria a varredura em
 * vez da recusa do console. O nome do dono é deliberadamente reconhecível e
 * não é o do runtime do job, cujo heartbeat só renova as leases DELE.
 */
export async function armarMaterialIlegivel(channelId: string): Promise<number> {
  const KEY_ID = 'chave-rotacionada-e-removida';
  const cabecalho = Buffer.from([0x01, KEY_ID.length]);
  const envelope = Buffer.concat([
    cabecalho,
    Buffer.from(KEY_ID, 'utf8'),
    Buffer.alloc(12, 0xa1), // nonce
    Buffer.alloc(16, 0xb2), // tag
    Buffer.alloc(64, 0xc3), // ciphertext
  ]);

  return await comCliente(async (c) => {
    const r = await c.query<{ bytes: number }>(
      `UPDATE channel_line_state
          SET state = 'pairing',
              command = NULL,
              command_method = NULL,
              command_id = NULL,
              command_claimed_at = NULL,
              owner_instance = 'e2e-linha-com-material-ilegivel',
              owner_lease_expires_at = now() + interval '1 hour',
              pairing_method = 'qr',
              pairing_started_at = now(),
              pairing_expires_at = now() + interval '15 minutes',
              pairing_material = $2::bytea,
              pairing_material_key_id = $3,
              pairing_material_kind = 'qr',
              pairing_material_expires_at = now() + interval '15 minutes',
              reason_code = NULL,
              last_transition_at = now(),
              updated_at = now()
        WHERE channel_id = $1::uuid
        RETURNING octet_length(pairing_material) AS bytes`,
      [channelId, envelope, KEY_ID],
    );
    const bytes = r.rows[0]?.bytes;
    if (bytes === undefined) {
      throw new Error(
        `channel_line_state não tem linha para ${channelId} — ` +
          `scripts/seed-admin-ui-e2e-fixtures.ts não semeou a segunda linha.`,
      );
    }
    return bytes;
  });
}

/** Quantos bytes de material CIFRADO a linha guarda agora (0 = nenhum). */
export async function bytesDeMaterialDaLinha(channelId: string): Promise<number> {
  return await comCliente(async (c) => {
    const r = await c.query<{ bytes: number | null }>(
      `SELECT octet_length(pairing_material) AS bytes
         FROM channel_line_state WHERE channel_id = $1::uuid`,
      [channelId],
    );
    return r.rows[0]?.bytes ?? 0;
  });
}

/** Linhas de `admin_audit_log` de UMA proposta — estado final, não delta. */
export async function auditoriaDaProposta(
  proposalId: string,
): Promise<Array<{ action: string; actor_id: string; actor_role: string }>> {
  return await comCliente(async (c) => {
    const r = await c.query<{ action: string; actor_id: string; actor_role: string }>(
      `SELECT action, actor_id, actor_role
         FROM admin_audit_log
        WHERE tenant_id = $1 AND resource_id = $2
        ORDER BY id`,
      [TENANT_E2E, proposalId],
    );
    return r.rows;
  });
}

/** Status atual da proposta na fonte de verdade (`capability_proposals`). */
export async function statusDaProposta(proposalId: string): Promise<string | null> {
  return await comCliente(async (c) => {
    const r = await c.query<{ status: string }>(
      `SELECT status FROM capability_proposals WHERE tenant_id = $1 AND id = $2`,
      [TENANT_E2E, proposalId],
    );
    return r.rows[0]?.status ?? null;
  });
}

/** Aprovações registradas para a proposta (decisão + papel), em ordem. */
export async function aprovacoesDaProposta(
  proposalId: string,
): Promise<Array<{ decision: string; approver_role: string; comment: string | null }>> {
  return await comCliente(async (c) => {
    const r = await c.query<{ decision: string; approver_role: string; comment: string | null }>(
      `SELECT decision, approver_role, comment
         FROM proposal_approvals
        WHERE tenant_id = $1 AND proposal_id = $2
        ORDER BY decided_at, id`,
      [TENANT_E2E, proposalId],
    );
    return r.rows;
  });
}
