'use client';

import * as React from 'react';
import { formatDate } from '../../../lib/format.js';

interface VersionItem {
  id: string;
  sot_kind: string;
  sot_id: string;
  version: number;
  status: string;
  created_at: Date;
}

export default function VersionsTable({ versions }: { versions: VersionItem[] }) {
  if (versions.length === 0) {
    return (
      <div className="border-2 border-dashed border-gray-300 p-8 text-center text-gray-500 rounded">
        No versions to display. Once P8a-e and P4 versioned objects exist, they appear here.
      </div>
    );
  }
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b-2 border-gray-300 bg-gray-50">
          <th className="p-2 text-left">SoT</th>
          <th className="p-2 text-left">SoT ID</th>
          <th className="p-2 text-left">Version</th>
          <th className="p-2 text-left">Status</th>
          <th className="p-2 text-left">Created</th>
        </tr>
      </thead>
      <tbody>
        {versions.map((v) => (
          <tr key={v.id} className="border-b">
            <td className="p-2"><code>{v.sot_kind}</code></td>
            <td className="p-2 font-mono text-xs">{v.sot_id}</td>
            <td className="p-2">v{v.version}</td>
            <td className="p-2 capitalize">{v.status}</td>
            <td className="p-2">{formatDate(v.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
