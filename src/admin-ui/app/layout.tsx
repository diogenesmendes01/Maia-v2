import './../styles/globals.css';
import * as React from 'react';
import { auth } from '../lib/auth.js';
import { Providers } from './providers.js';
import { Shell } from '../components/layout/shell.js';

export const metadata = {
  title: 'Maia Console',
  description: 'Console de governança e configuração de agentes',
};

// Every route depends on the NextAuth session (the layout calls `auth()`,
// every page reads `useSession()`). Static prerendering would bake in an
// empty session — force request-time rendering for the whole app.
export const dynamic = 'force-dynamic';

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <html lang="pt-BR">
      <body>
        <Providers>
          {session ? (
            <Shell>{children}</Shell>
          ) : (
            <main className="flex min-h-screen items-center justify-center p-6">
              {children}
            </main>
          )}
        </Providers>
      </body>
    </html>
  );
}
