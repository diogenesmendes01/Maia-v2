'use client';

import * as React from 'react';
import DiffPolicyRule from './diff-policy-rule.js';
import DiffSoulBias from './diff-soul-bias.js';
import DiffSkill from './diff-skill.js';
import DiffCapability from './diff-capability.js';
import DiffKnowledge from './diff-knowledge.js';

/**
 * Diff renderer dispatcher. Each proposal type has its own diff component
 * (see proposal-type-registry.ts).
 */
export default function DiffRenderer({ proposal }: { proposal: any }) {
  switch (proposal.type) {
    case 'policy_rule':
      return <DiffPolicyRule body={proposal.body} />;
    case 'soul_bias':
      return <DiffSoulBias body={proposal.body} />;
    case 'skill':
      return <DiffSkill body={proposal.body} />;
    case 'capability_proposal':
      return <DiffCapability body={proposal.body} />;
    case 'knowledge_proposal':
      return <DiffKnowledge body={proposal.body} />;
    default:
      return (
        <div className="bg-yellow-50 border border-yellow-300 p-4 rounded">
          <p className="font-medium">Unknown proposal type: {String(proposal.type)}</p>
          <pre className="text-xs mt-2 overflow-auto">{JSON.stringify(proposal.body, null, 2)}</pre>
        </div>
      );
  }
}
