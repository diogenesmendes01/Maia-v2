'use client';

import * as React from 'react';
import { formatDate } from '../../../../lib/format.js';

export default function RationalePanel({ proposal }: { proposal: any }) {
  return (
    <section className="bg-gray-50 border rounded p-4">
      <h2 className="font-semibold mb-2">Rationale & Audit Trail</h2>
      {proposal.approvals && proposal.approvals.length > 0 ? (
        <ul className="space-y-2">
          {proposal.approvals.map((a: any) => (
            <li key={a.id} className="text-sm border-l-4 border-blue-300 pl-3">
              <strong className="capitalize">{a.decision}</strong> by{' '}
              <code className="bg-white px-1 rounded">{a.approver_role}</code> at{' '}
              {formatDate(a.decided_at)}
              {a.comment && <p className="text-gray-700 mt-1">{a.comment}</p>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">No prior decisions on this proposal.</p>
      )}
    </section>
  );
}
