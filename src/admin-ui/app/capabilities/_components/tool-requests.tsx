'use client';

import * as React from 'react';
import { trpc } from '../../../trpc/client.js';
import { Card, CardHeader, CardBody } from '../../../components/ui/card.js';
import { Badge, StatusBadge } from '../../../components/ui/badge.js';
import {
  Alert,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../components/ui/states.js';
import { IconWrench } from '../../../components/ui/icons.js';

/**
 * Pedidos de ferramenta (issue #471 — v1, fatia de console).
 *
 * O agente já registra lacunas `tipo='tool'` em agent_capability_gaps
 * (aquisição dialógica, escalação silent→dashboard→mentionable→proposed,
 * frequency_score como contador de recorrência). Esta visão transforma
 * essas lacunas em backlog acionável: o owner triagia e gera uma issue de
 * GitHub pré-preenchida — com contexto, frequência e o esqueleto do
 * contrato Zod — para o time de desenvolvimento.
 *
 * Guardrail (spec da visão §2.2): o agente ESPECIFICA; humano implementa e
 * instala. O fechamento automático do ciclo (aceite → issue via API → gap
 * fecha quando a tool é registrada) é a v2 da issue #471.
 */

// Repositório alvo das issues geradas. Constante deliberada: o console é
// single-repo hoje; quando houver multi-repo, isto vira configuração.
const GITHUB_NEW_ISSUE_URL = 'https://github.com/diogenesmendes01/Maia-v2/issues/new';

const LEVEL_ORDER: Record<string, number> = {
  proposed: 0,
  mentionable: 1,
  dashboard: 2,
  silent: 3,
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function buildIssueUrl(gap: {
  capability_description: string;
  contexto: string | null;
  frequency_score: number;
  severity_score: number;
  agent_id?: string;
}): string {
  const toolName = slugify(gap.capability_description) || 'nova_ferramenta';
  const title = `feat(tools): ${gap.capability_description.slice(0, 80)} (pedido do agente)`;
  const body = [
    '## Pedido de ferramenta (originado pelo agente)',
    '',
    `**Capacidade que faltou:** ${gap.capability_description}`,
    `**Frequência observada:** ${gap.frequency_score}x · severidade ${gap.severity_score}`,
    gap.contexto ? `**Contexto registrado:** ${gap.contexto}` : '',
    '',
    '## Esqueleto do contrato (preencher na implementação)',
    '',
    '```ts',
    `export const ${toolName}Tool: Tool<typeof inputSchema, typeof outputSchema> = {`,
    `  name: '${toolName}',`,
    `  // TODO: inputSchema/outputSchema Zod; classe de risco; idempotência;`,
    `  // pack de destino (grant-math.ts) — nunca baseline.`,
    `  handler: async (args) => { /* ... */ },`,
    '};',
    '```',
    '',
    '## Checklist de governança',
    '',
    '- [ ] Contrato Zod + chave de idempotência',
    '- [ ] Classe de risco definida (capability-risk)',
    '- [ ] Adicionada a um pack de domínio (não à baseline)',
    '- [ ] Registrada no tool registry + testes',
    '',
    '_Gerado pela visão "Pedidos de ferramenta" do console (issue #471 v1)._',
  ]
    .filter((l) => l !== '')
    .join('\n');
  const params = new URLSearchParams({ title, body, labels: 'enhancement,tools' });
  return `${GITHUB_NEW_ISSUE_URL}?${params.toString()}`;
}

export default function ToolRequests({
  tenantId,
  agentId,
}: {
  tenantId: string;
  agentId: string;
}) {
  const gapsQuery = trpc.capabilities.listGaps.useQuery(
    {
      tenantId,
      agentId,
      levels: ['silent', 'dashboard', 'mentionable', 'proposed'],
    },
    { enabled: tenantId !== '' && agentId !== '' },
  );

  if (gapsQuery.isLoading) return <LoadingState label="Carregando pedidos…" />;
  if (gapsQuery.error)
    return (
      <ErrorState
        message={gapsQuery.error.message}
        onRetry={() => void gapsQuery.refetch()}
      />
    );

  const toolGaps = (gapsQuery.data?.items ?? [])
    .filter((g) => g.tipo === 'tool')
    .sort(
      (a, b) =>
        b.frequency_score - a.frequency_score ||
        (LEVEL_ORDER[a.current_level] ?? 9) - (LEVEL_ORDER[b.current_level] ?? 9),
    );

  return (
    <div className="space-y-4">
      <Alert tone="info">
        Quando o agente percebe que precisaria de uma ferramenta que não existe,
        a lacuna fica registrada aqui com a frequência de recorrência. Triagie e{' '}
        <strong>gere a issue</strong> para o time de desenvolvimento — o agente
        especifica, humanos implementam e instalam (toda tool nova passa por
        contrato Zod, classe de risco e revisão).
      </Alert>

      {toolGaps.length === 0 ? (
        <EmptyState
          icon={<IconWrench size={32} />}
          title="Nenhum pedido de ferramenta"
          description="O agente ainda não registrou lacunas do tipo 'tool'. Elas aparecem aqui conforme ele esbarra em limites durante conversas reais."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {toolGaps.map((gap) => (
            <Card key={gap.id}>
              <CardHeader
                title={gap.capability_description}
                description={gap.contexto ?? undefined}
                actions={<StatusBadge status={gap.current_level} />}
              />
              <CardBody className="flex flex-wrap items-center justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <Badge tone={gap.frequency_score >= 5 ? 'warning' : 'neutral'}>
                    {gap.frequency_score}x observado
                  </Badge>
                  <Badge tone="neutral">severidade {gap.severity_score}</Badge>
                </span>
                <a
                  href={buildIssueUrl(gap)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-medium text-white shadow-sm transition-colors hover:bg-brand-700"
                >
                  <IconWrench size={13} />
                  Gerar issue no GitHub
                </a>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
