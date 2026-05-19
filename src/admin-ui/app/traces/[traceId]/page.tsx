'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';

export default function TraceDetailPage({ params }: { params: { traceId: string } }) {
  const { data: session } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';
  const [showSnapshotModal, setShowSnapshotModal] = React.useState(false);

  const traceQuery = trpc.traces.getTrace.useQuery(
    { tenantId, traceId: params.traceId },
    { enabled: tenantId !== '' },
  );

  if (!tenantId) return <p>Loading session...</p>;
  if (traceQuery.isLoading) return <p>Loading trace...</p>;
  if (traceQuery.error) return <p className="text-red-600">{traceQuery.error.message}</p>;

  const trace = traceQuery.data!;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Trace {params.traceId.slice(0, 8)}</h1>
        <p className="text-sm text-gray-600">
          {trace.full_snapshot_available
            ? 'Snapshot grant active — un-redacted view enabled.'
            : 'Body redacted. Request a snapshot grant to view full body.'}
        </p>
      </header>

      <section className="bg-white border rounded p-4">
        <h2 className="font-semibold mb-2">PEP decisions</h2>
        {trace.pep_decisions.length === 0 ? (
          <p className="text-sm text-gray-500">No PEP decisions on this trace.</p>
        ) : (
          <ul className="text-sm space-y-1">
            {trace.pep_decisions.map((d) => (
              <li key={d.id}>
                <code>{d.decision}</code> — {d.reason}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-white border rounded p-4">
        <h2 className="font-semibold mb-2">Redacted packet</h2>
        <pre className="text-xs bg-gray-50 p-3 rounded overflow-auto max-h-96">
          {JSON.stringify(trace.redacted_packet ?? { note: 'Body not yet populated' }, null, 2)}
        </pre>
      </section>

      {!trace.full_snapshot_available && (
        <button
          onClick={() => setShowSnapshotModal(true)}
          className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700"
        >
          Request full snapshot
        </button>
      )}

      {showSnapshotModal && (
        <SnapshotRequestModal
          traceId={params.traceId}
          tenantId={tenantId}
          onClose={() => {
            setShowSnapshotModal(false);
            void traceQuery.refetch();
          }}
        />
      )}
    </div>
  );
}

function SnapshotRequestModal({
  traceId,
  tenantId,
  onClose,
}: {
  traceId: string;
  tenantId: string;
  onClose: () => void;
}) {
  const [reason, setReason] = React.useState('');
  const [category, setCategory] = React.useState<
    'debugging' | 'incident_response' | 'audit_review' | 'support'
  >('debugging');
  const [ttlHours, setTtlHours] = React.useState(24);
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.traces.requestFullSnapshot.useMutation();

  const handleSubmit = async () => {
    setError(null);
    if (reason.trim().length < 20) {
      setError('Reason must be at least 20 characters.');
      return;
    }
    try {
      await mutation.mutateAsync({ tenantId, traceId, reason, category, ttlHours });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded shadow-lg w-[480px]">
        <h2 className="text-lg font-bold mb-2">Request full snapshot</h2>
        <p className="text-sm text-gray-600 mb-3">
          TTL-bounded access to un-redacted trace body. Recorded in audit log.
        </p>
        <label className="block text-sm font-medium mb-1">Reason (min 20 chars)</label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className="w-full p-2 border rounded mb-2 text-sm"
        />
        <label className="block text-sm font-medium mb-1">Category</label>
        <select
          value={category}
          onChange={(e) =>
            setCategory(e.target.value as 'debugging' | 'incident_response' | 'audit_review' | 'support')
          }
          className="w-full p-2 border rounded mb-2 text-sm"
        >
          <option value="debugging">Debugging</option>
          <option value="incident_response">Incident response</option>
          <option value="audit_review">Audit review</option>
          <option value="support">Support</option>
        </select>
        <label className="block text-sm font-medium mb-1">TTL (hours, 1–72)</label>
        <input
          type="number"
          min={1}
          max={72}
          value={ttlHours}
          onChange={(e) => setTtlHours(Number(e.target.value))}
          className="w-full p-2 border rounded mb-2 text-sm"
        />
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 bg-gray-200 rounded">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={mutation.isPending}
            className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
          >
            {mutation.isPending ? 'Requesting...' : 'Request grant'}
          </button>
        </div>
      </div>
    </div>
  );
}
