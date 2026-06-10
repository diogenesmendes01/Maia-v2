'use client';

import * as React from 'react';
import { Button } from '../../../components/ui/button.js';
import { StatusBadge } from '../../../components/ui/badge.js';
import {
  TableShell,
  Table,
  THead,
  Th,
  Tr,
  Td,
} from '../../../components/ui/table.js';
import {
  isSupportedSotKind,
  validateRollbackTarget,
} from '../../../lib/rollback-targets.js';

export interface VersionItem {
  id: string;
  sot_kind: string;
  sot_id: string;
  version: number;
  status: string;
  // tRPC sobre HTTP serializa Date como string ISO — aceitar ambas as formas.
  created_at: Date | string;
}

export default function VersionsTable({
  versions,
  canRollback,
  activeVersionFor,
  onRollback,
}: {
  versions: VersionItem[];
  canRollback: boolean;
  /** Versão ativa da mesma fonte (origem da reversão), se houver. */
  activeVersionFor: (v: VersionItem) => number | undefined;
  onRollback: (item: VersionItem, fromVersion: number) => void;
}) {
  return (
    <TableShell>
      <Table>
        <THead>
          <Th>SoT</Th>
          <Th>ID do SoT</Th>
          <Th>Versão</Th>
          <Th>Status</Th>
          <Th>Criada em</Th>
          {canRollback && <Th className="text-right">Ações</Th>}
        </THead>
        <tbody>
          {versions.map((v) => {
            const fromVersion = activeVersionFor(v);
            // Alvo válido: existe versão ativa, o alvo é anterior a ela e não
            // é, ele próprio, uma versão revertida (regra de negócio P8.5).
            const rollbackable =
              canRollback &&
              fromVersion !== undefined &&
              v.status !== 'rolled_back' &&
              isSupportedSotKind(v.sot_kind) &&
              validateRollbackTarget(v.sot_kind, fromVersion, v.version);
            return (
              <Tr key={v.id}>
                <Td className="font-mono text-xs text-zinc-700">{v.sot_kind}</Td>
                <Td className="font-mono text-xs text-zinc-700">{v.sot_id}</Td>
                <Td className="tabular-nums">v{v.version}</Td>
                <Td>
                  <StatusBadge status={v.status} />
                </Td>
                <Td className="text-zinc-600">
                  {new Date(v.created_at).toLocaleString('pt-BR')}
                </Td>
                {canRollback && (
                  <Td className="text-right">
                    {rollbackable && fromVersion !== undefined && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => onRollback(v, fromVersion)}
                      >
                        Reverter
                      </Button>
                    )}
                  </Td>
                )}
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableShell>
  );
}
