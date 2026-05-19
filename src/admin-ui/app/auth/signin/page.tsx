'use client';

/**
 * P8.5 — Sign-in page.
 *
 * Post-Codex-review #101: the email-only stub was removed. The dev login token
 * is now a required field. In production builds, the magic-link provider is
 * unregistered server-side and signIn() returns "no providers" — see ./lib/auth.ts.
 */
import * as React from 'react';
import { signIn } from 'next-auth/react';

export default function SignInPage() {
  const [email, setEmail] = React.useState('');
  const [tenantId, setTenantId] = React.useState('');
  const [token, setToken] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
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
        // NextAuth obscures specific failure reasons (intentional — don't leak
        // whether the email exists, tenant exists, or token was wrong). The UI
        // shows a generic message.
        setError('Sign-in failed. Verify email, tenant, and dev token with your operator.');
      } else if (result?.ok) {
        window.location.href = '/inbox';
      } else {
        setError('Sign-in not available. Magic-link provider is disabled in this environment.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
      <form onSubmit={handleSubmit} className="bg-white p-8 rounded shadow w-96 space-y-4">
        <h1 className="text-2xl font-bold">Maia Admin</h1>
        <p className="text-sm text-gray-600">
          Dev sign-in. Requires email + tenant + dev token. Production uses OIDC/SAML (P10).
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
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 text-white p-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
