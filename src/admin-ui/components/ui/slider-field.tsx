'use client';

import * as React from 'react';

/**
 * Range input with a live numeric readout. Used for the cognitive-limit
 * knobs (inference depth, speculation ceiling, confidence floor) so the
 * operator manipulates a bounded control instead of typing raw floats.
 */
export function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  format = (v) => String(v),
  hint,
  disabled,
}: {
  label: React.ReactNode;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  hint?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-700">{label}</span>
        <span className="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-xs tabular-nums text-zinc-800">
          {format(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-200 accent-brand-600 disabled:cursor-not-allowed"
      />
      {hint && (
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">{hint}</p>
      )}
    </div>
  );
}
