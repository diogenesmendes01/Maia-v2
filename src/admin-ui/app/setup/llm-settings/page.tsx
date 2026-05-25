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
      // Codex round 3 on PR #188 [P2]: optimistic concurrency. Pass the
      // values the founder OBSERVED (`getQuery.data.main` / `.fast`) as
      // expected_*. The server compares against the locked current values
      // INSIDE the tx; on mismatch tRPC throws CONFLICT and the founder
      // sees "Settings changed concurrently — refresh and try again."
      // After refresh, useQuery.invalidate() picks up the new state and
      // the founder re-decides.
      //
      // Codex round 4 on PR #188 [high]: pass `null` when the observed
      // source is NOT 'global' — i.e. the displayed value came from the
      // env default or the legacy agent_facts fallback, not a real
      // global_settings row. On a fresh install (zero rows) the UI used
      // to send the env default as expected_*, and the server's
      // compare-locked-against-{model: <env>} always failed because the
      // locked value is the placeholder JSON null. Now we explicitly
      // say "I didn't observe a row" and the server accepts that —
      // making the first-ever update apply correctly.
      //
      // Codex round 6 on PR #188 [high]: when source === 'global_mismatched'
      // a row exists in global_settings but its stored provider does
      // not match the active LLM_PROVIDER. The runtime served the env
      // default to avoid feeding the unsafe slug to the wrong
      // provider's client. We submit the FULL stored row as
      // expected_*: the repo's subset-match accepts it (the stored
      // row matches itself) and the update overwrites the mismatched
      // row atomically, recording the real before/after in the audit
      // log.
      const pickExpected = (
        source: string | undefined,
        observedValue: string | undefined,
        stored: Record<string, unknown> | null | undefined,
      ): string | Record<string, unknown> | null => {
        if (source === 'global') return observedValue ?? null;
        if (source === 'global_mismatched') return stored ?? null;
        // 'env' | 'legacy' | undefined → no row to race against.
        return null;
      };
      const expectedMain = pickExpected(
        getQuery.data?.mainSource,
        getQuery.data?.main,
        getQuery.data?.stored_main,
      );
      const expectedFast = pickExpected(
        getQuery.data?.fastSource,
        getQuery.data?.fast,
        getQuery.data?.stored_fast,
      );
      const res = await mutation.mutateAsync({
        main: effectiveMain,
        fast: effectiveFast,
        expected_main: expectedMain,
        expected_fast: expectedFast,
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
        <>
          {/* Codex round 6 on PR #188 [high]: surface the provider
              mismatch when a stored row's provider differs from the
              active LLM_PROVIDER. The runtime is currently serving
              the env default for safety; saving from this page will
              overwrite the mismatched row atomically (we send the
              full stored value as the expected token so the
              optimistic-conflict check accepts the override).
              Without this banner the operator sees the env default
              and might assume the row simply doesn't exist. */}
          {(getQuery.data.mainSource === 'global_mismatched' ||
            getQuery.data.fastSource === 'global_mismatched') && (
            <section className="border rounded p-4 bg-yellow-50 border-yellow-300 space-y-1 text-sm text-yellow-900">
              <p className="font-semibold">
                Provider mismatch detected on stored settings
              </p>
              <p>
                A persisted row's stored provider does not match the
                active provider (<code>{getQuery.data.env.provider}</code>).
                The runtime is serving the env default for safety. Saving
                here will overwrite the mismatched row with a
                provider-compatible value, atomically.
              </p>
              <ul className="list-disc list-inside text-xs">
                {getQuery.data.mainSource === 'global_mismatched' && (
                  <li>
                    main: stored=
                    <code>{JSON.stringify(getQuery.data.stored_main)}</code>
                  </li>
                )}
                {getQuery.data.fastSource === 'global_mismatched' && (
                  <li>
                    fast: stored=
                    <code>{JSON.stringify(getQuery.data.stored_fast)}</code>
                  </li>
                )}
              </ul>
            </section>
          )}
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
        </>
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
              {/* Codex round 3 on PR #188 [P2]: the catalog is filtered
                  by the active LLM_PROVIDER on the server. With
                  provider=anthropic, only anthropic/* slugs are shown
                  because the runtime can't call OpenRouter-style slugs
                  via AnthropicProvider. Surface the filter so the
                  operator understands why the list is shorter than
                  OpenRouter's full catalog. */}
              {catalogQuery.data?.provider &&
                catalogQuery.data.provider !== 'openrouter' && (
                  <>
                    {' '}
                    Filtered for provider=
                    <code>{catalogQuery.data.provider}</code> — slugs from
                    other vendors are hidden because the runtime can't call
                    them with the active provider.
                  </>
                )}
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
          <div className="text-sm text-red-600 space-y-2">
            <p>Error: {mutation.error.message}</p>
            {/* Codex round 3 on PR #188 [P2]: explicit CONFLICT hint —
                the router returns code='CONFLICT' when another founder
                updated the settings between page load and submit. Show
                a refresh button so the operator picks up the new state
                without having to reload the whole page. */}
            {mutation.error.data?.code === 'CONFLICT' && (
              <button
                type="button"
                onClick={async () => {
                  // Codex round 4 on PR #188 [P2]: sequence the refetch
                  // BEFORE clearing picks. Previously we called
                  // `invalidate()` and immediately cleared mainPick /
                  // fastPick, but the React-Query cache still served
                  // the stale `getQuery.data` until the refetch
                  // landed. The seeding effect (which depends on
                  // `mainPick === '' && fastPick === ''`) would fire
                  // against that stale snapshot, then the fresh
                  // response would land but the picks were no longer
                  // empty so the effect didn't re-run. The form
                  // remained on the old snapshot in spite of the
                  // promised refresh. Awaiting refetch BEFORE
                  // clearing forces the cache to hold the fresh data
                  // when the seeding effect runs.
                  await utils.llmSettings.get.refetch();
                  setMainCustom('');
                  setFastCustom('');
                  setMainPick('');
                  setFastPick('');
                }}
                className="bg-yellow-600 text-white px-3 py-1 rounded text-xs"
              >
                Refresh current state and start over
              </button>
            )}
          </div>
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
