'use client';

import * as React from 'react';

interface Props {
  locks: string[];
  canBypass: boolean;
}

export default function ArchitectureLockBanner({ locks, canBypass }: Props) {
  return (
    <div
      className={`p-4 rounded border-2 ${
        canBypass ? 'bg-amber-50 border-amber-400' : 'bg-red-50 border-red-400'
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="text-xl" aria-hidden>
          {canBypass ? 'ALERT' : 'BLOCKED'}
        </span>
        <div>
          <p className="font-semibold">
            {canBypass
              ? 'Architecture lock — proceed with founder authority'
              : 'Architecture lock — founder approval required'}
          </p>
          <p className="text-sm mt-1">
            This proposal touches {locks.length} architecture lock(s):
          </p>
          <ul className="text-sm list-disc list-inside mt-1">
            {locks.map((lock) => (
              <li key={lock}>
                <code className="bg-white px-1 rounded">{lock}</code>
              </li>
            ))}
          </ul>
          {!canBypass && (
            <p className="text-xs mt-2 text-red-700">
              Approve/reject buttons disabled. Escalate to a user with role=founder.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
