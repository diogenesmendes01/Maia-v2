'use client';

/**
 * Admin UI — Skills Management screen (Phase 2: READ ONLY).
 *
 * Lists/views the `skills` table (P9a Skill Registry) for the selected agent,
 * filterable by status, with a detail drawer that pretty-prints the full
 * declarative contract and a "Versions" list. Founders may switch tenant via a
 * selector; every other role is pinned to their own tenant (the router's
 * resolveTenantId also enforces this server-side).
 *
 * The table consumes a SUMMARY projection (no large JSONB) from skills.list;
 * the detail drawer fetches the full contract per-row via skills.getById
 * (review PR #209 findings 2 & 5).
 *
 * Phase 3 will add propose/activate/deprecate/rollback. There are intentionally
 * NO create / edit / action buttons here.
 *
 * Server boundary: this page imports NOTHING from backend modules. It consumes
 * the serialized JSON from the `trpc.skills.*` queries only — the repo (and its
 * DB imports) and the env `config` stay on the server.
 */

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';

type SkillStatus = 'active' | 'proposed' | 'deprecated' | 'rolled_back';

const STATUS_TABS: SkillStatus[] = ['active', 'proposed', 'deprecated', 'rolled_back'];

const STATUS_LABEL: Record<SkillStatus, string> = {
  active: 'Active',
  proposed: 'Proposed',
  deprecated: 'Deprecated',
  rolled_back: 'Rolled back',
};

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  proposed: 'bg-blue-100 text-blue-800',
  deprecated: 'bg-gray-200 text-gray-600',
  rolled_back: 'bg-red-100 text-red-800',
};

// SUMMARY shape returned by skills.list (review PR #209 finding 2): only the
// table columns, NO large JSONB. Kept local so the page stays free of backend
// imports. timestamps arrive as ISO strings.
type SkillSummary = {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  skill_descriptor: string;
  category: string;
  execution_mode: string;
  version: number;
  status: string;
  activated_at: string | null;
  created_at: string;
};

// Full contract returned by skills.getById (and skills.listVersions) — mirror
// of SkillRow (src/db/schema.ts:1967). jsonb columns arrive as plain JSON.
type SkillRow = SkillSummary & {
  goal: string;
  when_to_use: string;
  procedure: unknown;
  constraints: unknown;
  input_schema: unknown;
  output_schema: unknown;
  allowed_tools: string[];
  policy_descriptors: string[];
  success_criteria: unknown;
  failure_modes: unknown;
  runtime_hints: unknown;
  proposed_by: string;
  proposed_reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
  deprecated_at: string | null;
  rolled_back_at: string | null;
  rollback_reason: string | null;
};

function fmtDate(v: string | null): string {
  if (!v) return '—';
  return new Date(v).toLocaleString();
}

function Badge({ label, className }: { label: string; className: string }) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

