'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import ProposalHeader from './_components/proposal-header.js';
import DiffRenderer from './_components/diff-renderer.js';
import ApprovalModal from './_components/approval-modal.js';
import ArchitectureLockBanner from './_components/architecture-lock-banner.js';
import RationalePanel from './_components/rationale-panel.js';
import ImpactedArtifactsList from './_components/impacted-artifacts-list.js';

export default function ProposalDetailPage({ params }: { params: { id: string } }) {
  const { data: session } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';
  const userRole = session?.user?.role ?? 'viewer';

  const [showApprovalModal, setShowApprovalModal] = React.useState<'approve' | 'reject' | null>(
    null,
  );

  const proposalQuery = trpc.proposals.getProposal.useQuery(
    { id: params.id, tenantId },
    { enabled: tenantId !== '' },
  );

  if (!tenantId) return <p>Loading session...</p>;
  if (proposalQuery.isLoading) return <p>Loading proposal...</p>;
  if (proposalQuery.error) return <p className="text-red-600">{proposalQuery.error.message}</p>;
  if (!proposalQuery.data) return <p>Proposal not found.</p>;

  const proposal = proposalQuery.data;
  const lockBlocked = proposal.locks.length > 0 && userRole !== 'founder';
  const canApprove = proposal.required_roles.includes(userRole) && !lockBlocked;

  return (
    <div className="space-y-6">
      <ProposalHeader proposal={proposal} />

      {proposal.locks.length > 0 && (
        <ArchitectureLockBanner locks={proposal.locks} canBypass={userRole === 'founder'} />
      )}

      {proposal.requires_dual && (
        <div className="bg-blue-50 border border-blue-300 p-3 rounded text-sm">
          <strong>Dual approval required:</strong> {proposal.required_roles.join(' + ')}.{' '}
          {proposal.approvals.length > 0 && (
            <span>
              {proposal.approvals.length} of {proposal.required_roles.length} approvals recorded.
            </span>
          )}
        </div>
      )}

      <DiffRenderer proposal={proposal} />
      <RationalePanel proposal={proposal} />
      <ImpactedArtifactsList proposal={proposal} />

      <div className="flex gap-3 sticky bottom-4">
        <button
          onClick={() => setShowApprovalModal('approve')}
          disabled={!canApprove}
          className="bg-green-600 text-white px-6 py-2 rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Approve
        </button>
        <button
          onClick={() => setShowApprovalModal('reject')}
          disabled={!canApprove}
          className="bg-red-600 text-white px-6 py-2 rounded hover:bg-red-700 disabled:opacity-50"
        >
          Reject
        </button>
        {!canApprove && (
          <span className="text-sm text-gray-600 self-center">
            {lockBlocked
              ? 'Locked proposals require founder role.'
              : `Your role (${userRole}) cannot decide this approval class.`}
          </span>
        )}
      </div>

      {showApprovalModal && (
        <ApprovalModal
          proposal={proposal}
          decision={showApprovalModal}
          tenantId={tenantId}
          onClose={() => {
            setShowApprovalModal(null);
            void proposalQuery.refetch();
          }}
        />
      )}
    </div>
  );
}
