'use client';

import * as React from 'react';

/**
 * Stub: lists artifacts (skills, agents, conversations) that would be
 * affected by activating this proposal. Full impact-graph in P8.5 v1.1.
 */
export default function ImpactedArtifactsList({ proposal }: { proposal: any }) {
  return (
    <section className="bg-white border rounded p-4">
      <h2 className="font-semibold mb-2">Impacted Artifacts</h2>
      <p className="text-sm text-gray-500">
        Impact graph (P8.5 v1.1). Approval class:{' '}
        <code className="bg-gray-100 px-1 rounded">{proposal.approval_class}</code>
      </p>
    </section>
  );
}
