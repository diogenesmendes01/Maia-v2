'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import { PageHeader } from '../../../components/ui/page-header.js';
import { Stepper } from '../../../components/ui/stepper.js';
import { Button } from '../../../components/ui/button.js';
import { Card, CardHeader, CardBody } from '../../../components/ui/card.js';
import { Field, Input, Select, Textarea } from '../../../components/ui/field.js';
import { Alert, ErrorState } from '../../../components/ui/states.js';
import { Badge } from '../../../components/ui/badge.js';
import { IconArrowLeft } from '../../../components/ui/icons.js';
import {
  DEFAULT_PROFILE,
  IdentitySection,
  BehaviorSection,
  formToProfileBodyInput,
  validateIdentity,
  validateBehavior,
  type ProfileFormValue,
} from '../_components/profile-form.js';

const ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;
const STEPS = ['Identificação', 'Personalidade', 'Comportamento', 'Revisão'];

/** Suggest a slug from the display name (operator can always override). */
function slugify(nome: string): string {
  return nome
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export default function NewAgentPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const role = session?.user?.role ?? '';
  const sessionTenant = session?.user?.tenant_id ?? '';

  const [step, setStep] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  const [tenantId, setTenantId] = React.useState('');
  const effectiveTenant = tenantId || sessionTenant;
  const [id, setId] = React.useState('');
  const [idTouched, setIdTouched] = React.useState(false);
  const [nome, setNome] = React.useState('');
  const [agentStatus, setAgentStatus] = React.useState<'active' | 'suspended'>('active');
  const [profile, setProfile] = React.useState<ProfileFormValue>(DEFAULT_PROFILE);
  const [reason, setReason] = React.useState('');

  const tenantsQuery = trpc.tenants.list.useQuery(undefined, {
    enabled: role === 'founder',
  });
  const createMutation = trpc.agents.create.useMutation();

  const canManage = role === 'founder' || role === 'owner';
  if (!canManage) {
    return (
      <ErrorState message="A criação de agentes exige papel owner ou founder." />
    );
  }

  const validateStep = (s: number): string | null => {
    if (s === 0) {
      if (!effectiveTenant) return 'Selecione o tenant.';
      if (nome.trim().length === 0) return 'Dê um nome ao agente.';
      if (!ID_REGEX.test(id))
        return 'O identificador deve usar minúsculas, dígitos, “-” ou “_”, começando por letra ou dígito.';
      if (id.length > 64) return 'O identificador deve ter no máximo 64 caracteres.';
      return null;
    }
    if (s === 1) return validateIdentity(profile);
    if (s === 2) return validateBehavior(profile);
    if (s === 3) {
      if (reason.trim().length < 10)
        return 'Explique o motivo da criação (mínimo 10 caracteres) — isso entra na trilha de auditoria.';
      return null;
    }
    return null;
  };

  const next = () => {
    const err = validateStep(step);
    setError(err);
    if (!err) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const submit = async () => {
    const err = validateStep(3);
    setError(err);
    if (err) return;
    try {
      await createMutation.mutateAsync({
        tenantId: effectiveTenant,
        id,
        nome: nome.trim(),
        status: agentStatus,
        profile_body: formToProfileBodyInput(profile),
        proposed_reason: reason.trim(),
      });
      router.push(`/agents/${encodeURIComponent(id)}?created=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/agents"
        className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-800"
      >
        <IconArrowLeft size={14} />
        Voltar para Agentes
      </Link>

      <PageHeader
        title="Novo agente"
        description="O perfil inicial nasce como proposta (v1) e só entra em operação depois de aprovado — nenhum agente muda de comportamento sem governança."
      />

      <div className="mb-6">
        <Stepper steps={STEPS} current={step} />
      </div>

      {step === 0 && (
        <Card>
          <CardHeader
            title="Identificação"
            description="Nome de exibição e identificador técnico do agente."
          />
          <CardBody className="space-y-4">
            {role === 'founder' && (
              <Field label="Tenant" required>
                <Select
                  value={effectiveTenant}
                  onChange={(e) => setTenantId(e.target.value)}
                >
                  <option value="">Selecione…</option>
                  {(tenantsQuery.data?.items ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.nome} ({t.id})
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Nome" required hint="Como o agente aparece no console.">
              <Input
                value={nome}
                onChange={(e) => {
                  setNome(e.target.value);
                  if (!idTouched) setId(slugify(e.target.value));
                }}
                placeholder="Assistente Comercial"
                maxLength={200}
              />
            </Field>
            <Field
              label="Identificador (slug)"
              required
              hint="Imutável após a criação. Minúsculas, dígitos, “-” e “_”."
            >
              <Input
                value={id}
                onChange={(e) => {
                  setIdTouched(true);
                  setId(e.target.value);
                }}
                placeholder="assistente-comercial"
                className="font-mono"
                maxLength={64}
              />
            </Field>
            <Field label="Status inicial">
              <Select
                value={agentStatus}
                onChange={(e) => setAgentStatus(e.target.value as 'active' | 'suspended')}
              >
                <option value="active">Ativo</option>
                <option value="suspended">Suspenso</option>
              </Select>
            </Field>
          </CardBody>
        </Card>
      )}

      {step === 1 && <IdentitySection value={profile} onChange={setProfile} />}
      {step === 2 && <BehaviorSection value={profile} onChange={setProfile} />}

      {step === 3 && (
        <div className="space-y-4">
          <Card>
            <CardHeader title="Revisão" description="Confira antes de criar." />
            <CardBody>
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium text-zinc-500">Agente</dt>
                  <dd className="mt-0.5 text-zinc-900">
                    {nome} <span className="font-mono text-xs text-zinc-500">({id})</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-zinc-500">Tenant</dt>
                  <dd className="mt-0.5 font-mono text-xs text-zinc-900">
                    {effectiveTenant}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium text-zinc-500">Papel</dt>
                  <dd className="mt-0.5 text-zinc-900">{profile.role_descriptor}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-zinc-500">Voz</dt>
                  <dd className="mt-0.5 text-zinc-900">
                    {profile.tone} · {profile.formality} · {profile.verbosity}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-zinc-500">Idioma</dt>
                  <dd className="mt-0.5 font-mono text-xs text-zinc-900">
                    {profile.language}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium text-zinc-500">Prioridades</dt>
                  <dd className="mt-1 flex flex-wrap gap-1">
                    {profile.priorities.map((p) => (
                      <Badge key={p}>{p}</Badge>
                    ))}
                  </dd>
                </div>
                {profile.principles.length > 0 && (
                  <div className="sm:col-span-2">
                    <dt className="text-xs font-medium text-zinc-500">Princípios</dt>
                    <dd className="mt-1 flex flex-wrap gap-1">
                      {profile.principles.map((p) => (
                        <Badge key={p} tone="danger">
                          {p}
                        </Badge>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Motivo (auditado)"
              description="Registrado na trilha de auditoria junto com a proposta do perfil v1."
            />
            <CardBody>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Ex.: Seed inicial do agente para a divisão comercial."
                maxLength={2000}
              />
            </CardBody>
          </Card>

          <Alert tone="info">
            Ao criar, o perfil v1 fica com status <strong>proposto</strong>. Aprove-o
            na aba <strong>Versões</strong> do agente (ou na tela Identidades) para
            colocá-lo em operação.
          </Alert>
        </div>
      )}

      {error && (
        <div className="mt-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <Button
          variant="secondary"
          onClick={() => {
            setError(null);
            if (step === 0) router.push('/agents');
            else setStep((s) => s - 1);
          }}
          disabled={createMutation.isPending}
        >
          {step === 0 ? 'Cancelar' : 'Voltar'}
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={next}>Continuar</Button>
        ) : (
          <Button onClick={() => void submit()} loading={createMutation.isPending}>
            Criar agente
          </Button>
        )}
      </div>
    </div>
  );
}
