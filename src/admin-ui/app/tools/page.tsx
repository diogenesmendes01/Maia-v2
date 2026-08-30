'use client';

/**
 * Admin UI — catálogo de Ferramentas (somente leitura).
 *
 * Exibe toda ferramenta que o LLM pode chamar: descrição, efeito colateral,
 * se está habilitada (e qual feature flag a controla quando desligada), se é
 * `sensitive` (saídas de visualização única, ex. saldos) e seus campos de
 * entrada. Responde a pergunta do operador: "o que a Maia pode fazer, e como?".
 *
 * Fronteira server-only (spec §1.2): esta página NÃO importa nada de
 * `@/tools/*`. Consome apenas o JSON serializado de
 * `trpc.toolsCatalog.listCatalog` — os handlers (e seus imports de DB / LLM)
 * ficam no servidor. Não adicione import direto do registry aqui.
 */

import * as React from 'react';
import { trpc } from '../../trpc/client.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardBody } from '../../components/ui/card.js';
import { Field, Input, Select } from '../../components/ui/field.js';
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from '../../components/ui/states.js';
import { IconWrench } from '../../components/ui/icons.js';

type SideEffect = 'read' | 'write' | 'communication' | 'none';

// Leitura primeiro (spec §1.4): read → write → communication → none.
const SIDE_EFFECT_ORDER: SideEffect[] = ['read', 'write', 'communication', 'none'];

const SIDE_EFFECT_LABEL: Record<SideEffect, string> = {
  read: 'Leitura',
  write: 'Escrita',
  communication: 'Comunicação',
  none: 'Sem efeito colateral',
};

type CatalogTool = {
  name: string;
  description: string;
  side_effect: string;
  operation_type: string;
  sensitive: boolean;
  feature_flag: string | null;
  required_actions: string[];
  enabled: boolean;
  inputs: Array<{ name: string; type: string; optional: boolean }>;
};

