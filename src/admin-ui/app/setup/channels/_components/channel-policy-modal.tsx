'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';

interface Props {
  tenantId: string;
  agentId: string;
  channelId: string;
  channelLabel: string;
  onClose: () => void;
}

type SwitchBehavior = 'locked' | 'prefer_handoff' | 'free_with_trigger' | 'by_context';
type AnnounceMode = 'always' | 'affects_user' | 'never';

export default function ChannelPolicyModal({
  tenantId,
  agentId,
  channelId,
  channelLabel,
  onClose,
}: Props) {
  const utils = trpc.useUtils();
  const existingQuery = trpc.channelPolicies.getByChannel.useQuery({
    tenantId,
    agentId,
    channelId,
  });
  const rolesQuery = trpc.channelPolicies.listRoles.useQuery({
    tenantId,
    agentId,
  });
  const mutation = trpc.channelPolicies.upsert.useMutation();

  const [defaultRoleId, setDefaultRoleId] = React.useState('');
  const [switchBehavior, setSwitchBehavior] =
    React.useState<SwitchBehavior>('locked');
  const [announceMode, setAnnounceMode] = React.useState<AnnounceMode>(
    'affects_user',
  );
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  // Hydrate form once when the existing-policy query resolves.
  const hydratedRef = React.useRef(false);
  React.useEffect(() => {
    if (hydratedRef.current) return;
    if (existingQuery.data) {
      setDefaultRoleId(existingQuery.data.default_role_id);
      setSwitchBehavior(existingQuery.data.switch_behavior as SwitchBehavior);
      setAnnounceMode(existingQuery.data.announce_mode as AnnounceMode);
      hydratedRef.current = true;
    } else if (existingQuery.isSuccess && !existingQuery.data) {
      hydratedRef.current = true;
    }
  }, [existingQuery.data, existingQuery.isSuccess]);

  const handleSubmit = async () => {
    setError(null);
    if (!defaultRoleId) {
      setError('Pick a default role.');
      return;
    }
    if (comment.trim().length < 10) {
      setError('Comment must be at least 10 chars.');
      return;
    }
    try {
      await mutation.mutateAsync({
        tenantId,
        agentId,
        channel_id: channelId,
        default_role_id: defaultRoleId,
        switch_behavior: switchBehavior,
        announce_mode: announceMode,
        comment,
      });
      await utils.channelPolicies.getByChannel.invalidate({
        tenantId,
        agentId,
        channelId,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const isUpdate = existingQuery.data !== null && existingQuery.data !== undefined;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded shadow-lg w-[520px] max-w-full">
        <h2 className="text-lg font-bold mb-1">
          {isUpdate ? 'Edit' : 'Create'} channel policy
        </h2>
        <p className="text-xs text-gray-600 mb-3">
          Channel: <code>{channelLabel}</code>
        </p>

        {existingQuery.isLoading || rolesQuery.isLoading ? (
          <p>Loading…</p>
        ) : (
          <div className="space-y-3">
            <label className="block">
              <span className="text-sm font-medium">Default role</span>
              <select
                value={defaultRoleId}
                onChange={(e) => setDefaultRoleId(e.target.value)}
                className="w-full p-2 border rounded mt-1 text-sm"
              >
                <option value="">Pick role…</option>
                {(rolesQuery.data?.items ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.role_key} — {r.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Switch behavior</span>
              <select
                value={switchBehavior}
                onChange={(e) =>
                  setSwitchBehavior(e.target.value as SwitchBehavior)
                }
                className="w-full p-2 border rounded mt-1 text-sm"
              >
                <option value="locked">locked — role never switches</option>
                <option value="prefer_handoff">
                  prefer_handoff — handoff over switching
                </option>
                <option value="free_with_trigger">
                  free_with_trigger — switch on explicit trigger
                </option>
                <option value="by_context">
                  by_context — switch when context strongly suggests
                </option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Announce mode</span>
              <select
                value={announceMode}
                onChange={(e) => setAnnounceMode(e.target.value as AnnounceMode)}
                className="w-full p-2 border rounded mt-1 text-sm"
              >
                <option value="always">always</option>
                <option value="affects_user">affects_user</option>
                <option value="never">never</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">
                Reason (audited; min 10 chars)
              </span>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                className="w-full p-2 border rounded mt-1 text-sm"
              />
            </label>
          </div>
        )}

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
            disabled={mutation.isPending || existingQuery.isLoading}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {mutation.isPending
              ? 'Saving...'
              : isUpdate
                ? 'Update policy'
                : 'Create policy'}
          </button>
        </div>
      </div>
    </div>
  );
}
