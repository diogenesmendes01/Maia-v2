'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { ProposalRow } from '../../../trpc/types.js';
import { formatRelativeAge } from '../../../lib/format.js';
import { TableShell, Table, THead, Th, Tr, Td } from '../../../components/ui/table.js';
import { StatusBadge } from '../../../components/ui/badge.js';
import { EmptyState } from '../../../components/ui/states.js';
import { IconInbox, IconChevronRight } from '../../../components/ui/icons.js';
import { TYPE_LABELS } from './labels.js';

interface Props {
  proposals: ProposalRow[];
  /** Whether the current role may bulk-reject (shows the checkbox column). */
  selectable: boolean;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
}

/**
 * Fila de propostas pendentes. Clique na linha abre o detalhe; o checkbox
 * (apenas para papéis com permissão de rejeição em massa) seleciona para a
 * barra de ação em lote.
 */
export default function InboxTable({
  proposals,
  selectable,
  selectedIds,
  onSelectionChange,
}: Props) {
  const router = useRouter();

  const allSelected = proposals.length > 0 && selectedIds.length === proposals.length;
  const toggleAll = () => {
    onSelectionChange(allSelected ? [] : proposals.map((p) => p.id));
  };
  const toggleOne = (id: string) => {
    if (selectedIds.includes(id)) {
      onSelectionChange(selectedIds.filter((x) => x !== id));
    } else {
      onSelectionChange([...selectedIds, id]);
    }
  };

  if (proposals.length === 0) {
    return (
      <EmptyState
        icon={<IconInbox size={36} />}
        title="Nenhuma proposta pendente"
        description="Caixa de entrada zerada. Novas propostas dos agentes aparecem aqui assim que forem submetidas para revisão."
      />
    );
  }

  return (
    <TableShell>
      <Table>
        <THead>
          {selectable && (
            <Th className="w-10">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                aria-label="Selecionar todas"
                className="h-4 w-4 rounded border-zinc-300 text-brand-600 focus:ring-brand-500"
              />
            </Th>
          )}
          <Th>Proposta</Th>
          <Th>Tipo</Th>
          <Th>Risco</Th>
          <Th>Agente</Th>
          <Th>Origem</Th>
          <Th>Idade</Th>
          <Th>Status</Th>
          <Th className="w-8" aria-label="Abrir" />
        </THead>
        <tbody>
          {proposals.map((p) => (
            <Tr
              key={p.id}
              onClick={() => router.push(`/proposals/${p.id}`)}
              className="cursor-pointer"
            >
              {selectable && (
                <Td onClick={(e) => e.stopPropagation()} className="w-10">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(p.id)}
                    onChange={() => toggleOne(p.id)}
                    aria-label={`Selecionar ${p.descriptor}`}
                    className="h-4 w-4 rounded border-zinc-300 text-brand-600 focus:ring-brand-500"
                  />
                </Td>
              )}
              <Td className="max-w-xs">
                <span className="block truncate font-medium text-zinc-900">
                  {p.descriptor}
                </span>
              </Td>
              <Td className="text-zinc-600">{TYPE_LABELS[p.type]}</Td>
              <Td>
                <StatusBadge status={p.risk} />
              </Td>
              <Td className="font-mono text-xs text-zinc-600">{p.proposed_by}</Td>
              <Td className="font-mono text-xs text-zinc-600">{p.source}</Td>
              <Td
                className="whitespace-nowrap text-zinc-500"
                title={new Date(p.proposed_at).toLocaleString('pt-BR')}
              >
                {formatRelativeAge(p.proposed_at)}
              </Td>
              <Td>
                <StatusBadge status={p.status} />
              </Td>
              <Td className="w-8 text-zinc-300">
                <IconChevronRight size={14} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableShell>
  );
}
