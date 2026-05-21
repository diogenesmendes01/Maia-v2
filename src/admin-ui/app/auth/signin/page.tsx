/**
 * Admin UI — sign-in page.
 *
 * Two paths are exposed based on what the server-side auth config registered:
 *   - SSO button: visible when the OIDC provider is configured (any env where
 *     OIDC_ISSUER + OIDC_CLIENT_ID + OIDC_CLIENT_SECRET are set).
 *   - Magic-link form: visible when the dev-only CredentialsProvider is
 *     enabled (non-prod + FEATURE_ADMIN_UI_V1 + ALLOW_DEV_AUTH +
 *     ADMIN_UI_DEV_LOGIN_TOKEN).
 *
 * The discovery happens at request time via NextAuth's `getProviders()`, so
 * the UI matches what the server is actually willing to accept.
 *
 * Post-Codex-review #101: the email-only stub was removed. The dev login token
 * is now a required field.
 */
'use client';

import * as React from 'react';
import { signIn, getProviders } from 'next-auth/react';

interface ProviderInfo {
  id: string;
  name: string;
  type: string;
}

export default function SignInPage() {
  const [providers, setProviders] = React.useState<Record<string, ProviderInfo> | null>(
    null,
  );
  const [email, setEmail] = React.useState('');
  const [tenantId, setTenantId] = React.useState('');
  const [token, setToken] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    void getProviders().then((p) => setProviders((p as Record<string, ProviderInfo>) ?? {}));
  }, []);

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await signIn('magic-link', {
        redirect: false,
        email,
        tenantId,
        token,
      });
      if (result?.error) {
        setError('Sign-in failed. Verify email, tenant, and dev token with your operator.');
      } else if (result?.ok) {
        window.location.href = '/dashboard';
      } else {
        setError('Sign-in not available. Magic-link provider is disabled in this environment.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleSso = async () => {
    setError(null);
    await signIn('oidc', { callbackUrl: '/dashboard' });
  };

  const hasMagicLink = providers && 'magic-link' in providers;
  const hasOidc = providers && 'oidc' in providers;
  const hasAnyProvider = hasMagicLink || hasOidc;

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
      <div className="bg-white p-8 rounded shadow w-96 space-y-4">
        <h1 className="text-2xl font-bold">Maia Admin</h1>

        {!providers ? (
          <p className="text-sm text-gray-600">Loading available sign-in options...</p>
        ) : !hasAnyProvider ? (
          <p className="text-sm text-red-700">
            No sign-in providers are configured on this server. Production
            requires OIDC (set <code>OIDC_ISSUER</code>,{' '}
            <code>OIDC_CLIENT_ID</code>, <code>OIDC_CLIENT_SECRET</code>,{' '}
            <code>OIDC_TENANT_SLUGS</code>). Development can enable magic-link
            via <code>ALLOW_DEV_AUTH=true</code>.
          </p>
        ) : (
          <>
            {hasOidc && (
              <button
                onClick={handleSso}
                className="w-full bg-blue-600 text-white p-2 rounded hover:bg-blue-700"
              >
                Sign in with SSO
              </button>
            )}

            {hasOidc && hasMagicLink && (
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span className="flex-1 border-t" />
                <span>or dev only</span>
                <span className="flex-1 border-t" />
              </div>
            )}

            {hasMagicLink && (
              <form onSubmit={handleMagicLink} className="space-y-3">
                <p className="text-xs text-gray-600">
                  Dev sign-in. Requires email + tenant + dev token.
                </p>
                <label className="block">
                  <span className="text-sm font-medium">Email</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    className="w-full p-2 border rounded mt-1"
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium">Tenant ID</span>
                  <input
                    type="text"
                    value={tenantId}
                    onChange={(e) => setTenantId(e.target.value)}
                    required
                    autoComplete="off"
                    className="w-full p-2 border rounded mt-1"
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium">Dev token</span>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    required
                    autoComplete="current-password"
                    placeholder="ADMIN_UI_DEV_LOGIN_TOKEN"
                    className="w-full p-2 border rounded mt-1"
                  />
                </label>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-gray-700 text-white p-2 rounded hover:bg-gray-800 disabled:opacity-50"
                >
                  {loading ? 'Signing in...' : 'Sign in (dev)'}
                </button>
              </form>
            )}
          </>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
