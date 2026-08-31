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
