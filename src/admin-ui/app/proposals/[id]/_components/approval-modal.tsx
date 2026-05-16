'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';

interface Props {
  proposal: any;
  decision: 'approve' | 'reject';
  tenantId: string;
  onClose: () => void;
}

export default function ApprovalModal({ proposal, decision, tenantId, onClose }: Props) {
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const approveMutation = trpc.proposals.approve.useMutation();
  const rejectMutation = trpc.proposals.reject.useMutation();
  const mutation = decision === 'approve' ? approveMutation : rejectMutation;

  const handleSubmit = async () => {
    setError(null);
    if (comment.trim().length < 10) {
      setError('Comment must be at least 10 characters.');
      return;
    }
    try {
      await mutation.mutateAsync({
        id: proposal.id,
        tenantId,
        comment,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded shadow-lg w-[480px] max-w-full">
        <h2 className="text-lg font-bold mb-2 capitalize">{decision} proposal?</h2>
        <p className="text-sm text-gray-600 mb-3">
          <strong>{proposal.descriptor}</strong> ({proposal.type}, risk={proposal.risk})
        </p>
        {decision === 'approve' && proposal.requires_dual && (
          <p className="text-xs bg-blue-50 p-2 rounded mb-2">
            Dual approval required. After your approval, {proposal.required_roles.length - 1} more
            distinct approver(s) needed before activation.
          </p>
        )}
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={`Why ${decision}? (min 10 chars)`}
          rows={5}
          className="w-full p-2 border rounded mb-2 text-sm"
        />
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={mutation.isPending}
            className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={mutation.isPending}
            className={`px-4 py-2 text-white rounded disabled:opacity-50 ${
              decision === 'approve' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            {mutation.isPending ? 'Recording...' : `Confirm ${decision}`}
          </button>
        </div>
      </div>
    </div>
  );
}
