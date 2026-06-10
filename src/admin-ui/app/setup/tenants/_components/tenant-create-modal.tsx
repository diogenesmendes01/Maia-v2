'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';
import { Modal } from '../../../../components/ui/modal.js';
import { Button } from '../../../../components/ui/button.js';
import { Field, Input } from '../../../../components/ui/field.js';
import { Alert } from '../../../../components/ui/states.js';

interface Props {
  onClose: () => void;
}

const ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

export default function TenantCreateModal({ onClose }: Props) {
  const [id, setId] = React.useState('');
  const [nome, setNome] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.tenants.create.useMutation();

  const handleSubmit = async () => {
    setError(null);
    if (!ID_REGEX.test(id)) {
      setError(
        'O ID deve ter apenas letras minúsculas/dígitos/_/- e começar com letra ou dígito.',
      );
      return;
    }
    if (id.length > 64) {
      setError('O ID deve ter no máximo 64 caracteres.');
      return;
    }
    if (nome.trim().length === 0) {
      setError('O nome é obrigatório.');
      return;
    }
    try {
      await mutation.mutateAsync({ id, nome, status: 'active' });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Novo tenant"
      description="O tenant é criado com status active e fica isolado dos demais."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => void handleSubmit()} loading={mutation.isPending}>
            Criar tenant
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="ID (slug)"
          required
          hint="Letras minúsculas/dígitos/_/-, começando com letra ou dígito."
        >
          <Input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="acme-corp"
            className="font-mono"
          />
        </Field>
        <Field label="Nome de exibição" required>
          <Input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="Acme Corp"
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}
