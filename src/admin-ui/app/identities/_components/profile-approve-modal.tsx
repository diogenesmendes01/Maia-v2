'use client';

import * as React from 'react';
import { trpc } from '../../../trpc/client.js';

interface Props {
  tenantId: string;
  target: { versionId: string; agentId: string; version: number };
  onClose: (approved: boolean) => void;
}

export default function ProfileApproveModal({ tenantId, target, onClose }: Props) {
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.agents.approveProfile.useMutation();

  const handleSubmit = async () => {
    setError(null);
    if (comment.trim().length < 10) {
      setError('Comment must be at least 10 characters.');
      return;
    }
    try {
      await mutation.mutateAsync({
        tenantId,
        agentId: target.agentId,
        versionId: target.versionId,
        comment,
      });
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded shadow-lg w-[480px] max-w-full">
        <h2 className="text-lg font-bold mb-2">
          Approve and activate v{target.version}?
        </h2>
        <p className="text-sm text-gray-600 mb-3">
          Agent <code>{target.agentId}</code>: v{target.version} will become
          the agent's <strong>active</strong> operational profile. Any current
          active version will be <strong>frozen</strong> automatically in the
          same transaction. The change is appended to{' '}
          <code>admin_audit_log</code>.
        </p>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Why approve now?"
          rows={4}
          className="w-full p-2 border rounded mb-2 text-sm"
        />
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button
            onClick={() => onClose(false)}
            disabled={mutation.isPending}
            className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={mutation.isPending}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
          >
            {mutation.isPending ? 'Activating...' : 'Approve & activate'}
          </button>
        </div>
      </div>
    </div>
  );
}
