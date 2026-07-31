'use client';

import * as React from 'react';
import { Button } from '../../../components/ui/button.js';
import { Card, CardBody, CardHeader } from '../../../components/ui/card.js';
import { Field, Input } from '../../../components/ui/field.js';
import { Alert, LoadingState } from '../../../components/ui/states.js';

/**
 * BOOTSTRAP GLOBAL (issue #519 §9) — a única página do console que existe
 * antes de haver alguém a autenticar.
 *
 * O que ela substitui: o `INSERT INTO app_users (...)` manual que o
 * `docs/admin-ui-deploy.md` documentava. Um INSERT à mão não tem precondição,
 * não expira, não deixa trilha e não pode ser revogado — e quem tem psql para
 * executá-lo tem psql para se dar `founder` em qualquer tenant, para sempre.
 *
 * ── Por que `fetch` cru em vez do cliente tRPC ────────────────────────────────
 * O cliente do console usa `httpBatchLink`, cujo caminho é a lista de
 * procedures separada por vírgula. O gate do middleware libera estas duas
 * procedures por IGUALDADE EXATA justamente para que um lote não vire desvio
 * (ver `PUBLIC_EXACT_PATHS`). Chamar sem lote mantém o caminho exato — e o
 * `fetch` é a forma mais direta de garantir isso, sem montar um segundo
 * provider de tRPC só para esta tela.
 *
 * O SEGREDO vai no CORPO do POST. Nunca em query string: uma URL é gravada
 * pelo histórico do navegador, pelo Referer e pelo access log do proxy.
 */

type Status =
  | { open: true; reason: 'ready' }
  | { open: false; reason: 'disabled' | 'already_bootstrapped' | 'no_credential' };

const STATUS_MESSAGE: Record<string, string> = {
  disabled:
    'O bootstrap global está desabilitado nesta instalação (MAIA_ONBOARDING_BOOTSTRAP=false).',
  already_bootstrapped:
    'Esta instalação já possui identidade administrativa. O bootstrap global está fechado definitivamente — entre pelo login.',
  no_credential:
    'Não há credencial de bootstrap viva. Emita uma com `npm run bootstrap:credential -- issue` e recarregue esta página.',
};

async function trpcQuery<T>(procedure: string): Promise<T> {
  const res = await fetch(`/api/trpc/${procedure}`, {
    method: 'GET',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
  });
  const body = (await res.json()) as { result?: { data?: T }; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'Falha na consulta.');
  return body.result?.data as T;
}

async function trpcMutation<T>(procedure: string, input: unknown): Promise<T> {
  const res = await fetch(`/api/trpc/${procedure}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Sem `batch=1`: o caminho precisa ser EXATO para passar pelo gate.
    body: JSON.stringify(input),
    cache: 'no-store',
  });
  const body = (await res.json()) as { result?: { data?: T }; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'Falha na operação.');
  return body.result?.data as T;
}

export default function BootstrapPage() {
  const [status, setStatus] = React.useState<Status | null>(null);
  const [statusError, setStatusError] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({
    secret: '',
    tenantId: '',
    tenantNome: '',
    adminEmail: '',
    adminName: '',
  });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  React.useEffect(() => {
    trpcQuery<Status>('onboarding.bootstrapStatus')
      .then(setStatus)
      .catch((e: unknown) => setStatusError(e instanceof Error ? e.message : String(e)));
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await trpcMutation('onboarding.bootstrapGlobal', {
        secret: form.secret.trim(),
        tenantId: form.tenantId.trim(),
        tenantNome: form.tenantNome.trim(),
        adminEmail: form.adminEmail.trim(),
        adminName: form.adminName.trim(),
      });
      // O segredo sai da memória da página assim que deixa de ser necessário.
      setForm((f) => ({ ...f, secret: '' }));
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const filled =
    form.secret.trim().length >= 32 &&
    form.tenantId.trim() !== '' &&
    form.tenantNome.trim() !== '' &&
    form.adminEmail.trim() !== '' &&
    form.adminName.trim() !== '';

  return (
    <div className="mx-auto max-w-xl p-8">
      <h1 className="mb-1 text-xl font-semibold tracking-tight text-zinc-900">
        Bootstrap da instalação
      </h1>
      <p className="mb-6 text-sm leading-relaxed text-zinc-500">
        Cria o primeiro tenant e o primeiro administrador. Acontece uma única vez: depois disso a
        porta fecha por construção, e todo provisionamento passa pelo wizard autenticado.
      </p>

      {done ? (
        <Alert tone="success" title="Instalação provisionada">
          O primeiro tenant e o primeiro administrador foram criados, e a credencial de bootstrap
          foi invalidada. Desligue <code className="font-mono">MAIA_ONBOARDING_BOOTSTRAP</code> e
          entre pelo login com o e-mail cadastrado no seu provedor de identidade.
        </Alert>
      ) : statusError ? (
        <Alert tone="danger" title="Não foi possível consultar o estado">
          {statusError}
        </Alert>
      ) : status === null ? (
        <LoadingState label="Verificando o estado da instalação…" />
      ) : !status.open ? (
        <Alert tone="warning" title="Bootstrap indisponível">
          {STATUS_MESSAGE[status.reason] ?? 'Bootstrap indisponível.'}
        </Alert>
      ) : (
        <Card>
          <CardHeader
            title="Credencial de uso único"
            description="Gerada por `npm run bootstrap:credential -- issue`. Ela é consumida nesta operação e não serve de novo."
          />
          <CardBody className="space-y-4">
            <Field
              label="Segredo de bootstrap"
              hint="Vai no corpo da requisição — nunca em URL, log ou auditoria."
              required
            >
              <Input
                type="password"
                autoComplete="off"
                value={form.secret}
                onChange={(e) => set('secret', e.target.value)}
              />
            </Field>
            <Field label="Identificador do primeiro tenant" hint="Minúsculas, dígitos, _ e -." required>
              <Input
                value={form.tenantId}
                onChange={(e) => set('tenantId', e.target.value)}
                placeholder="acme"
              />
            </Field>
            <Field label="Nome do tenant" required>
              <Input
                value={form.tenantNome}
                onChange={(e) => set('tenantNome', e.target.value)}
                placeholder="Acme Ltda"
              />
            </Field>
            <Field
              label="E-mail do administrador"
              hint="Precisa ser exatamente o e-mail que o seu provedor de identidade apresenta."
              required
            >
              <Input
                type="email"
                value={form.adminEmail}
                onChange={(e) => set('adminEmail', e.target.value)}
              />
            </Field>
            <Field label="Nome do administrador" required>
              <Input value={form.adminName} onChange={(e) => set('adminName', e.target.value)} />
            </Field>

            {error && <Alert tone="danger">{error}</Alert>}

            <Button disabled={!filled} loading={busy} onClick={() => void submit()}>
              Provisionar instalação
            </Button>

            <p className="text-2xs leading-relaxed text-zinc-400">
              Este administrador nasce com papel <code className="font-mono">founder</code> — é o
              único momento do sistema em que isso acontece. Os administradores dos tenants
              seguintes são criados pelo wizard, restritos ao próprio tenant.
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
