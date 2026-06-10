'use client';

/**
 * Admin UI — Modelos LLM (somente founder).
 *
 * Superfície de resposta a incidente (queda da Anthropic, rota do OpenRouter
 * instável, modelo descontinuado, regressão em deploy). O founder escolhe os
 * slugs `main` e `fast` do catálogo OpenRouter com tool-calling; o próximo
 * turno do ReAct aplica a mudança (sem restart). Tudo é auditado.
 *
 * Somente founder porque a troca de modelo tem alto raio de impacto — afeta o
 * gasto de LLM, a latência e (no pior caso) a compatibilidade de tool-calling
 * de todos os tenants.
 */

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import { PageHeader } from '../../../components/ui/page-header.js';
import { Button } from '../../../components/ui/button.js';
import { Card, CardHeader, CardBody } from '../../../components/ui/card.js';
import { Field, Input, Textarea } from '../../../components/ui/field.js';
import { ModelSelect } from './_components/model-select.js';
import {
  LoadingState,
  ErrorState,
  Alert,
} from '../../../components/ui/states.js';

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
      // Atualiza o painel "ativo agora" para o operador ver os novos valores
      // imediatamente, sem recarregar.
      void utils.llmSettings.get.invalidate();
    },
  });

  const [mainPick, setMainPick] = React.useState('');
  const [fastPick, setFastPick] = React.useState('');
  const [mainCustom, setMainCustom] = React.useState('');
  const [fastCustom, setFastCustom] = React.useState('');
  const [comment, setComment] = React.useState('');
  const [successAt, setSuccessAt] = React.useState<Date | null>(null);

  // Quando os valores atuais chegam, semeia os dropdowns para o operador ver
  // o que está em vigor E alterar só um lado sem perder o outro. Roda uma vez
  // por mudança de `getQuery.data`.
  React.useEffect(() => {
    if (getQuery.data && mainPick === '' && fastPick === '') {
      setMainPick(getQuery.data.main);
      setFastPick(getQuery.data.fast);
    }
  }, [getQuery.data, mainPick, fastPick]);

  if (status === 'loading') {
    return <LoadingState label="Carregando sessão…" />;
  }

  if (!isFounder) {
    return (
      <div>
        <PageHeader title="Modelos LLM" />
        <Alert tone="danger" title="Acesso restrito">
          Alterar o modelo LLM do runtime exige o papel{' '}
          <code className="font-mono">founder</code> (alto raio de impacto —
          afeta as chamadas de runtime de todos os tenants). Seu papel atual é{' '}
          <code className="font-mono">{role || '(nenhum)'}</code>.
        </Alert>
      </div>
    );
  }

  // O campo livre (slug custom) vence a seleção do dropdown quando preenchido
  // — espelha o comportamento do legado /dashboard/llm-settings para slugs
  // recém-publicados que ainda não estão no snapshot do catálogo OpenRouter.
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
      // Concorrência otimista: envia como expected_* os valores que o founder
      // OBSERVOU. O servidor compara contra os valores correntes travados
      // DENTRO da tx; em divergência o tRPC lança CONFLICT e o founder vê o
      // aviso para atualizar e tentar de novo.
      //
      // - source !== 'global' ('env' | 'legacy' | undefined) → não havia
      //   linha persistida; envia `null` ("não observei linha") para que o
      //   primeiro update de uma instalação nova aplique corretamente.
      // - source === 'global_mismatched' → existe linha em global_settings
      //   com provider diferente do LLM_PROVIDER ativo; envia a LINHA
      //   armazenada completa como expected_* para o subset-match aceitar e o
      //   update sobrescrever a linha divergente atomicamente, com o
      //   antes/depois real no log de auditoria.
      const pickExpected = (
        source: string | undefined,
        observedValue: string | undefined,
        stored: Record<string, unknown> | null | undefined,
      ): string | Record<string, unknown> | null => {
        if (source === 'global') return observedValue ?? null;
        if (source === 'global_mismatched') return stored ?? null;
        // 'env' | 'legacy' | undefined → sem linha para disputar.
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
        // Após um submit com slug custom, ressincroniza os dois picks com o
        // que a mutação de fato persistiu (res.after, NÃO o refetch — que
        // corre contra a invalidação acima e devolveria valores antigos),
        // para um próximo edit unilateral não reverter em silêncio o modelo
        // custom recém-aplicado.
        setMainPick(res.after.main);
        setFastPick(res.after.fast);
      }
    } catch {
      // O erro da mutação aparece via mutation.error abaixo — o catch só
      // suprime a unhandled rejection.
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Modelos LLM"
        description={
          <>
            Troque o modelo LLM usado pelo loop do agente. O próximo turno do
            ReAct aplica a mudança — sem restart. Toda alteração é registrada
            em <code className="font-mono">admin_audit_log</code> com o
            snapshot antes/depois e um comentário obrigatório.
          </>
        }
      />

      {getQuery.isLoading ? (
        <LoadingState label="Carregando configurações atuais…" />
      ) : getQuery.error ? (
        <ErrorState
          message={getQuery.error.message}
          onRetry={() => void getQuery.refetch()}
        />
      ) : getQuery.data ? (
        <>
          {/* Divergência de provider: existe linha persistida cujo provider
              não bate com o LLM_PROVIDER ativo. O runtime serve o default do
              env por segurança; salvar aqui sobrescreve a linha divergente
              atomicamente. Sem este aviso o operador veria o default do env e
              assumiria que a linha simplesmente não existe. */}
          {(getQuery.data.mainSource === 'global_mismatched' ||
            getQuery.data.fastSource === 'global_mismatched') && (
            <Alert
              tone="warning"
              title="Divergência de provider nas configurações persistidas"
            >
              <p>
                Uma linha persistida tem provider diferente do provider ativo
                (<code className="font-mono">{getQuery.data.env.provider}</code>
                ). O runtime está servindo o default do env por segurança.
                Salvar aqui sobrescreve a linha divergente com um valor
                compatível com o provider, atomicamente.
              </p>
              <ul className="mt-1 list-inside list-disc">
                {getQuery.data.mainSource === 'global_mismatched' && (
                  <li>
                    main: armazenado=
                    <code className="font-mono">
                      {JSON.stringify(getQuery.data.stored_main)}
                    </code>
                  </li>
                )}
                {getQuery.data.fastSource === 'global_mismatched' && (
                  <li>
                    fast: armazenado=
                    <code className="font-mono">
                      {JSON.stringify(getQuery.data.stored_fast)}
                    </code>
                  </li>
                )}
              </ul>
            </Alert>
          )}
          <Card>
            <CardHeader title="Ativo agora" />
            <CardBody>
              <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
                <dt className="font-medium text-zinc-600">Provider:</dt>
                <dd>
                  <code className="font-mono">{getQuery.data.env.provider}</code>
                </dd>
                <dt className="font-medium text-zinc-600">Modelo main:</dt>
                <dd>
                  <code className="font-mono">{getQuery.data.main}</code>
                  {getQuery.data.main === getQuery.data.env.main && (
                    <span className="ml-2 text-xs text-zinc-500">
                      (default do env)
                    </span>
                  )}
                </dd>
                <dt className="font-medium text-zinc-600">Modelo fast:</dt>
                <dd>
                  <code className="font-mono">{getQuery.data.fast}</code>
                  {getQuery.data.fast === getQuery.data.env.fast && (
                    <span className="ml-2 text-xs text-zinc-500">
                      (default do env)
                    </span>
                  )}
                </dd>
                <dt className="font-medium text-zinc-600">Defaults do env:</dt>
                <dd className="text-xs text-zinc-600">
                  main=<code className="font-mono">{getQuery.data.env.main}</code>,
                  fast=<code className="font-mono">{getQuery.data.env.fast}</code>
                </dd>
              </dl>
            </CardBody>
          </Card>
        </>
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-5">
        <Card>
          <CardHeader
            title="Nova seleção"
            description={
              catalogQuery.isLoading ? (
                'Carregando catálogo de modelos…'
              ) : catalogQuery.error ? (
                `Catálogo indisponível: ${catalogQuery.error.message}. Use os campos de slug custom abaixo.`
              ) : (
                <>
                  {catalogQuery.data?.items.length ?? 0} modelo(s) com suporte a
                  tool-calling (OpenRouter, cache de 1h).
                  {/* O catálogo é filtrado pelo LLM_PROVIDER ativo no
                      servidor. Com provider=anthropic só aparecem slugs
                      anthropic/* porque o runtime não chama slugs de outros
                      vendors com o provider ativo. */}
                  {catalogQuery.data?.provider &&
                    catalogQuery.data.provider !== 'openrouter' && (
                      <>
                        {' '}
                        Filtrado para provider=
                        <code className="font-mono">
                          {catalogQuery.data.provider}
                        </code>{' '}
                        — slugs de outros vendors ficam ocultos porque o
                        runtime não consegue chamá-los com o provider ativo.
                      </>
                    )}
                </>
              )
            }
          />
          <CardBody className="space-y-4">
            <ModelSelect
              label="Modelo main"
              hint="Modelo principal usado em todo turno do ReAct."
              value={mainPick}
              onChange={setMainPick}
              items={catalogQuery.data?.items ?? []}
              disabled={mutation.isPending}
            />

            <ModelSelect
              label="Modelo fast (fallback)"
              hint="Usado em retry / fallback quando o main falha."
              value={fastPick}
              onChange={setFastPick}
              items={catalogQuery.data?.items ?? []}
              disabled={mutation.isPending}
            />

            <details className="text-sm">
              <summary className="cursor-pointer text-xs font-medium text-zinc-600 hover:text-zinc-800">
                Slug custom (avançado)
              </summary>
              <div className="mt-3 space-y-3 border-l-2 border-zinc-200 pl-4">
                <p className="text-xs text-zinc-500">
                  Use quando um slug recém-publicado ainda não está no snapshot
                  do catálogo OpenRouter. O texto livre vence a seleção do
                  dropdown na mesma linha.
                </p>
                <Field label="Slug custom do main">
                  <Input
                    type="text"
                    maxLength={200}
                    value={mainCustom}
                    onChange={(e) => setMainCustom(e.target.value)}
                    placeholder="ex: anthropic/claude-opus-4.7"
                    className="font-mono"
                    disabled={mutation.isPending}
                  />
                </Field>
                <Field label="Slug custom do fast">
                  <Input
                    type="text"
                    maxLength={200}
                    value={fastCustom}
                    onChange={(e) => setFastCustom(e.target.value)}
                    placeholder="ex: anthropic/claude-haiku-latest"
                    className="font-mono"
                    disabled={mutation.isPending}
                  />
                </Field>
              </div>
            </details>
          </CardBody>
        </Card>

        <Field
          label="Motivo da mudança"
          required
          hint={
            <>
              Mínimo de 10 caracteres. Registrado na linha de auditoria como{' '}
              <code className="font-mono">change_summary.comment</code>.
            </>
          }
        >
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="ex: Queda da Anthropic às 14:30 UTC, trocando o main para openai/gpt-5 até o upstream se recuperar."
            disabled={mutation.isPending}
          />
        </Field>

        {hasChange && (
          <Alert tone="info" title="Mudança pendente">
            <ul className="list-inside list-disc">
              {getQuery.data && effectiveMain !== getQuery.data.main && (
                <li>
                  main: <code className="font-mono">{getQuery.data.main}</code>{' '}
                  → <code className="font-mono">{effectiveMain}</code>
                </li>
              )}
              {getQuery.data && effectiveFast !== getQuery.data.fast && (
                <li>
                  fast: <code className="font-mono">{getQuery.data.fast}</code>{' '}
                  → <code className="font-mono">{effectiveFast}</code>
                </li>
              )}
            </ul>
          </Alert>
        )}

        {mutation.error && (
          <Alert tone="danger" title={`Erro: ${mutation.error.message}`}>
            {/* O router devolve code='CONFLICT' quando outro founder alterou
                as configurações entre o carregamento e o submit. O botão de
                refresh aplica o novo estado sem recarregar a página. */}
            {mutation.error.data?.code === 'CONFLICT' && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-2"
                onClick={async () => {
                  // Sequencia o refetch ANTES de limpar os picks: o efeito de
                  // seed (que depende de `mainPick === '' && fastPick === ''`)
                  // precisa rodar contra o cache já atualizado — limpar antes
                  // faria o seed disparar com o snapshot antigo e o form
                  // ficaria preso no estado anterior.
                  await utils.llmSettings.get.refetch();
                  setMainCustom('');
                  setFastCustom('');
                  setMainPick('');
                  setFastPick('');
                }}
              >
                Atualizar estado atual e recomeçar
              </Button>
            )}
          </Alert>
        )}

        {successAt && !mutation.error && (
          <Alert tone="success">
            Aplicado em {successAt.toLocaleString('pt-BR')}. O próximo turno do
            ReAct usará o novo modelo. Linha de auditoria registrada.
          </Alert>
        )}

        <Button
          type="submit"
          variant="danger"
          disabled={!canSubmit}
          loading={mutation.isPending}
        >
          Aplicar mudança
        </Button>
      </form>
    </div>
  );
}
