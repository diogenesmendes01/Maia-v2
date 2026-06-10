'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { Badge } from '../../components/ui/badge.js';
import { Field, Input, Select } from '../../components/ui/field.js';
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from '../../components/ui/states.js';
import {
  TableShell,
  Table,
  THead,
  Th,
  Tr,
  Td,
} from '../../components/ui/table.js';
import { IconShield } from '../../components/ui/icons.js';

/**
 * Trilha de auditoria (issue #463). Leitura de `admin_audit_log` — toda
 * mutação de governança escreve aqui na MESMA transação da decisão, então
 * esta tela é o registro forense do console. Somente leitura por design.
 */
export default function AuditPage() {
  const { data: session, status } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';

  const [actorId, setActorId] = React.useState('');
  const [resourceType, setResourceType] = React.useState('');
  const [limit, setLimit] = React.useState(100);

  const auditQuery = trpc.audit.listAuditEntries.useQuery(
    {
      tenantId,
      actorId: actorId.trim() || undefined,
      resourceType: resourceType.trim() || undefined,
      limit,
    },
    { enabled: tenantId !== '' },
  );

  if (status === 'loading') return <LoadingState label="Carregando sessão…" />;

  const items = auditQuery.data?.items ?? [];

  // Tipos de recurso distintos da página atual — viram filtro rápido.
  const resourceTypes = Array.from(
    new Set(items.map((e) => e.resource_type)),
  ).sort();

  return (
    <div>
      <PageHeader
        title="Auditoria"
        description="Registro forense de toda decisão de governança: quem fez, o quê, sobre qual recurso e quando. As entradas são gravadas na mesma transação da mutação — não há decisão sem rastro."
      />

      <div className="mb-5 flex flex-wrap items-end gap-3">
        <Field label="Ator (e-mail/id)" className="w-56">
          <Input
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
            placeholder="filtrar por ator…"
          />
        </Field>
        <Field label="Tipo de recurso" className="w-56">
          <Select
            value={resourceType}
            onChange={(e) => setResourceType(e.target.value)}
          >
            <option value="">Todos</option>
            {resourceTypes.map((rt) => (
              <option key={rt} value={rt}>
                {rt}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Limite" className="w-28">
          <Select
            value={String(limit)}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            {[50, 100, 250, 500].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {auditQuery.isLoading ? (
        <LoadingState label="Carregando auditoria…" />
      ) : auditQuery.error ? (
        <ErrorState
          message={auditQuery.error.message}
          onRetry={() => void auditQuery.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconShield size={36} />}
          title="Nenhuma entrada de auditoria"
          description="As entradas aparecem aqui assim que decisões de governança forem tomadas neste tenant."
        />
      ) : (
        <TableShell>
          <Table>
            <THead>
              <Th>Quando</Th>
              <Th>Ator</Th>
              <Th>Ação</Th>
              <Th>Recurso</Th>
              <Th>Resumo</Th>
            </THead>
            <tbody>
              {items.map((e) => (
                <Tr key={e.id}>
                  <Td className="whitespace-nowrap text-zinc-600">
                    {new Date(e.created_at).toLocaleString('pt-BR')}
                  </Td>
                  <Td>
                    <span className="font-mono text-xs">{e.actor_id}</span>
                    <Badge tone="neutral" className="ml-1.5">
                      {e.actor_role}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="font-mono text-xs font-medium text-zinc-800">
                      {e.action}
                    </span>
                  </Td>
                  <Td>
                    <span className="font-mono text-xs text-zinc-600">
                      {e.resource_type}
                      {e.resource_id ? `/${e.resource_id}` : ''}
                    </span>
                  </Td>
                  <Td className="max-w-md">
                    {e.change_summary ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-brand-600 hover:underline">
                          ver detalhes
                        </summary>
                        <pre className="scroll-thin mt-1 max-h-48 overflow-auto rounded-lg bg-zinc-950 p-3 text-2xs text-zinc-100">
                          {JSON.stringify(e.change_summary, null, 2)}
                        </pre>
                      </details>
                    ) : (
                      <span className="text-xs text-zinc-400">—</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableShell>
      )}
    </div>
  );
}
