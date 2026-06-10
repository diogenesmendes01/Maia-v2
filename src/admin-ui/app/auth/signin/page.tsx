/**
 * Admin UI — página de entrada.
 *
 * Dois caminhos, conforme o que a configuração de auth do servidor registrou:
 *   - Botão SSO: visível quando o provider OIDC está configurado (qualquer
 *     ambiente com OIDC_ISSUER + OIDC_CLIENT_ID + OIDC_CLIENT_SECRET).
 *   - Formulário magic-link: visível quando o CredentialsProvider dev-only
 *     está habilitado (não-prod + FEATURE_ADMIN_UI_V1 + ALLOW_DEV_AUTH +
 *     ADMIN_UI_DEV_LOGIN_TOKEN).
 *
 * A descoberta acontece em tempo de request via `getProviders()` do NextAuth,
 * então a UI reflete o que o servidor de fato aceita.
 */
'use client';

import * as React from 'react';
import { signIn, getProviders } from 'next-auth/react';
import { Card, CardBody } from '../../../components/ui/card.js';
import { Button } from '../../../components/ui/button.js';
import { Field, Input } from '../../../components/ui/field.js';
import { Alert } from '../../../components/ui/states.js';

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
        setError(
          'Falha na entrada. Verifique e-mail, tenant e token dev com seu operador.',
        );
      } else if (result?.ok) {
        window.location.href = '/dashboard';
      } else {
        setError(
          'Entrada indisponível. O provider magic-link está desabilitado neste ambiente.',
        );
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
    <Card className="w-full max-w-sm">
      <CardBody className="space-y-4 px-6 py-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-white font-bold">
            M
          </span>
          <div>
            <p className="text-sm font-semibold text-zinc-900">Maia Console</p>
            <p className="text-xs text-zinc-500">Governança de agentes</p>
          </div>
        </div>

        <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
          Entrar no Maia Console
        </h1>

        {!providers ? (
          <p className="text-sm text-zinc-500">
            Carregando opções de entrada…
          </p>
        ) : !hasAnyProvider ? (
          <Alert tone="danger" title="Nenhum provider configurado">
            Nenhum provider de entrada está configurado neste servidor.
            Produção exige OIDC (defina{' '}
            <code className="font-mono">OIDC_ISSUER</code>,{' '}
            <code className="font-mono">OIDC_CLIENT_ID</code>,{' '}
            <code className="font-mono">OIDC_CLIENT_SECRET</code>,{' '}
            <code className="font-mono">OIDC_TENANT_SLUGS</code>).
            Desenvolvimento pode habilitar magic-link via{' '}
            <code className="font-mono">ALLOW_DEV_AUTH=true</code>.
          </Alert>
        ) : (
          <>
            {hasOidc && (
              <Button className="w-full" onClick={() => void handleSso()}>
                Entrar com SSO
              </Button>
            )}

            {hasOidc && hasMagicLink && (
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <span className="flex-1 border-t border-zinc-200" />
                <span>ou somente dev</span>
                <span className="flex-1 border-t border-zinc-200" />
              </div>
            )}

            {hasMagicLink && (
              <form onSubmit={handleMagicLink} className="space-y-3">
                <p className="text-xs text-zinc-500">
                  Entrada de desenvolvimento. Exige e-mail + tenant + token dev.
                </p>
                <Field label="E-mail">
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                </Field>
                <Field label="Tenant ID">
                  <Input
                    type="text"
                    value={tenantId}
                    onChange={(e) => setTenantId(e.target.value)}
                    required
                    autoComplete="off"
                    className="font-mono"
                  />
                </Field>
                <Field label="Token dev">
                  <Input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    required
                    autoComplete="current-password"
                    placeholder="ADMIN_UI_DEV_LOGIN_TOKEN"
                    className="font-mono"
                  />
                </Field>
                <Button
                  type="submit"
                  variant="secondary"
                  className="w-full"
                  loading={loading}
                >
                  Entrar (dev)
                </Button>
              </form>
            )}
          </>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </CardBody>
    </Card>
  );
}
