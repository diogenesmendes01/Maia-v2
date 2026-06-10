'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { PageHeader } from '../../components/ui/page-header.js';
import {
  LoadingState,
  ErrorState,
  EmptyState,
  Alert,
} from '../../components/ui/states.js';
import { IconGitBranch } from '../../components/ui/icons.js';
import VersionsTable, { type VersionItem } from './_components/versions-table.js';
import RollbackModal from './_components/rollback-modal.js';

/** Papéis autorizados a reverter versões (espelha ctx.assertRole no router). */
const ROLLBACK_ROLES = ['owner', 'compliance_officer', 'founder'];

export default function VersionsPage() {
  const { data: session, status } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';
  const role = session?.user?.role ?? '';

  const [rollbackTarget, setRollbackTarget] = React.useState<{
    item: VersionItem;
    fromVersion: number;
  } | null>(null);

  const versionsQuery = trpc.versions.listVersions.useQuery(
    { tenantId, limit: 50 },
    { enabled: tenantId !== '' },
  );

  if (status === 'loading' || !tenantId) {
    return <LoadingState label="Carregando sessão…" />;
  }

  const items = versionsQuery.data?.items ?? [];
  const partiallyImplemented = versionsQuery.data?.partially_implemented ?? [];

  // Versão ativa por fonte ("sot_kind::sot_id") — é a origem de uma reversão.
  const activeBySot = new Map<string, number>();
  for (const v of items) {
    if (v.status === 'active') {
      const key = `${v.sot_kind}::${v.sot_id}`;
      activeBySot.set(key, Math.max(activeBySot.get(key) ?? 0, v.version));
    }
  }

  const canRollback = ROLLBACK_ROLES.includes(role);

  return (
    <div>
      <PageHeader
        title="Versões"
        description="Histórico de versões das fontes de verdade (source-of-truth); reverta quando necessário."
      />

      {partiallyImplemented.length > 0 && (
        <div className="mb-4">
          <Alert tone="info" title="Fontes parcialmente integradas">
            Listagem ainda não disponível para:{' '}
            <span className="font-mono">{partiallyImplemented.join(', ')}</span>
          </Alert>
        </div>
      )}

      {versionsQuery.isLoading ? (
        <LoadingState label="Carregando versões…" />
      ) : versionsQuery.error ? (
        <ErrorState
          message={versionsQuery.error.message}
          onRetry={() => void versionsQuery.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconGitBranch size={28} />}
          title="Nenhuma versão para exibir"
          description="Assim que objetos versionados (P8a–e e P4) existirem, eles aparecerão aqui."
        />
      ) : (
        <VersionsTable
          versions={items}
          canRollback={canRollback}
          activeVersionFor={(v) => activeBySot.get(`${v.sot_kind}::${v.sot_id}`)}
          onRollback={(item, fromVersion) => setRollbackTarget({ item, fromVersion })}
        />
      )}

      {rollbackTarget && (
        <RollbackModal
          tenantId={tenantId}
          item={rollbackTarget.item}
          fromVersion={rollbackTarget.fromVersion}
          onClose={() => setRollbackTarget(null)}
          onSuccess={() => {
            setRollbackTarget(null);
            void versionsQuery.refetch();
          }}
        />
      )}
    </div>
  );
}
