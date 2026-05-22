'use client';

/**
 * Admin UI — LLM settings screen.
 *
 * Replaces the legacy Fastify `/dashboard/llm-settings` (removed by PR #176).
 *
 * What this is for:
 *   Incident-response surface (Anthropic outage, OpenRouter route flapping,
 *   model deprecation, mid-deploy regression). Founder picks the runtime
 *   `main` and `fast` model slugs from the OpenRouter tool-calling catalog;
 *   the next ReAct turn picks up the change (no restart). Every change is
 *   audited.
 *
 * Why founder-only:
 *   Model switch is high-blast-radius — touches every tenant's runtime LLM
 *   spend, latency, and (worst case) tool-calling compatibility. Routes
 *   for owners/compliance are explicitly out of scope.
 */

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';

export default function LlmSettingsPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? '';
  const isFounder = role === 'founder';

  const getQuery = trpc.llmSettings.get.useQuery(undefined, {
    enabled: isFounder,
  });
  const catalogQuery = trpc.llmSettings.catalog.useQuery(undefined, {
    enabled: isFounder,
  });

  const utils = trpc.useUtils();
  const mutation = trpc.llmSettings.update.useMutation({
    onSuccess: () => {
      // Refresh the "current" panel so the operator sees the new values
      // immediately, without a manual reload.
      void utils.llmSettings.get.invalidate();
    },
  });

  const [mainPick, setMainPick] = React.useState('');
  const [fastPick, setFastPick] = React.useState('');
  const [mainCustom, setMainCustom] = React.useState('');
  const [fastCustom, setFastCustom] = React.useState('');
  const [comment, setComment] = React.useState('');
  const [successAt, setSuccessAt] = React.useState<Date | null>(null);

  // Once the current values arrive, seed the dropdowns so the operator can
  // see what's currently in effect AND modify just one side without losing
  // the other. The seeding runs once per `getQuery.data` change.
  React.useEffect(() => {
    if (getQuery.data && mainPick === '' && fastPick === '') {
      setMainPick(getQuery.data.main);
      setFastPick(getQuery.data.fast);
    }
  }, [getQuery.data, mainPick, fastPick]);

  if (status === 'loading') {
    return <p>Loading session...</p>;
  }

  if (!isFounder) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">LLM Settings</h1>
        <p className="text-sm text-red-700">
          Changing the runtime LLM model requires the <code>founder</code>{' '}
          role (high blast-radius — affects every tenant's runtime calls).
          Your current role is <code>{role || '(none)'}</code>.
        </p>
      </div>
    );
  }

  // Custom (free-text) input beats the dropdown selection when set —
  // matches the legacy /dashboard/llm-settings behavior for freshly-published
  // model slugs not yet in the OpenRouter catalog snapshot.
  const effectiveMain =
    mainCustom.trim().length > 0 ? mainCustom.trim() : mainPick;
  const effectiveFast =
    fastCustom.trim().length > 0 ? fastCustom.trim() : fastPick;

  const hasChange =
    getQuery.data !== undefined &&
    (effectiveMain !== getQuery.data.main ||
      effectiveFast !== getQuery.data.fast);

  const commentOk = comment.trim().length >= 10;
  const canSubmit =
    !mutation.isPending && hasChange && commentOk && effectiveMain && effectiveFast;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuccessAt(null);
    try {
      const res = await mutation.mutateAsync({
        main: effectiveMain,
        fast: effectiveFast,
        comment: comment.trim(),
      });
      if (res.ok) {
        setSuccessAt(new Date(res.applied_at));
        setMainCustom('');
        setFastCustom('');
        setComment('');
        // PR #188 Codex round 1 [P2]: after a custom-slug submit, the dropdowns
        // used to retain the OLD picks (e.g. the env default the user never
        // touched). On a subsequent one-sided edit, the form would have
        // submitted the stale dropdown selection for the untouched side —
        // silently reverting the custom model the founder just set. Resync
        // both picks to what the mutation actually persisted (res.after, NOT
        // the refetch which races the invalidation above and would land
        // stale values into the picks again).
        setMainPick(res.after.main);
        setFastPick(res.after.fast);
      }
    } catch {
      // tRPC mutation error surfaces via mutation.error below — no action
      // needed here, but we catch to suppress the unhandled rejection.
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <header>
        <h1 className="text-2xl font-bold">LLM Settings</h1>
        <p className="text-sm text-gray-600">
          Switch the runtime LLM model used by the agent loop. The next ReAct
          turn picks up the change — no restart. Every change is recorded in{' '}
          <code>admin_audit_log</code> with the before / after snapshot and a
          required comment.
        </p>
      </header>

      {getQuery.isLoading ? (
        <p>Loading current settings...</p>
      ) : getQuery.error ? (
        <p className="text-red-600">Error: {getQuery.error.message}</p>
      ) : getQuery.data ? (
        <section className="border rounded p-4 bg-gray-50 space-y-2">
          <h2 className="font-semibold">Currently active</h2>
          <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-sm">
            <dt className="font-medium">Provider:</dt>
            <dd>
              <code>{getQuery.data.env.provider}</code>
            </dd>
            <dt className="font-medium">Main model:</dt>
            <dd>
              <code>{getQuery.data.main}</code>
              {getQuery.data.main === getQuery.data.env.main && (
                <span className="ml-2 text-xs text-gray-500">
                  (env default)
                </span>
              )}
            </dd>
            <dt className="font-medium">Fast model:</dt>
            <dd>
              <code>{getQuery.data.fast}</code>
              {getQuery.data.fast === getQuery.data.env.fast && (
                <span className="ml-2 text-xs text-gray-500">
                  (env default)
                </span>
              )}
            </dd>
            <dt className="font-medium">Env defaults:</dt>
            <dd className="text-xs text-gray-600">
              main=<code>{getQuery.data.env.main}</code>, fast=
              <code>{getQuery.data.env.fast}</code>
            </dd>
          </dl>
        </section>
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-4">
        <fieldset className="space-y-3 border rounded p-4">
          <legend className="px-2 font-semibold">New selection</legend>

          {catalogQuery.isLoading ? (
            <p className="text-sm text-gray-500">Loading model catalog...</p>
          ) : catalogQuery.error ? (
            <p className="text-sm text-yellow-700">
              Catalog unavailable: {catalogQuery.error.message}. Use the custom
              slug fields below.
            </p>
          ) : (
            <p className="text-xs text-gray-500">
              {catalogQuery.data?.items.length ?? 0} model(s) with tool-calling
              support (OpenRouter, cached 1h).
            </p>
          )}

          <div className="space-y-1">
            <label
              htmlFor="main-select"
              className="block text-sm font-medium"
            >
              Main model
            </label>
            <select
              id="main-select"
              value={mainPick}
              onChange={(e) => setMainPick(e.target.value)}
              aria-describedby="main-help"
              className="w-full border rounded p-2 text-sm"
              disabled={mutation.isPending}
            >
              {/* If the current pick isn't in the catalog, prepend it so
                  the dropdown stays consistent with what's stored. */}
              {mainPick &&
                !(catalogQuery.data?.items ?? []).some(
                  (m) => m.id === mainPick,
                ) && (
                  <option value={mainPick}>
                    {mainPick} (current, not in catalog)
                  </option>
                )}
              {(catalogQuery.data?.items ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — in ${m.pricing.prompt_per_million}/M, out $
                  {m.pricing.completion_per_million}/M
                </option>
              ))}
            </select>
            <p id="main-help" className="text-xs text-gray-500">
              Primary model used for every ReAct turn.
            </p>
          </div>

          <div className="space-y-1">
            <label
              htmlFor="fast-select"
              className="block text-sm font-medium"
            >
              Fast model (fallback)
            </label>
            <select
              id="fast-select"
              value={fastPick}
              onChange={(e) => setFastPick(e.target.value)}
              aria-describedby="fast-help"
              className="w-full border rounded p-2 text-sm"
              disabled={mutation.isPending}
            >
              {fastPick &&
                !(catalogQuery.data?.items ?? []).some(
                  (m) => m.id === fastPick,
                ) && (
                  <option value={fastPick}>
                    {fastPick} (current, not in catalog)
                  </option>
                )}
              {(catalogQuery.data?.items ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — in ${m.pricing.prompt_per_million}/M, out $
                  {m.pricing.completion_per_million}/M
                </option>
              ))}
            </select>
            <p id="fast-help" className="text-xs text-gray-500">
              Used for retry / fallback when main fails.
            </p>
          </div>

          <details className="text-sm">
            <summary className="cursor-pointer font-medium">
              Custom slug (advanced)
            </summary>
            <div className="mt-2 space-y-2 pl-4 border-l-2 border-gray-200">
              <p className="text-xs text-gray-500">
                Use this when a freshly-published slug isn't in the OpenRouter
                catalog snapshot yet. Free-text overrides the dropdown
                selection on the same row.
              </p>
              <div>
                <label
                  htmlFor="main-custom"
                  className="block text-xs font-medium"
                >
                  Main custom slug
                </label>
                <input
                  id="main-custom"
                  type="text"
                  maxLength={200}
                  value={mainCustom}
                  onChange={(e) => setMainCustom(e.target.value)}
                  placeholder="ex: anthropic/claude-opus-4.7"
                  className="w-full border rounded p-1 text-sm font-mono"
                  disabled={mutation.isPending}
                />
              </div>
              <div>
                <label
                  htmlFor="fast-custom"
                  className="block text-xs font-medium"
                >
                  Fast custom slug
                </label>
                <input
                  id="fast-custom"
                  type="text"
                  maxLength={200}
                  value={fastCustom}
                  onChange={(e) => setFastCustom(e.target.value)}
                  placeholder="ex: anthropic/claude-haiku-latest"
                  className="w-full border rounded p-1 text-sm font-mono"
                  disabled={mutation.isPending}
                />
              </div>
            </div>
          </details>
        </fieldset>

        <div className="space-y-1">
          <label htmlFor="comment" className="block text-sm font-medium">
            Reason for change <span className="text-red-600">*</span>
          </label>
          <textarea
            id="comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="ex: Anthropic outage at 14:30 UTC, switching main to openai/gpt-5 until upstream recovers."
            aria-describedby="comment-help"
            className="w-full border rounded p-2 text-sm"
            disabled={mutation.isPending}
          />
          <p id="comment-help" className="text-xs text-gray-500">
            Minimum 10 characters. Recorded in the audit row as
            <code>change_summary.comment</code>.
          </p>
        </div>

        {hasChange && (
          <div className="text-sm border rounded p-3 bg-blue-50 text-blue-900">
            <p className="font-medium">Pending change:</p>
            <ul className="list-disc list-inside mt-1">
              {getQuery.data && effectiveMain !== getQuery.data.main && (
                <li>
                  main: <code>{getQuery.data.main}</code> →{' '}
                  <code>{effectiveMain}</code>
                </li>
              )}
              {getQuery.data && effectiveFast !== getQuery.data.fast && (
                <li>
                  fast: <code>{getQuery.data.fast}</code> →{' '}
                  <code>{effectiveFast}</code>
                </li>
              )}
            </ul>
          </div>
        )}

        {mutation.error && (
          <p className="text-sm text-red-600">Error: {mutation.error.message}</p>
        )}

        {successAt && !mutation.error && (
          <p className="text-sm text-green-700">
            Applied at {successAt.toLocaleString()}. The next ReAct turn will
            use the new model. Audit row appended.
          </p>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {mutation.isPending ? 'Applying...' : 'Apply change'}
        </button>
      </form>
    </div>
  );
}
