/**
 * #638 (fatia C da épica #471) — a METADE DE BACKEND da triagem: dois workers
 * que rodam no `runtime`, e não no console.
 *
 *   1. `runToolRequestIssueRelayer` — transforma cada ACEITE reservado em uma
 *      issue no GitHub. É o ÚNICO lugar do projeto que usa a credencial.
 *   2. `runToolRequestClosureMonitor` — fecha os gaps cuja ferramenta passou a
 *      existir E a estar concedida, e avisa o agente.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE O CONSOLE NÃO FALA COM O GITHUB
 * ─────────────────────────────────────────────────────────────────────────────
 * O critério da issue #638 é "credencial do GitHub não vaza para o payload da
 * proposta nem para log". A forma mais forte de garantir isso não é cuidado ao
 * escrever log: é o token NÃO EXISTIR no processo que serve o botão. O
 * contrato de configuração declara `MAIA_TOOL_REQUEST_GITHUB_TOKEN` com
 * `services: ['runtime']`, e o Admin UI valida o PRÓPRIO subset no boot — a
 * variável não está lá, não é lida e não é tipada naquele processo.
 *
 * O preço é uma indireção: aceitar não abre a issue na hora, reserva a linha e
 * o relayer a abre na passada seguinte (até 5 minutos). O ganho é que a
 * separação de credencial é estrutural, e que o aceite fica DURÁVEL — um
 * GitHub fora do ar deixa de ser um erro na cara do dono e vira uma linha na
 * fila.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FAN-OUT POR WORK-TABLE, COMO OS OUTROS WORKERS
 * ─────────────────────────────────────────────────────────────────────────────
 * Nenhum dos dois itera tenants: os dois enumeram exatamente os escopos que
 * TÊM trabalho (linhas `pending`; gaps de tool abertos), e abrem
 * `runWithTenantContext` com o escopo REAL da linha — nunca `agent_id:
 * 'default'`. Mesmo padrão de `#240/#251/#292/#337`. Fail-isolated: um escopo
 * que estoura não derruba os demais.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/client.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { toolRequestIssuesRepo } from '@/db/repositories.js';
import { agent_capability_gaps } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';
import { config } from '@/config/env.js';
import { scrubSecrets } from '@/config/redact.js';
import { garantirIssue, type TransporteHttp } from '@/cognition/tool-request/github-issues.js';
import {
  fecharGapsComFerramentaDisponivel,
  TIPO_DE_GAP,
} from '@/cognition/tool-request/closure.js';

/** Quantos aceites por passada. Cota de API do GitHub é finita e compartilhada. */
const LOTE_DO_RELAYER = 20;

/**
 * O relayer: cada linha `pending` de `tool_request_issues` vira uma issue.
 *
 * `transporte` existe para o teste exercitar ESTE caminho de produção com uma
 * rede falsa, em vez de um dublê que espelharia as mesmas decisões noutro
 * arquivo. Em produção o parâmetro não é passado e vale o `fetch` global.
 */
