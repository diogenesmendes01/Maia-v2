'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Card, CardBody } from '../../../components/ui/card.js';
import { Alert } from '../../../components/ui/states.js';

export default function AuthErrorPage() {
  const params = useSearchParams();
  // Código de erro técnico do NextAuth — exibido como veio, sem tradução.
  const error = params.get('error') ?? 'Unknown error';
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
          Erro de autenticação
        </h1>

        <Alert tone="danger">
          <code className="font-mono">{error}</code>
        </Alert>

        <Link
          href="/auth/signin"
          className="inline-block text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline"
        >
          Tentar novamente
        </Link>
      </CardBody>
    </Card>
  );
}