export default function SkillsPage() {
  const { data: session, status: sessionStatus } = useSession();
  const role = session?.user?.role ?? '';
  const sessionTenant = session?.user?.tenant_id ?? '';

  // FIX 4 (review PR #209): founders can inspect other tenants via a selector;
  // every other role stays pinned to their own tenant. Mirrors the setup pages.
  const [tenantId, setTenantId] = React.useState(sessionTenant);
  React.useEffect(() => {
    if (sessionTenant && !tenantId) setTenantId(sessionTenant);
  }, [sessionTenant, tenantId]);

  const [agentId, setAgentId] = React.useState('');
  const [tab, setTab] = React.useState<SkillStatus>('active');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const tenantsQuery = trpc.tenants.list.useQuery(undefined, {
    enabled: role === 'founder',
  });

  const agentsQuery = trpc.agents.list.useQuery(
    { tenantId },
    { enabled: tenantId !== '' },
  );

  const flagQuery = trpc.skills.runtimeFlag.useQuery();

  const listQuery = trpc.skills.list.useQuery(
    { tenantId, agentId, status: tab },
    { enabled: tenantId !== '' && agentId !== '' },
  );

  if (sessionStatus === 'loading') return <p>Loading session...</p>;

  const skills = (listQuery.data?.items ?? []) as SkillSummary[];
  // FIX 1 (review PR #209): this only reflects THIS admin-ui's own config.
  const adminUiFlagOff = flagQuery.data
    ? flagQuery.data.adminUiSkillRegistryEnabled === false
    : false;

  // Reset agent + selection whenever the founder switches tenant — agents and
  // skills are tenant-scoped, so a stale agentId/selectedId would be wrong.
  const onTenantChange = (next: string) => {
    setTenantId(next);
    setAgentId('');
    setSelectedId(null);
  };

  const TabButton = ({ id }: { id: SkillStatus }) => (
    <button
      onClick={() => setTab(id)}
      className={`px-3 py-1 text-sm rounded ${
        tab === id
          ? 'bg-blue-600 text-white'
          : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
      }`}
    >
      {STATUS_LABEL[id]}
    </button>
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Skills</h1>
        <p className="text-sm text-gray-600">
          Read-only view of the Skill Registry (P9a) for the selected agent:
          versioned, tenant/agent-scoped declarative contracts. Lifecycle
          actions (propose / activate / deprecate / rollback) ship in a later
          phase.
        </p>
      </header>

      {adminUiFlagOff && (
        <div className="border border-amber-300 bg-amber-50 text-amber-900 rounded p-3 text-sm">
          This admin-ui sees{' '}
          <code className="font-medium">FEATURE_SKILL_REGISTRY_V1</code> ={' '}
          <strong>off</strong>. Skills are managed here, but execution depends on{' '}
          <strong>maia-app</strong>&apos;s own config (a separate container) —
          verify the flag there. This banner reflects only this admin-ui&apos;s
          environment, not maia-app&apos;s runtime state.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium">Tenant:</span>
        {role === 'founder' ? (
          <select
            value={tenantId}
            onChange={(e) => onTenantChange(e.target.value)}
            className="border rounded p-1"
          >
            <option value="">Select…</option>
            {(tenantsQuery.data?.items ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} ({t.nome})
              </option>
            ))}
          </select>
        ) : (
          <code className="px-2 py-0.5 bg-gray-100 rounded">{sessionTenant}</code>
        )}
        <span className="font-medium ml-2">Agent:</span>
        <select
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value);
            setSelectedId(null);
          }}
          className="border rounded p-1"
          disabled={!tenantId}
        >
          <option value="">Select…</option>
          {(agentsQuery.data?.items ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}
            </option>
          ))}
        </select>
        <div className="flex gap-2 ml-4">
          {STATUS_TABS.map((s) => (
            <TabButton key={s} id={s} />
          ))}
        </div>
      </div>

      {!agentId ? (
        <p className="text-gray-500 text-sm">Pick an agent to see its skills.</p>
      ) : listQuery.isLoading ? (
        <p>Loading skills...</p>
      ) : listQuery.error ? (
        <p className="text-red-600">Error: {listQuery.error.message}</p>
      ) : skills.length === 0 ? (
        <p className="text-gray-500 text-sm">
          No {STATUS_LABEL[tab].toLowerCase()} skills for this agent.
        </p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-gray-100">
              <th className="text-left p-2 border-b">Descriptor</th>
              <th className="text-left p-2 border-b">Category</th>
              <th className="text-left p-2 border-b">Execution mode</th>
              <th className="text-left p-2 border-b">Version</th>
              <th className="text-left p-2 border-b">Status</th>
              <th className="text-left p-2 border-b">Activated</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => (
              <tr
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className="border-b hover:bg-gray-50 cursor-pointer"
              >
                <td className="p-2">
                  <code>{s.skill_descriptor}</code>
                </td>
                <td className="p-2">{s.category}</td>
                <td className="p-2">{s.execution_mode}</td>
                <td className="p-2">v{s.version}</td>
                <td className="p-2">
                  <Badge
                    label={s.status}
                    className={STATUS_BADGE[s.status] ?? 'bg-gray-100 text-gray-700'}
                  />
                </td>
                <td className="p-2">{fmtDate(s.activated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedId && (
        <SkillDetailDrawer
          id={selectedId}
          tenantId={tenantId}
          agentId={agentId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="bg-gray-50 border rounded p-2 text-xs overflow-auto max-h-72">
      {JSON.stringify(value ?? null, null, 2)}
    </pre>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      {children}
    </div>
  );
}

function TagList({ items, empty }: { items: string[]; empty: string }) {
  if (!items || items.length === 0) {
    return <p className="text-xs text-gray-400">{empty}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((t) => (
        <code key={t} className="px-2 py-0.5 rounded bg-gray-100 text-xs">
          {t}
        </code>
      ))}
    </div>
  );
}

function SkillDetailDrawer({
  id,
  tenantId,
  agentId,
  onClose,
}: {
  id: string;
  tenantId: string;
  agentId: string;
  onClose: () => void;
}) {
  const detailQuery = trpc.skills.getById.useQuery({ id, tenantId, agentId });
  const skill = (detailQuery.data?.item ?? null) as SkillRow | null;

  // FIX 3 (review PR #209): scope version history to the SELECTED row's own
  // agent_id (null = tenant-wide), NOT the page's agent filter, so an
  // agent-scoped skill and a tenant-wide one sharing a descriptor don't blend.
  const versionsQuery = trpc.skills.listVersions.useQuery(
    {
      descriptor: skill?.skill_descriptor ?? '',
      tenantId,
      agentId: skill ? skill.agent_id : agentId,
    },
    { enabled: skill != null },
  );
  const versions = (versionsQuery.data?.items ?? []) as SkillRow[];

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="relative z-50 w-full max-w-2xl h-full overflow-y-auto bg-white shadow-xl p-6 space-y-5">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-bold">Skill detail</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-800 text-sm"
            aria-label="Close"
          >
            Close ✕
          </button>
        </div>

        {detailQuery.isLoading ? (
          <p>Loading skill...</p>
        ) : detailQuery.error ? (
          <p className="text-red-600">Error: {detailQuery.error.message}</p>
        ) : !skill ? (
          <p className="text-gray-500 text-sm">Skill not found or not visible.</p>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-semibold">{skill.skill_descriptor}</code>
                <Badge label={`v${skill.version}`} className="bg-gray-100 text-gray-700" />
                <Badge
                  label={skill.status}
                  className={STATUS_BADGE[skill.status] ?? 'bg-gray-100 text-gray-700'}
                />
                <Badge label={skill.category} className="bg-gray-100 text-gray-700" />
                <Badge label={skill.execution_mode} className="bg-gray-100 text-gray-700" />
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600">
                <div>
                  <dt className="inline font-medium">Agent: </dt>
                  <dd className="inline">{skill.agent_id ?? 'tenant-wide'}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Proposed by: </dt>
                  <dd className="inline">{skill.proposed_by}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Approved by: </dt>
                  <dd className="inline">{skill.approved_by ?? '—'}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Activated: </dt>
                  <dd className="inline">{fmtDate(skill.activated_at)}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Deprecated: </dt>
                  <dd className="inline">{fmtDate(skill.deprecated_at)}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Rolled back: </dt>
                  <dd className="inline">{fmtDate(skill.rolled_back_at)}</dd>
                </div>
              </dl>
            </div>

            <Section title="Goal">
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{skill.goal}</p>
            </Section>

            <Section title="When to use">
              <p className="text-sm text-gray-800 whitespace-pre-wrap">
                {skill.when_to_use}
              </p>
            </Section>

            {/* FIX 5 (review PR #209): procedure is part of the full contract
                and was previously omitted — render it. */}
            <Section title="Procedure">
              <JsonBlock value={skill.procedure} />
            </Section>

            <Section title="Allowed tools">
              <TagList items={skill.allowed_tools} empty="None (no tool access)." />
            </Section>

            <Section title="Policy descriptors">
              <TagList items={skill.policy_descriptors} empty="None." />
            </Section>

            {/* FIX 5 (review PR #209): constraints is part of the full
                contract and was previously omitted — render it. */}
            <Section title="Constraints">
              <JsonBlock value={skill.constraints} />
            </Section>

            <Section title="Input schema">
              <JsonBlock value={skill.input_schema} />
            </Section>

            <Section title="Output schema">
              <JsonBlock value={skill.output_schema} />
            </Section>

            <Section title="Runtime hints">
              <JsonBlock value={skill.runtime_hints} />
            </Section>

            <Section title="Success criteria">
              <JsonBlock value={skill.success_criteria} />
            </Section>

            <Section title="Failure modes">
              <JsonBlock value={skill.failure_modes} />
            </Section>

            {skill.proposed_reason && (
              <Section title="Proposed reason">
                <p className="text-sm text-gray-800 whitespace-pre-wrap">
                  {skill.proposed_reason}
                </p>
              </Section>
            )}

            {skill.rollback_reason && (
              <Section title="Rollback reason">
                <p className="text-sm text-gray-800 whitespace-pre-wrap">
                  {skill.rollback_reason}
                </p>
              </Section>
            )}

            <Section title="Versions">
              {versionsQuery.isLoading ? (
                <p className="text-xs text-gray-500">Loading versions...</p>
              ) : versionsQuery.error ? (
                <p className="text-xs text-red-600">
                  Error: {versionsQuery.error.message}
                </p>
              ) : versions.length === 0 ? (
                <p className="text-xs text-gray-400">No versions found.</p>
              ) : (
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="text-left p-1.5 border-b">Version</th>
                      <th className="text-left p-1.5 border-b">Status</th>
                      <th className="text-left p-1.5 border-b">Activated</th>
                      <th className="text-left p-1.5 border-b">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr
                        key={v.id}
                        className={`border-b ${v.id === skill.id ? 'bg-blue-50' : ''}`}
                      >
                        <td className="p-1.5">v{v.version}</td>
                        <td className="p-1.5">
                          <Badge
                            label={v.status}
                            className={
                              STATUS_BADGE[v.status] ?? 'bg-gray-100 text-gray-700'
                            }
                          />
                        </td>
                        <td className="p-1.5">{fmtDate(v.activated_at)}</td>
                        <td className="p-1.5">{fmtDate(v.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          </>
        )}
      </aside>
    </div>
  );
}