export async function runToolRequestIssueRelayer(opts?: {
  transporte?: TransporteHttp;
}): Promise<{ processados: number; criadas: number; adotadas: number; falhas: number }> {
  const repoConfigurado = config.MAIA_TOOL_REQUEST_ISSUE_REPO;
  const token = config.MAIA_TOOL_REQUEST_GITHUB_TOKEN;
  if (!token || !repoConfigurado) {
    // Sem credencial ou sem destino não há o que relayar. Não é erro: é uma
    // instalação que não ligou a integração. As linhas ficam `pending` e saem
    // assim que a configuração existir — nada é perdido e nada é inventado.
    logger.debug(
      { tem_token: Boolean(token), tem_repo: Boolean(repoConfigurado) },
      'tool_request.relayer_desligado',
    );
    return { processados: 0, criadas: 0, adotadas: 0, falhas: 0 };
  }

  const pendentes = await toolRequestIssuesRepo.listarPendentesCrossTenant(LOTE_DO_RELAYER);
  let criadas = 0;
  let adotadas = 0;
  let falhas = 0;

  for (const linha of pendentes) {
    try {
      await runWithTenantContext(
        { tenant_id: linha.tenant_id, agent_id: linha.agent_id },
        async () => {
          const resultado = await garantirIssue(
            { repo_slug: linha.repo_slug, token, transporte: opts?.transporte },
            {
              idempotency_key: linha.idempotency_key,
              title: linha.title,
              // O corpo COMO O DONO ACEITOU. O relayer não remonta a spec.
              body: linha.body,
            },
          );

          if (resultado.ok) {
            await toolRequestIssuesRepo.registrarResultado({
              id: linha.id,
              status: 'created',
              issue_number: resultado.issue_number,
              issue_url: resultado.issue_url,
              adopted: resultado.adotada,
            });
            if (resultado.adotada) adotadas += 1;
            else criadas += 1;
            await audit({
              acao: 'tool_request_issue_created',
              entidade_alvo: 'tool_request_issues',
              alvo_id: linha.id,
              metadata: {
                aggregate_id: linha.aggregate_id,
                repo_slug: linha.repo_slug,
                issue_number: resultado.issue_number,
                issue_url: resultado.issue_url,
                adopted: resultado.adotada,
                idempotency_key: linha.idempotency_key,
                instalou_tool: false,
                concedeu_capability: false,
              },
            });
            return;
          }

          // Defesa em profundidade: o cliente é escrito para nunca interpolar
          // a credencial num erro, mas um erro de terceiro pode ecoar a
          // requisição inteira. `scrubSecrets` é o mesmo raspador canônico do
          // resto da configuração.
          //
          // O mapa é montado A PARTIR DO SINGLETON de config, e não de
          // `process.env` — o contrato #515 proíbe ler o ambiente direto, e a
          // proibição é bem-vinda aqui: passar `process.env` inteiro daria a
          // esta linha acesso a todo segredo do processo para raspar um erro de
          // rede. Só o token que ESTE worker usa entra.
          const erro = scrubSecrets(resultado.erro, {
            MAIA_TOOL_REQUEST_GITHUB_TOKEN: token,
          });
          if (resultado.terminal) {
            falhas += 1;
            await toolRequestIssuesRepo.registrarResultado({
              id: linha.id,
              status: 'failed',
              last_error: erro,
            });
            await audit({
              acao: 'tool_request_issue_failed',
              entidade_alvo: 'tool_request_issues',
              alvo_id: linha.id,
              metadata: {
                aggregate_id: linha.aggregate_id,
                repo_slug: linha.repo_slug,
                erro,
                terminal: true,
              },
            });
            logger.error({ issue_row_id: linha.id, erro }, 'tool_request.issue_falhou');
            return;
          }

          // Recuperável: conta a tentativa, guarda o erro, e a linha continua
          // na fila. NÃO auditar aqui é deliberado — auditar cada retentativa
          // de um 500 transitório transformaria a auditoria em log de rede.
          falhas += 1;
          await toolRequestIssuesRepo.registrarTentativaFalha({ id: linha.id, last_error: erro });
          logger.warn({ issue_row_id: linha.id, erro }, 'tool_request.issue_retentavel');
        },
      );
    } catch (e) {
      falhas += 1;
      logger.error(
        {
          issue_row_id: linha.id,
          err: scrubSecrets(e instanceof Error ? e.message : String(e), {
            MAIA_TOOL_REQUEST_GITHUB_TOKEN: token,
          }),
        },
        'tool_request.relayer_erro',
      );
    }
  }

  return { processados: pendentes.length, criadas, adotadas, falhas };
}

/**
 * Os escopos que têm gap de tool ABERTO. Roda FORA de contexto de tenant — é o
 * dispatcher que decide onde entrar.
 */
async function escoposComGapDeToolAberto(): Promise<
  Array<{ tenant_id: string; agent_id: string }>
> {
  return db
    .selectDistinct({
      tenant_id: agent_capability_gaps.tenant_id,
      agent_id: agent_capability_gaps.agent_id,
    })
    .from(agent_capability_gaps)
    .where(
      and(
        eq(agent_capability_gaps.tipo, TIPO_DE_GAP),
        isNull(agent_capability_gaps.resolved_at),
      ),
    );
}

/**
 * O monitor de fechamento: para cada escopo com gap de tool aberto, fecha os
 * que já têm ferramenta disponível e avisa o agente.
 *
 * De hora em hora, e não a cada minuto: o fato que ele observa (uma tool nova
 * concedida a um agente) muda em escala de deploy, não de segundo.
 */
export async function runToolRequestClosureMonitor(): Promise<{
  escopos: number;
  fechados: number;
  avisados: number;
}> {
  const escopos = await escoposComGapDeToolAberto();
  let fechados = 0;
  let avisados = 0;

  for (const escopo of escopos) {
    try {
      const r = await runWithTenantContext(escopo, () => fecharGapsComFerramentaDisponivel());
      fechados += r.fechados;
      avisados += r.avisados;
    } catch (e) {
      // Fail-isolated por escopo: um tenant com dado torto não impede os
      // outros de fecharem o ciclo.
      logger.error(
        { ...escopo, err: e instanceof Error ? e.message : String(e) },
        'tool_request.closure_erro',
      );
    }
  }

  if (fechados > 0 || avisados > 0) {
    logger.info({ escopos: escopos.length, fechados, avisados }, 'tool_request.closure_passada');
  }
  return { escopos: escopos.length, fechados, avisados };
}
