/**
 * P8.5 — Client providers tree.
 *
 * round-2 fix: client pages call useSession() which requires SessionProvider
 * from next-auth/react to be an ancestor. Previously only TRPCProvider was
 * mounted; this wraps both so the full client tree has session context.
 *
 * This is a 'use client' component because SessionProvider is a React context
 * provider that must run in the browser. The RootLayout (server component)
 * renders it as a child — that pattern is safe in Next.js App Router.
 */
'use client';

import * as React from 'react';
import { SessionProvider } from 'next-auth/react';
import { TRPCProvider } from '../trpc/client-provider.js';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <TRPCProvider>{children}</TRPCProvider>
    </SessionProvider>
  );
}
