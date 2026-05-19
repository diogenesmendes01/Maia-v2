'use client';

import * as React from 'react';
import { formatDate } from '../../../lib/format.js';

interface DriftItem {
  id: string;
  drift_type: string;
  severity: string;
  decision: string | null;
  detected_at: Date;
}

const SEVERITY_CLASS: Record<string, string> = {
  low: 'bg-green-100 text-green-800',
  medium: 'bg-yellow-100 text-yellow-800',
  high: 'bg-orange-100 text-orange-800',
  critical: 'bg-red-100 text-red-800',
};

export default function DecisionsLog({ items }: { items: DriftItem[] }) {
  if (items.length === 0) {
    return (
      <div className="border-2 border-dashed border-gray-300 p-6 text-center text-gray-500 rounded">
        No drift alerts. Detector quiescent.
      </div>
    );
  }
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b-2 border-gray-300 bg-gray-50">
          <th className="p-2 text-left">Drift type</th>
          <th className="p-2 text-left">Severity</th>
          <th className="p-2 text-left">Decision</th>
          <th className="p-2 text-left">Detected</th>
        </tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={d.id} className="border-b">
            <td className="p-2"><code>{d.drift_type}</code></td>
            <td className="p-2">
              <span
                className={`px-2 py-0.5 rounded text-xs ${
                  SEVERITY_CLASS[d.severity] ?? 'bg-gray-100'
                }`}
              >
                {d.severity}
              </span>
            </td>
            <td className="p-2 capitalize">{d.decision ?? 'pending'}</td>
            <td className="p-2">{formatDate(d.detected_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
