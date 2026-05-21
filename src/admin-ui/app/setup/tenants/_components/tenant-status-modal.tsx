'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';

interface Props {
  target: { id: string; nome: string; status: string };
  onClose: () => void;
}

export default function TenantStatusModal({ target, onClose }: Props) {
  const nextStatus = target.status === 'active' ? 'suspended' : 'active';
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.tenants.updateStatus.useMutation();

  const handleSubmit = async () => {
    setError(null);
    if (comment.trim().length < 10) {
      setError('Comment must be at least 10 characters.');
      return;
    }
    try {
      await mutation.mutateAsync({ id: target.id, status: nextStatus, comment });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded shadow-lg w-[480px] max-w-full">
        <h2 className="text-lg font-bold mb-2">
          {nextStatus === 'suspended' ? 'Suspend' : 'Reactivate'} {target.id}?
        </h2>
        <p className="text-sm text-gray-600 mb-3">
          Tenant <code>{target.id}</code> ({target.nome}) is currently{' '}
          <strong>{target.status}</strong>. Changing to{' '}
          <strong>{nextStatus}</strong> will be recorded in the audit log.
        </p>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Why this status change?"
          rows={4}
          className="w-full p-2 border rounded mb-2 text-sm"
        />
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={mutation.isPending}
            className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={mutation.isPending}
            className={`px-4 py-2 rounded text-white disabled:opacity-50 ${
              nextStatus === 'suspended'
                ? 'bg-yellow-600 hover:bg-yellow-700'
                : 'bg-green-600 hover:bg-green-700'
            }`}
          >
            {mutation.isPending
              ? 'Updating...'
              : nextStatus === 'suspended'
                ? 'Suspend'
                : 'Reactivate'}
          </button>
        </div>
      </div>
    </div>
  );
}
