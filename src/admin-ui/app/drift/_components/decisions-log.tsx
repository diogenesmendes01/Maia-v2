'use client';

import * as React from 'react';
import { StatusBadge } from '../../../components/ui/badge.js';
import {
  TableShell,
  Table,
  THead,
  Th,
  Tr,
  Td,
} from '../../../components/ui/table.js';
import { EmptyState } from '../../../components/ui/states.js';
import { IconAlertTriangle } from '../../../components/ui/icons.js';

interface DriftItem {
  id: string;
  drift_type: string;
  severity: string;
  decision: string | null;
  // tRPC sobre HTTP serializa Date como string ISO — aceitar ambas as formas.
  detected_at: Date | string;
}

export default function DecisionsLog({ items }: { items: DriftItem[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<IconAlertTriangle size={28} />}
        title="Nenhum alerta de drift"
        description="Detector quiescente — nenhum desvio de comportamento registrado."
      />
    );
  }
  return (
    <TableShell>
      <Table>
        <THead>
          <Th>Tipo de drift</Th>
          <Th>Severidade</Th>
          <Th>Decisão</Th>
          <Th>Detectado em</Th>
        </THead>
        <tbody>
          {items.map((d) => (
            <Tr key={d.id}>
              <Td className="font-mono text-xs text-zinc-700">{d.drift_type}</Td>
              <Td>
                <StatusBadge status={d.severity} />
              </Td>
              <Td className="capitalize">{d.decision ?? 'pendente'}</Td>
              <Td className="text-zinc-600">
                {new Date(d.detected_at).toLocaleString('pt-BR')}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableShell>
  );
}
