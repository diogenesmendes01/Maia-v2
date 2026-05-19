'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

export default function AuthErrorPage() {
  const params = useSearchParams();
  const error = params.get('error') ?? 'Unknown error';
  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
      <div className="bg-white p-8 rounded shadow w-96">
        <h1 className="text-xl font-bold text-red-600 mb-2">Auth error</h1>
        <p className="text-sm text-gray-700 mb-4">{error}</p>
        <Link href="/auth/signin" className="text-blue-600 hover:underline">
          Try again
        </Link>
      </div>
    </div>
  );
}
