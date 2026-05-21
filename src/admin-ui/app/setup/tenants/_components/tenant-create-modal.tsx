'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';

interface Props {
  onClose: () => void;
}

const ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

export default function TenantCreateModal({ onClose }: Props) {
  const [id, setId] = React.useState('');
  const [nome, setNome] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.tenants.create.useMutation();

  const handleSubmit = async () => {
    setError(null);
    if (!ID_REGEX.test(id)) {
      setError(
        'ID must be lowercase letters/digits/_/- and start with alphanumeric.',
      );
      return;
    }
    if (id.length > 64) {
      setError('ID must be at most 64 chars.');
      return;
    }
    if (nome.trim().length === 0) {
      setError('Nome is required.');
      return;
    }
    try {
      await mutation.mutateAsync({ id, nome, status: 'active' });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded shadow-lg w-[480px] max-w-full">
        <h2 className="text-lg font-bold mb-3">New tenant</h2>
        <div className="space-y-3">
          <label className="block">
            <span className="text-sm font-medium">ID (slug)</span>
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="acme-corp"
              className="w-full p-2 border rounded mt-1 font-mono text-sm"
            />
            <span className="text-xs text-gray-500">
              lowercase letters/digits/_/-, starting alphanumeric.
            </span>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Display name</span>
            <input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Acme Corp"
              className="w-full p-2 border rounded mt-1 text-sm"
            />
          </label>
        </div>
        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
        <div className="flex gap-2 justify-end mt-4">
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
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {mutation.isPending ? 'Creating...' : 'Create tenant'}
          </button>
        </div>
      </div>
    </div>
  );
}
