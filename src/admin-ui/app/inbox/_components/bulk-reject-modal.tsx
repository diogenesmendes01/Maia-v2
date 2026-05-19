'use client';

import * as React from 'react';
import { trpc } from '../../../trpc/client.js';

interface Props {
  tenantId: string;
  ids: string[];
  onClose: () => void;
}

export default function BulkRejectModal({ tenantId, ids, onClose }: Props) {
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.inbox.bulkReject.useMutation();

  const handleSubmit = async () => {
    setError(null);
    if (comment.trim().length < 10) {
      setError('Comment must be at least 10 characters.');
      return;
    }
    try {
      const result = await mutation.mutateAsync({ tenantId, ids, comment });
      // Surface skipped ids if any
      if (result.skipped_ids.length > 0) {
        setError(
          `${result.rejected_count} rejected. ${result.skipped_ids.length} skipped (risk too high or locked).`,
        );
        // Auto-close after 2.5s
        setTimeout(onClose, 2500);
      } else {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded shadow-lg w-[480px] max-w-full">
        <h2 className="text-lg font-bold mb-2">Bulk reject {ids.length} proposals?</h2>
        <p className="text-sm text-gray-600 mb-3">
          Only risk=low + non-locked proposals will be rejected. Comment is required (min 10 chars)
          and recorded in the audit log.
        </p>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Why reject these proposals?"
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
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
          >
            {mutation.isPending ? 'Rejecting...' : 'Confirm reject'}
          </button>
        </div>
      </div>
    </div>
  );
}
