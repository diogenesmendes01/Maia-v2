'use client';

import * as React from 'react';

export default function DiffSoulBias({ body }: { body: unknown }) {
  return (
    <section className="bg-white border rounded p-4">
      <h2 className="font-semibold mb-2">Soul Bias Diff</h2>
      <p className="text-xs text-gray-500 mb-2">Soul bias dimension changes.</p>
      <pre className="text-xs bg-gray-50 p-3 rounded overflow-auto max-h-96">
        {JSON.stringify(body, null, 2)}
      </pre>
    </section>
  );
}