export default function ToolsCatalogPage() {
  const q = trpc.toolsCatalog.listCatalog.useQuery();

  const [search, setSearch] = React.useState('');
  const [sideEffectFilter, setSideEffectFilter] = React.useState<'all' | SideEffect>('all');
  const [enabledOnly, setEnabledOnly] = React.useState(false);
  const [sensitiveOnly, setSensitiveOnly] = React.useState(false);

  const tools = (q.data ?? []) as CatalogTool[];

  const filtered = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tools.filter((t) => {
      if (enabledOnly && !t.enabled) return false;
      if (sensitiveOnly && !t.sensitive) return false;
      if (sideEffectFilter !== 'all' && t.side_effect !== sideEffectFilter) return false;
      if (needle !== '') {
        const haystack = `${t.name} ${t.description}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [tools, search, sideEffectFilter, enabledOnly, sensitiveOnly]);

  // Agrupa as ferramentas filtradas por side_effect, preservando a ordem
  // "leitura primeiro".
  const groups = React.useMemo(() => {
    const byEffect = new Map<string, CatalogTool[]>();
    for (const t of filtered) {
      const list = byEffect.get(t.side_effect) ?? [];
      list.push(t);
      byEffect.set(t.side_effect, list);
    }
    const ordered: Array<{ key: string; label: string; items: CatalogTool[] }> = [];
    for (const key of SIDE_EFFECT_ORDER) {
      const items = byEffect.get(key);
      if (items && items.length > 0) {
        ordered.push({ key, label: SIDE_EFFECT_LABEL[key], items });
        byEffect.delete(key);
      }
    }
    // Qualquer side_effect fora do conjunto conhecido (defensivo) vai ao final.
    for (const [key, items] of byEffect.entries()) {
      ordered.push({ key, label: key, items });
    }
    return ordered;
  }, [filtered]);

  return (
    <div>
      <PageHeader
        title="Ferramentas"
        description={
          <>
            Catálogo somente leitura de toda ferramenta que o agente pode chamar.
            Ferramentas são definidas em código e globais (não escopadas por
            tenant). Uma ferramenta controlada por feature flag desligada aparece
            como <span className="font-medium">desabilitada</span>, com a flag que
            a liga.
          </>
        }
      />

      {q.isLoading ? (
        <LoadingState label="Carregando ferramentas…" />
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : tools.length === 0 ? (
        <EmptyState
          icon={<IconWrench size={36} />}
          title="Nenhuma ferramenta registrada"
        />
      ) : (
        <div className="space-y-6">
          <Card>
            <CardBody className="flex flex-wrap items-end gap-4">
              <Field label="Buscar" className="w-64">
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Nome ou descrição…"
                  aria-label="Buscar ferramentas"
                />
              </Field>
              <Field label="Efeito colateral" className="w-52">
                <Select
                  value={sideEffectFilter}
                  onChange={(e) =>
                    setSideEffectFilter(e.target.value as 'all' | SideEffect)
                  }
                >
                  <option value="all">Todos</option>
                  {SIDE_EFFECT_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {SIDE_EFFECT_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              <label className="flex h-9 items-center gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={enabledOnly}
                  onChange={(e) => setEnabledOnly(e.target.checked)}
                  className="h-4 w-4 rounded-sm border-zinc-300 text-brand-600 focus:ring-brand-500"
                />
                Somente habilitadas
              </label>
              <label className="flex h-9 items-center gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={sensitiveOnly}
                  onChange={(e) => setSensitiveOnly(e.target.checked)}
                  className="h-4 w-4 rounded-sm border-zinc-300 text-brand-600 focus:ring-brand-500"
                />
                Somente sensíveis
              </label>
              <span className="flex h-9 items-center text-xs text-zinc-500">
                {filtered.length} de {tools.length} ferramenta(s)
              </span>
            </CardBody>
          </Card>

          {filtered.length === 0 ? (
            <EmptyState
              icon={<IconWrench size={36} />}
              title="Nenhuma ferramenta corresponde aos filtros"
            />
          ) : (
            <div className="space-y-8">
              {groups.map((group) => (
                <section key={group.key} className="space-y-3">
                  <h2 className="flex items-baseline gap-2 border-b border-zinc-200 pb-2 text-base font-semibold text-zinc-900">
                    {group.label}
                    <span className="text-xs font-normal text-zinc-500">
                      ({group.items.length})
                    </span>
                  </h2>
                  <div className="space-y-3">
                    {group.items.map((t) => (
                      <ToolCard key={t.name} tool={t} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCard({ tool }: { tool: CatalogTool }) {
  return (
    <Card>
      <CardBody className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-sm font-semibold text-zinc-900">
            {tool.name}
          </code>
          <Badge tone="neutral">{tool.side_effect}</Badge>
          {tool.enabled ? (
            <Badge tone="success">habilitada</Badge>
          ) : (
            <Badge tone="neutral">
              {tool.feature_flag
                ? `desabilitada — ${tool.feature_flag}`
                : 'desabilitada'}
            </Badge>
          )}
          {tool.sensitive && <Badge tone="warning">sensível</Badge>}
        </div>

        <p className="text-sm leading-relaxed text-zinc-700">{tool.description}</p>

        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-700">
            Entradas ({tool.inputs.length})
          </summary>
          {tool.inputs.length === 0 ? (
            <p className="mt-2 pl-4 text-xs text-zinc-500">
              Nenhum campo de entrada.
            </p>
          ) : (
            <ul className="mt-2 space-y-1 border-l-2 border-zinc-200 pl-4">
              {tool.inputs.map((field) => (
                <li key={field.name} className="text-xs">
                  <code className="font-mono font-medium text-zinc-800">
                    {field.name}
                  </code>{' '}
                  <span className="text-zinc-500">· {field.type}</span>
                  {field.optional ? (
                    <span className="text-zinc-400"> · opcional</span>
                  ) : (
                    <span className="text-zinc-600"> · obrigatório</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </details>
      </CardBody>
    </Card>
  );
}
