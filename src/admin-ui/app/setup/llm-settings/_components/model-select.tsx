'use client';

import * as React from 'react';
import { Field, Select } from '../../../../components/ui/field.js';

export type CatalogModel = {
  id: string;
  name: string;
  pricing: { prompt_per_million: number; completion_per_million: number };
};

/**
 * Dropdown de modelo do catálogo OpenRouter (com preço por milhão de tokens).
 * Se o valor atual não está no catálogo, ele é prefixado como opção extra para
 * o dropdown continuar coerente com o que está persistido.
 */
export function ModelSelect({
  label,
  hint,
  value,
  onChange,
  items,
  disabled,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  items: CatalogModel[];
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="font-mono"
      >
        {value && !items.some((m) => m.id === value) && (
          <option value={value}>{value} (atual, fora do catálogo)</option>
        )}
        {items.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} — in ${m.pricing.prompt_per_million}/M, out $
            {m.pricing.completion_per_million}/M
          </option>
        ))}
      </Select>
    </Field>
  );
}
