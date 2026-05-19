'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from '@tanstack/react-table';
import type { ProposalRow } from '../../../trpc/types.js';
import { formatRelativeAge } from '../../../lib/format.js';
import { getDisplayName } from '../../../lib/proposal-type-registry.js';

interface Props {
  proposals: ProposalRow[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
}

const RISK_CLASS: Record<ProposalRow['risk'], string> = {
  low: 'bg-green-100 text-green-800',
  medium: 'bg-yellow-100 text-yellow-800',
  high: 'bg-orange-100 text-orange-800',
  critical: 'bg-red-100 text-red-800',
};

export default function InboxTable({ proposals, selectedIds, onSelectionChange }: Props) {
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

  const columns = React.useMemo<ColumnDef<ProposalRow>[]>(
    () => [
      {
        id: 'select',
        header: () => (
          <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={selectedIds.includes(row.original.id)}
            onChange={() => toggleOne(row.original.id)}
            aria-label={`Select ${row.original.descriptor}`}
          />
        ),
      },
      {
        accessorKey: 'type',
        header: 'Type',
        cell: ({ getValue }) => (
          <span className="font-medium">{getDisplayName(getValue<ProposalRow['type']>())}</span>
        ),
      },
      {
        accessorKey: 'descriptor',
        header: 'Descriptor',
        cell: ({ row }) => (
          <Link
            href={`/proposals/${row.original.id}`}
            className="text-blue-700 hover:underline"
          >
            {row.original.descriptor}
          </Link>
        ),
      },
      {
        accessorKey: 'risk',
        header: 'Risk',
        cell: ({ getValue }) => {
          const r = getValue<ProposalRow['risk']>();
          return (
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${RISK_CLASS[r]}`}>{r}</span>
          );
        },
      },
      { accessorKey: 'source', header: 'Source' },
      {
        accessorKey: 'proposed_at',
        header: 'Age',
        cell: ({ getValue }) => formatRelativeAge(getValue<Date>()),
      },
    ],
    [selectedIds, allSelected, proposals.length],
  );

  const table = useReactTable({
    data: proposals,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (proposals.length === 0) {
    return (
      <div className="border-2 border-dashed border-gray-300 p-8 text-center text-gray-500 rounded">
        No pending proposals. Inbox zero.
      </div>
    );
  }

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id} className="border-b-2 border-gray-300 bg-gray-50">
            {hg.headers.map((h) => (
              <th key={h.id} className="p-2 text-left font-semibold">
                {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id} className="border-b hover:bg-gray-50">
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id} className="p-2">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
