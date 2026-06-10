'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import TenantCreateModal from './_components/tenant-create-modal.js';
import TenantStatusModal from './_components/tenant-status-modal.js';
import { PageHeader } from '../../../components/ui/page-header.js';
import { Button } from '../../../components/ui/button.js';
import { StatusBadge } from '../../../components/ui/badge.js';
import {
  TableShell,
  Table,
  THead,
  Th,
  Tr,
  Td,
} from '../../../components/ui/table.js';
import {
  LoadingState,
  ErrorState,
  EmptyState,
  Alert,
} from '../../../components/ui/states.js';
import { IconUsers, IconPlus } from '../../../components/ui/icons.js';

/**
 * Setup → Tenants (somente founder). Provisiona novos tenants e alterna o
 * status; toda mudança é auditada em `admin_audit_log`.
 */
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

  if (status === 'loading') return <LoadingState label="Carregando sessão…" />;

  if (!isFounder) {
    return (
      <div>
        <PageHeader title="Tenants" />
        <Alert tone="danger" title="Acesso restrito">
          A gestão de tenants exige o papel{' '}
          <code className="font-mono">founder</code>. Seu papel atual é{' '}
          <code className="font-mono">{role || '(nenhum)'}</code>.
        </Alert>
      </div>
    );
  }

  const tenants = listQuery.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Tenants"
        description={
          <>
            Provisione novos tenants e alterne o status. Toda mudança é
            auditada em <code className="font-mono">admin_audit_log</code>.
          </>
        }
        actions={
          <Button onClick={() => setShowCreate(true)}>
            <IconPlus size={15} />
            Novo tenant
          </Button>
        }
      />

      {listQuery.isLoading ? (
        <LoadingState label="Carregando tenants…" />
      ) : listQuery.error ? (
        <ErrorState
          message={listQuery.error.message}
          onRetry={() => void listQuery.refetch()}
        />
      ) : tenants.length === 0 ? (
        <EmptyState
          icon={<IconUsers size={36} />}
          title="Nenhum tenant ainda"
          action={
            <Button onClick={() => setShowCreate(true)}>
              <IconPlus size={15} />
              Criar o primeiro tenant
            </Button>
          }
        />
      ) : (
        <TableShell>
          <Table>
            <THead>
              <Th>ID</Th>
              <Th>Nome</Th>
              <Th>Status</Th>
              <Th>Criado em</Th>
              <Th>Ações</Th>
            </THead>
            <tbody>
              {tenants.map((t) => (
                <Tr key={t.id}>
                  <Td className="font-mono text-xs">{t.id}</Td>
                  <Td>{t.nome}</Td>
                  <Td>
                    <StatusBadge status={t.status} />
                  </Td>
                  <Td className="text-xs text-zinc-500">
                    {new Date(t.created_at).toLocaleString('pt-BR')}
                  </Td>
                  <Td>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setStatusTarget({ id: t.id, nome: t.nome, status: t.status })
                      }
                    >
                      Alterar status
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableShell>
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
