/**
 * #638 (fatia C da épica #471) — a TRIAGEM de pedidos de ferramenta no console.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESTE ROUTER NÃO DECIDE NADA. ELE MOSTRA O QUE O BACKEND JÁ DECIDIU.
 * ─────────────────────────────────────────────────────────────────────────────
 * O console deste projeto tem histórico de duplicar lógica de backend (o
 * dashboard calcula readiness por conta própria em vez de ler a fonte
 * canônica). Aqui isso é proibido explicitamente:
 *
 *   · a SIMILARIDADE não é recalculada — o agrupamento, o contador e o estado
 *     do contrato saem de `tool_request_aggregates`, escritos pela fatia B;
 *   · o RASCUNHO de contrato não é re-derivado — vem de
 *     `merged_contract_draft` (ou dos `contract_conflicts`, quando a fusão
 *     ficou `divergent` e NÃO há contrato);
 *   · o CORPO da issue não é montado no front — ele é montado no aceite, no
 *     backend, e gravado na linha; o que a tela mostra é o texto gravado;
 *   · o FECHAMENTO do gap não é decidido aqui — não existe rota que marque um
 *     gap como resolvido. Quem fecha é o monitor, lendo o estado real da
 *     capability.
 *
 * A prova disso não é este comentário: é
 * `tests/integration/tool-request-triagem-console-real-db.spec.ts`, que quebra
 * o dado NO BANCO e exige que a rota mude junto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O GUARDRAIL, NO ARQUIVO ONDE ELE SERIA QUEBRADO
 * ─────────────────────────────────────────────────────────────────────────────
 * **O agente especifica; humano implementa e instala.** Este é exatamente o
 * lugar onde alguém sentiria a tentação de pôr um botão "aprovar e instalar".
 * Não há. Nenhuma rota daqui registra tool, concede capability ou executa o
 * `zod_source` proposto — e isso é afirmado por um teste arquitetural que
 * varre o GRAFO DE IMPORTS a partir deste arquivo
 * (`tests/integration/tool-request-guardrail-real-db.spec.ts`, bloco do
 * console). Um arquivo novo que este caminho passe a importar entra sozinho na
 * varredura.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A CREDENCIAL DO GITHUB NÃO EXISTE NESTE PROCESSO
 * ─────────────────────────────────────────────────────────────────────────────
 * `aceitar` RESERVA uma linha; quem fala com o GitHub é o relayer do `runtime`.
 * `MAIA_TOOL_REQUEST_GITHUB_TOKEN` é declarado com `services: ['runtime']` no
 * contrato de configuração, e o Admin UI valida o próprio subset no boot — o
 * token não é lido, não é tipado e não existe aqui. O DESTINO
 * (`MAIA_TOOL_REQUEST_ISSUE_REPO`) é lido, porque o dono precisa ver para onde
 * a issue vai antes de aceitar.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { getEnv } from '../../lib/env.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';
import { aceitarPedidoDeFerramenta } from '../../../cognition/tool-request/acceptance.js';
import { destacarDoAgregado } from '../../../cognition/tool-request/aggregation.js';

const EscopoInput = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
});

const AgregadoInput = EscopoInput.extend({
  aggregateId: z.string().uuid(),
});

const DesagruparInput = EscopoInput.extend({
  memberId: z.string().uuid(),
  motivo: z.string().min(3).max(500),
});

export const toolRequestsRouter = router({
  /**
   * A LISTA da triagem: um item por pedido agrupado, com o contador que o
   * backend calculou e o estado do aceite.
   *
   * O `join` entre agregados e aceites é feito aqui, sobre duas leituras
   * escopadas, porque as duas tabelas têm ciclos de vida diferentes (um
   * agregado pode nunca ser aceito; um aceite nunca deixa de existir). O que
   * NÃO é feito aqui é derivar qualquer um dos dois.
   */
  list: protectedProcedure.input(EscopoInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    return runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => {
        const agregados = await ctx.repos.toolRequestAggregatesRepo.listarDoEscopo();
        const aceites = await ctx.repos.toolRequestIssuesRepo.listarDoEscopo();
        const porAgregado = new Map(aceites.map((a) => [a.aggregate_id, a]));

        const items = agregados.map((ag) => {
          const aceite = porAgregado.get(ag.id) ?? null;
          return {
            aggregate_id: ag.id,
            proposed_tool_name: ag.proposed_tool_name,
            nomes_propostos: (ag.nomes_propostos as string[]) ?? [],
            // O CONTADOR. Materializado pelo backend a partir dos membros
            // ativos — o front não conta nada.
            member_count: ag.member_count,
            total_occurrences: ag.total_occurrences,
            contract_state: ag.contract_state,
            // `null` exatamente quando `contract_state = 'divergent'` (CHECK da
            // migração 129). O front mostra os conflitos nesse caso; ele não
            // inventa um contrato de consenso.
            merged_contract_draft: ag.merged_contract_draft,
            contract_conflicts: ag.contract_conflicts,
            metrica: ag.metrica,
            limiar: ag.limiar,
            assinatura_version: ag.assinatura_version,
            first_member_at: ag.first_member_at,
            last_member_at: ag.last_member_at,
            representative_proposal_id: ag.representative_proposal_id,
            aceite: aceite
              ? {
                  status: aceite.status,
                  issue_number: aceite.issue_number,
                  issue_url: aceite.issue_url,
                  repo_slug: aceite.repo_slug,
                  adopted: aceite.adopted,
                  accepted_by: aceite.accepted_by,
                  accepted_at: aceite.accepted_at,
                  attempts: aceite.attempts,
                  last_error: aceite.last_error,
                }
              : null,
          };
        });

        return {
          items,
          // O destino, para que o dono veja para onde a issue vai ANTES de
          // aceitar. `null` = integração não configurada, e o botão diz isso em
          // vez de falhar depois do clique.
          repo_slug: getEnv().MAIA_TOOL_REQUEST_ISSUE_REPO ?? null,
        };
      },
    );
  }),

  /**
   * A EVIDÊNCIA de um pedido: os membros ativos com o spec original inteiro
   * (situações, links de trace, janela de frequência e o rascunho como entrou),
   * e os avisos já emitidos ao agente.
   *
   * É aqui que o texto das situações mora — e é por isso que ele NÃO vai para o
   * corpo da issue: esta rota está atrás de autenticação, uma issue pode ser
   * pública.
   */
  detail: protectedProcedure.input(AgregadoInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    return runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => {
        const agregado = await ctx.repos.toolRequestAggregatesRepo.findById(input.aggregateId);
        if (!agregado) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pedido não encontrado' });
        const membros = await ctx.repos.toolRequestAggregatesRepo.membrosAtivos(agregado.id);
        const avisos = await ctx.repos.toolRequestNotificationsRepo.listarDoEscopo(20);
        return {
          aggregate_id: agregado.id,
          membros: membros.map((m) => ({
            member_id: m.id,
            gap_id: m.gap_id,
            is_representative: m.is_representative,
            intent: m.intent,
            occurrences: m.occurrences,
            similaridade: m.similaridade,
            joined_at: m.joined_at,
            original_spec: m.original_spec,
          })),
          avisos: avisos
            .filter((a) => a.aggregate_id === agregado.id)
            .map((a) => ({
              tool_name: a.tool_name,
              notified_at: a.notified_at,
              evidencia: a.evidencia,
            })),
        };
      },
    );
  }),

  /**
   * ACEITAR: reserva a abertura de UMA issue para este pedido.
   *
   * Duas vezes o mesmo pedido devolve `ja_aceito` e NÃO abre uma segunda
   * issue — a decisão é da UNIQUE do banco, não de um `if` daqui.
   *
   * O que este botão NÃO faz: registrar tool, conceder capability, instalar
   * qualquer coisa, fechar o gap. Tool nova segue o caminho normal.
   */
  aceitar: protectedProcedure.input(AgregadoInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const repoSlug = getEnv().MAIA_TOOL_REQUEST_ISSUE_REPO ?? '';
    if (repoSlug.length === 0) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'MAIA_TOOL_REQUEST_ISSUE_REPO não está configurado — sem destino explícito, ' +
          'nenhuma issue é aberta (efeito externo não tem destino implícito).',
      });
    }

    const resultado = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      () =>
        aceitarPedidoDeFerramenta({
          aggregate_id: input.aggregateId,
          repo_slug: repoSlug,
          accepted_by: ctx.userId,
        }),
    );

    if (!resultado.ok) {
      throw new TRPCError({
        code: resultado.motivo === 'agregado_nao_encontrado' ? 'NOT_FOUND' : 'BAD_REQUEST',
        message: `Aceite recusado: ${resultado.motivo}${resultado.detalhe ? ` — ${resultado.detalhe}` : ''}`,
      });
    }

    // A trilha DO CONSOLE, além da trilha de governança que o backend já
    // escreveu em `audit_log`. As duas respondem perguntas diferentes: "que
    // decisão de governança foi tomada sobre este pedido" (runtime) e "quem
    // clicou, em que tela, e o que aconteceu" (console). Um segundo clique
    // aparece nas duas com o desfecho `ja_aceito` — é a prova de que nenhuma
    // segunda issue foi aberta.
    await ctx.repos.adminAuditLogRepo.append({
      tenant_id: tenantId,
      actor_id: ctx.userId,
      actor_role: ctx.userRole,
      action: 'tool_request_accepted',
      resource_type: 'tool_request_aggregate',
      resource_id: input.aggregateId,
      change_summary: {
        resultado: resultado.resultado,
        repo_slug: repoSlug,
        issue_status: resultado.issue.status,
        issue_number: resultado.issue.issue_number,
        // O console NÃO instala. Dito na própria linha de auditoria.
        instalou_tool: false,
        concedeu_capability: false,
      },
    });

    return {
      resultado: resultado.resultado,
      status: resultado.issue.status,
      issue_number: resultado.issue.issue_number,
      issue_url: resultado.issue.issue_url,
      repo_slug: resultado.issue.repo_slug,
    };
  }),

  /**
   * DESAGRUPAR: tira um pedido do agregado sem apagar a evidência dele.
   *
   * É a ação de triagem REVERSÍVEL — a que existe justamente porque o
   * agrupamento é automático e pode errar. `detached_at` + motivo, nunca
   * `DELETE`: o `original_spec` do membro continua legível, o contador é
   * recalculado a partir dos ativos e a auditoria registra quem desfez e por
   * quê (`tool_request_aggregate_detached`, fatia B).
   *
   * O REPRESENTANTE não pode ser destacado — ele ancora o agregado inteiro. O
   * backend recusa, e a recusa vira erro explícito em vez de um clique sem
   * efeito.
   */
  desagrupar: protectedProcedure.input(DesagruparInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const resultado = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      () =>
        destacarDoAgregado({
          member_id: input.memberId,
          reason: input.motivo,
          by: ctx.userId,
        }),
    );
    if (!resultado.ok) {
      throw new TRPCError({
        code: resultado.reason === 'nao_encontrado' ? 'NOT_FOUND' : 'BAD_REQUEST',
        message: `Desagrupamento recusado: ${resultado.reason}`,
      });
    }
    await ctx.repos.adminAuditLogRepo.append({
      tenant_id: tenantId,
      actor_id: ctx.userId,
      actor_role: ctx.userRole,
      action: 'tool_request_desagrupado',
      resource_type: 'tool_request_aggregate_member',
      resource_id: input.memberId,
      change_summary: {
        aggregate_id: resultado.aggregate_id,
        motivo: input.motivo,
        member_count: resultado.estado.member_count,
        contract_state: resultado.estado.contract_state,
      },
    });

    return {
      aggregate_id: resultado.aggregate_id,
      member_count: resultado.estado.member_count,
      total_occurrences: resultado.estado.total_occurrences,
      contract_state: resultado.estado.contract_state,
    };
  }),
});
