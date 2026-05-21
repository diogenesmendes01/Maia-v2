'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import TenantCreateModal from './_components/tenant-create-modal.js';
import TenantStatusModal from './_components/tenant-status-modal.js';

export default function TenantsSetupPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? '';
  const [showCreate, setShowCreate] = React.useState(false);
  const [statusTarget, setStatusTarget] = React.useState<{
    id: string;
    nome: string;
    status: string;
  } | null>(null);

  const isFounder = role === 'founder';

  const listQuery = trpc.tenants.list.useQuery(undefined, { enabled: isFounder });

  if (status === 'loading') return <p>Loading session...</p>;

  if (!isFounder) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Tenants</h1>
        <p className="text-sm text-red-700">
          Tenant management requires the <code>founder</code> role. Your current
          role is <code>{role || '(none)'}</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold">Tenants</h1>
          <p className="text-sm text-gray-600">
            Provision new tenants and toggle status. Every change is audited in{' '}
            <code>admin_audit_log</code>.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          New tenant
        </button>
      </header>

      {listQuery.isLoading ? (
        <p>Loading tenants...</p>
      ) : listQuery.error ? (
        <p className="text-red-600">Error: {listQuery.error.message}</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-gray-100">
              <th className="text-left p-2 border-b">ID</th>
              <th className="text-left p-2 border-b">Nome</th>
              <th className="text-left p-2 border-b">Status</th>
              <th className="text-left p-2 border-b">Created</th>
              <th className="text-left p-2 border-b">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(listQuery.data?.items ?? []).map((t) => (
              <tr key={t.id} className="border-b hover:bg-gray-50">
                <td className="p-2 font-mono">{t.id}</td>
                <td className="p-2">{t.nome}</td>
                <td className="p-2">
                  <span
                    className={
                      t.status === 'active'
                        ? 'px-2 py-0.5 bg-green-100 text-green-800 rounded text-xs'
                        : 'px-2 py-0.5 bg-yellow-100 text-yellow-800 rounded text-xs'
                    }
                  >
                    {t.status}
                  </span>
                </td>
                <td className="p-2 text-gray-600">
                  {new Date(t.created_at).toLocaleString()}
                </td>
                <td className="p-2">
                  <button
                    onClick={() =>
                      setStatusTarget({ id: t.id, nome: t.nome, status: t.status })
                    }
                    className="text-blue-600 hover:underline"
                  >
                    Toggle status
                  </button>
                </td>
              </tr>
            ))}
            {(listQuery.data?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-gray-500">
                  No tenants yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {showCreate && (
        <TenantCreateModal
          onClose={() => {
            setShowCreate(false);
            void listQuery.refetch();
          }}
        />
      )}

      {statusTarget && (
        <TenantStatusModal
          target={statusTarget}
          onClose={() => {
            setStatusTarget(null);
            void listQuery.refetch();
          }}
        />
      )}
    </div>
  );
}
