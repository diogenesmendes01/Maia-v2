import './../styles/globals.css';
import * as React from 'react';
import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { authOptions } from '../lib/auth.js';
import { TRPCProvider } from '../trpc/client-provider.js';

export const metadata = {
  title: 'Maia Admin',
  description: 'Governance & approval control plane (P8.5)',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  return (
    <html lang="pt-BR">
      <body>
        <TRPCProvider>
          {session ? (
            <>
              <nav className="bg-gray-900 text-white p-4 flex justify-between items-center">
                <div className="flex gap-6">
                  <Link href="/inbox" className="hover:underline font-medium">
                    Inbox
                  </Link>
                  <Link href="/versions" className="hover:underline">
                    Versions
                  </Link>
                  <Link href="/drift" className="hover:underline">
                    Drift
                  </Link>
                  <Link href="/traces" className="hover:underline">
                    Traces
                  </Link>
                </div>
                <div className="flex gap-4 items-center text-sm">
                  <span className="opacity-80">
                    {session.user?.email}
                    <span className="ml-2 px-2 py-0.5 bg-gray-700 rounded text-xs">
                      {session.user?.role}
                    </span>
                  </span>
                  <Link href="/api/auth/signout" className="underline hover:no-underline">
                    Logout
                  </Link>
                </div>
              </nav>
              <main className="p-6 max-w-7xl mx-auto">{children}</main>
            </>
          ) : (
            <main className="p-6">{children}</main>
          )}
        </TRPCProvider>
      </body>
    </html>
  );
}
